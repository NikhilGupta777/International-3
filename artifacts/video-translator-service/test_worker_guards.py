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
        self.assertIn("HeyGen-quality", prompt)
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

    def test_transcribe_routes_to_gemini_at_or_below_17_minutes_and_assembly_after(self):
        calls = []
        old_gemini = getattr(self.worker, "transcribe_gemini", None)
        old_assembly = getattr(self.worker, "transcribe_assemblyai", None)
        old_cutoff = getattr(self.worker, "GEMINI_TRANSCRIBE_MAX_SECONDS", None)
        try:
            self.worker.GEMINI_TRANSCRIBE_MAX_SECONDS = 1020.0
            self.worker.transcribe_gemini = lambda path, duration: calls.append(("gemini", duration)) or [
                {"id": 1, "start": 0.0, "end": 1.0, "text": "hi", "words": [{"word": "hi", "start": 0.0, "end": 1.0}]}
            ]
            self.worker.transcribe_assemblyai = lambda path: calls.append(("assemblyai", None)) or [
                {"id": 1, "start": 0.0, "end": 1.0, "text": "long", "words": [{"word": "long", "start": 0.0, "end": 1.0}]}
            ]

            self.worker.transcribe(Path("short.wav"), 1020.0)
            self.worker.transcribe(Path("long.wav"), 1020.1)

            self.assertEqual(calls, [("gemini", 1020.0), ("assemblyai", None)])
        finally:
            if old_gemini is not None:
                self.worker.transcribe_gemini = old_gemini
            if old_assembly is not None:
                self.worker.transcribe_assemblyai = old_assembly
            if old_cutoff is not None:
                self.worker.GEMINI_TRANSCRIBE_MAX_SECONDS = old_cutoff


if __name__ == "__main__":
    unittest.main()
