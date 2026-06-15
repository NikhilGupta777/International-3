import importlib
import math
import os
from pathlib import Path
import sys
import types
import unittest


def import_worker():
    os.environ.setdefault("JOB_ID", "unit-test")
    os.environ.setdefault("S3_BUCKET", "unit-test-bucket")
    os.environ.setdefault("S3_INPUT_KEY", "translator-jobs/unit-test/input.mp4")
    os.environ.setdefault("DYNAMODB_TABLE", "unit-test-table")
    os.environ.setdefault("AWS_EC2_METADATA_DISABLED", "true")
    os.environ.setdefault("AWS_DEFAULT_REGION", "us-east-1")

    if "boto3" not in sys.modules:
        class DummyTable:
            def update_item(self, **kwargs):
                return None

        class DummyDynamoDb:
            def Table(self, name):
                return DummyTable()

        boto3 = types.ModuleType("boto3")
        boto3.client = lambda *args, **kwargs: object()
        boto3.resource = lambda *args, **kwargs: DummyDynamoDb()
        sys.modules["boto3"] = boto3

    return importlib.import_module("worker")


class WorkerGuardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_translation_response_accepts_wrapped_list_and_normalises_ids(self):
        parsed = self.worker._normalise_translation_response(
            {"translations": [{"id": "7", "translated_text": "hello"}]}
        )

        self.assertEqual(parsed[0]["id"], 7)

    def test_translation_response_rejects_invalid_shape(self):
        with self.assertRaisesRegex(RuntimeError, "invalid JSON shape|instead of a translation list"):
            self.worker._normalise_translation_response({"unexpected": "value"})

    def test_speaking_rate_is_clamped_and_non_finite_safe(self):
        self.assertEqual(self.worker._safe_speaking_rate("bad"), 1.0)
        self.assertEqual(self.worker._safe_speaking_rate(math.inf), 1.0)
        self.assertEqual(self.worker._safe_speaking_rate(0.1), 0.8)   # widened from 0.9 (P3-4)
        self.assertEqual(self.worker._safe_speaking_rate(9), 1.3)     # widened from 1.2 (P3-4)


class GeminiTranscriptionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_gemini_transcription_prompt_contains_audio_aware_segmentation_rules(self):
        prompt = self.worker.build_gemini_transcription_prompt(
            source_lang="Hindi",
            target_lang="English",
            duration_seconds=75.0,
            multi_speaker=True,
        )

        self.assertIn("Do not translate", prompt)
        self.assertIn("broadcast-quality", prompt)
        self.assertNotIn("HeyGen", prompt)
        self.assertIn("Do not split just because the text is long", prompt)
        self.assertIn("meaningful 1-2 second pause", prompt)
        self.assertIn("Output only JSON", prompt)

    def test_normalize_gemini_transcript_payload_repairs_segments_for_worker_contract(self):
        payload = {
            "segments": [
                {
                    "speaker": "Speaker A",
                    "start": "2.0",
                    "end": "4.0",
                    "text": "Speaker A: second segment",
                },
                {
                    "speaker": "A",
                    "start": "0",
                    "end": "2.05",
                    "text": "first segment",
                    "words": [
                        {"word": "first", "start": 0.0, "end": 0.6},
                        {"word": "segment", "start": 0.7, "end": 1.5},
                    ],
                },
                {"start": 9, "end": 9, "text": "bad"},
            ]
        }

        segments = self.worker.normalize_gemini_transcript_payload(payload, duration_seconds=10.0)

        self.assertEqual(len(segments), 2)
        self.assertEqual([s["id"] for s in segments], [1, 2])
        self.assertEqual(segments[0]["speaker"], "SPEAKER_A")
        self.assertEqual(segments[1]["speaker"], "SPEAKER_A")
        self.assertEqual(segments[1]["text"], "second segment")
        self.assertAlmostEqual(segments[0]["end"], segments[1]["start"], places=3)
        self.assertTrue(segments[1]["words"])
        self.assertGreater(segments[1]["words"][-1]["end"], segments[1]["words"][0]["start"])

    def test_normalize_defaults_missing_speaker_to_speaker_a(self):
        payload = {"segments": [{"start": 0.0, "end": 1.5, "text": "no speaker field"}]}
        segments = self.worker.normalize_gemini_transcript_payload(payload, duration_seconds=10.0)
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["speaker"], "SPEAKER_A")
        # Regression: a numeric 0.0 start must be kept, not dropped as falsy.
        self.assertEqual(segments[0]["start"], 0.0)

    def test_transcribe_routes_short_to_single_gemini_and_long_to_chunked(self):
        calls = []
        old_single = self.worker.transcribe_gemini
        old_chunked = self.worker.transcribe_gemini_chunked
        old_window = self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS
        try:
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = 600.0
            seg = [{"id": 1, "start": 0.0, "end": 1.0, "text": "hi", "words": [{"word": "hi", "start": 0.0, "end": 1.0}]}]
            self.worker.transcribe_gemini = lambda path, duration=None: calls.append(("single", duration)) or seg
            self.worker.transcribe_gemini_chunked = lambda path, duration: calls.append(("chunked", duration)) or seg

            self.worker.transcribe(Path("short.wav"), 600.0)    # at the window → single
            self.worker.transcribe(Path("long.wav"), 600.1)     # over the window → chunked

            self.assertEqual(calls, [("single", 600.0), ("chunked", 600.1)])
        finally:
            self.worker.transcribe_gemini = old_single
            self.worker.transcribe_gemini_chunked = old_chunked
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = old_window

    def test_transcribe_gemini_chunked_offsets_and_stitches_timestamps(self):
        # Each chunk transcribes [0, len] in its own local time; stitching must add the
        # chunk's start offset so the final timeline is continuous and re-ordered.
        old_single = self.worker.transcribe_gemini
        old_ffmpeg = self.worker.run_ffmpeg
        old_window = self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS
        try:
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = 10.0
            self.worker.run_ffmpeg = lambda *a, **k: None  # don't actually cut audio
            self.worker.transcribe_gemini = lambda path, length: [
                {"id": 1, "start": 0.0, "end": min(4.0, length), "text": "a",
                 "words": [{"word": "a", "start": 0.0, "end": min(4.0, length)}], "speaker": "SPEAKER_A"},
            ]
            out = self.worker.transcribe_gemini_chunked(Path("long.wav"), 25.0)
            # 25s / 10s window → 3 chunks at offsets 0, 10, 20.
            self.assertEqual(len(out), 3)
            self.assertEqual([round(s["start"], 1) for s in out], [0.0, 10.0, 20.0])
            self.assertEqual([s["id"] for s in out], [1, 2, 3])
            self.assertTrue(all(s["words"] for s in out))
        finally:
            self.worker.transcribe_gemini = old_single
            self.worker.run_ffmpeg = old_ffmpeg
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = old_window

    def test_transcribe_gemini_chunked_skips_silent_chunk(self):
        # A chunk that is pure silence/music raises "no usable speech" — chunked mode must
        # skip it and keep the others, not fail the whole job.
        old_single = self.worker.transcribe_gemini
        old_ffmpeg = self.worker.run_ffmpeg
        old_window = self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS
        try:
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = 10.0
            self.worker.run_ffmpeg = lambda *a, **k: None
            state = {"n": 0}

            def fake(path, length):
                state["n"] += 1
                if state["n"] == 2:
                    raise RuntimeError("Gemini transcription returned no usable speech segments")
                return [{"id": 1, "start": 0.0, "end": 3.0, "text": "x",
                         "words": [{"word": "x", "start": 0.0, "end": 3.0}], "speaker": "SPEAKER_A"}]

            self.worker.transcribe_gemini = fake
            out = self.worker.transcribe_gemini_chunked(Path("v.wav"), 25.0)  # 3 chunks, middle silent
            self.assertEqual(len(out), 2)
            self.assertEqual([round(s["start"], 1) for s in out], [0.0, 20.0])
        finally:
            self.worker.transcribe_gemini = old_single
            self.worker.run_ffmpeg = old_ffmpeg
            self.worker.GEMINI_TRANSCRIBE_CHUNK_SECONDS = old_window

    def test_transcribe_gemini_retries_in_repair_mode_on_truncation(self):
        # First call returns a truncated result (covers far less than duration); the
        # truncation guard must retry in repair mode and keep the fuller result.
        attempts = []
        old_once = self.worker._transcribe_gemini_once

        def fake_once(path, duration, repair=False):
            attempts.append(repair)
            if repair:
                return [{"id": 1, "start": 0.0, "end": 95.0, "text": "full",
                         "words": [{"word": "full", "start": 0.0, "end": 95.0}], "speaker": "SPEAKER_A"}]
            return [{"id": 1, "start": 0.0, "end": 10.0, "text": "short",
                     "words": [{"word": "short", "start": 0.0, "end": 10.0}], "speaker": "SPEAKER_A"}]

        try:
            self.worker._transcribe_gemini_once = fake_once
            out = self.worker.transcribe_gemini(Path("a.wav"), 100.0)
            self.assertEqual(attempts, [False, True])     # retried once in repair mode
            self.assertEqual(out[-1]["end"], 95.0)        # kept the fuller result
        finally:
            self.worker._transcribe_gemini_once = old_once


class CosyVoiceWarmupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_warmup_runs_once_and_sets_flag(self):
        # The CUDA warmup must run exactly one dummy inference and be idempotent, so the
        # background preload can warm kernels and the clone stage then skips it.
        old_flag = self.worker._COSYVOICE_WARMED
        old_ref = self.worker._get_warmup_reference
        calls = []

        class FakeModel:
            def inference_zero_shot(self, tts_text, prompt_text, ref):
                calls.append(ref)
                yield {"tts_speech": None}

        try:
            self.worker._COSYVOICE_WARMED = False
            self.worker._get_warmup_reference = lambda: Path("warmup.wav")

            self.worker.warmup_cosyvoice_model(FakeModel())
            self.assertTrue(self.worker._COSYVOICE_WARMED)
            self.assertEqual(len(calls), 1)

            # Already warmed → no-op (no second inference).
            self.worker.warmup_cosyvoice_model(FakeModel())
            self.assertEqual(len(calls), 1)
        finally:
            self.worker._COSYVOICE_WARMED = old_flag
            self.worker._get_warmup_reference = old_ref

    def test_warmup_with_no_model_is_safe_noop(self):
        old_flag = self.worker._COSYVOICE_WARMED
        try:
            self.worker._COSYVOICE_WARMED = False
            self.worker.warmup_cosyvoice_model(None)   # must not raise
            self.assertFalse(self.worker._COSYVOICE_WARMED)
        finally:
            self.worker._COSYVOICE_WARMED = old_flag


if __name__ == "__main__":
    unittest.main()
