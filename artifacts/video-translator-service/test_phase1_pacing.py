"""
Phase 1 pacing-primitives smoke tests.

These are pure-function unit tests on the helpers introduced by the
Phase 1 audit fix.  They do NOT call CosyVoice, ffmpeg, or AssemblyAI.
"""
import math
import unittest

from test_worker_guards import import_worker


class PacingPrimitivesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_chars_per_second_for_target_lookup_and_default(self):
        # Hindi/Devanagari is on the slower side
        self.worker.TARGET_LANG_CODE = "hi"
        self.assertEqual(self.worker.chars_per_second_for_target(), 13.5)
        # Spanish is on the fast side
        self.worker.TARGET_LANG_CODE = "es"
        self.assertEqual(self.worker.chars_per_second_for_target(), 17.5)
        # Unknown code falls through to DEFAULT
        self.worker.TARGET_LANG_CODE = "xx"
        self.assertEqual(
            self.worker.chars_per_second_for_target(),
            self.worker.DEFAULT_CHARS_PER_SEC,
        )

    def test_predict_segment_speech_seconds_grows_with_text_length(self):
        d_short = self.worker.predict_segment_speech_seconds("Hello.", 1.0, 16.0)
        d_long  = self.worker.predict_segment_speech_seconds(
            "Hello there, this is a much longer line.", 1.0, 16.0,
        )
        self.assertGreater(d_long, d_short)
        self.assertGreater(d_short, 0.0)

    def test_predict_segment_speech_seconds_inverse_to_speaking_rate(self):
        d_normal = self.worker.predict_segment_speech_seconds("hello world hello world", 1.0, 16.0)
        d_fast   = self.worker.predict_segment_speech_seconds("hello world hello world", 1.5, 16.0)
        self.assertGreater(d_normal, d_fast)

    def test_predict_segment_speech_seconds_zero_for_empty(self):
        self.assertEqual(self.worker.predict_segment_speech_seconds("", 1.0, 16.0), 0.0)
        self.assertEqual(self.worker.predict_segment_speech_seconds("    ", 1.0, 16.0), 0.0)

    def test_compute_target_speech_seconds_uses_speech_duration_when_present(self):
        seg = {"start": 0.0, "end": 5.0, "speech_duration": 3.2}
        target = self.worker.compute_target_speech_seconds(seg)
        # Speech duration 3.2 is less than slot - safety_pad (4.9), so wins.
        self.assertAlmostEqual(target, 3.2, places=2)

    def test_compute_target_speech_seconds_caps_at_slot_minus_pad(self):
        seg = {"start": 0.0, "end": 5.0, "speech_duration": 99.0}
        target = self.worker.compute_target_speech_seconds(seg)
        # Should never exceed slot - safety_pad (4.9 with 0.10 pad).
        self.assertLessEqual(target, 5.0 - self.worker.TARGET_SLOT_SAFETY_PAD_SECONDS + 1e-6)

    def test_compute_target_speech_seconds_floor(self):
        seg = {"start": 0.0, "end": 0.20}
        target = self.worker.compute_target_speech_seconds(seg)
        self.assertGreaterEqual(target, self.worker.TARGET_SLOT_MIN_SECONDS)

    def test_segment_speech_duration_prefers_words(self):
        seg = {
            "start": 0.0,
            "end": 5.0,
            "words": [
                {"word": "hi", "start": 1.0, "end": 1.4},
                {"word": "there", "start": 2.0, "end": 2.6},
            ],
        }
        # Words span: 2.6 - 1.0 = 1.6 — speech inside a 5 s slot.
        self.assertAlmostEqual(
            self.worker._segment_speech_duration(seg), 1.6, places=2,
        )

    def test_segment_speech_duration_falls_back_to_slot(self):
        seg = {"start": 0.0, "end": 3.5}
        self.assertAlmostEqual(
            self.worker._segment_speech_duration(seg), 3.5, places=2,
        )

    def test_merge_segments_for_dubbing_emits_speech_duration(self):
        # Two same-speaker segments separated by a 1 s pause.  After merge,
        # speech_duration should equal the sum of source-spoken time, NOT
        # the merged slot (which includes the pause).
        segs = [
            {
                "id": 0, "start": 0.0, "end": 1.0,
                "text": "hello", "speaker": "SPEAKER_A",
                "words": [{"word": "hello", "start": 0.0, "end": 0.8}],
            },
            {
                "id": 1, "start": 2.0, "end": 3.0,
                "text": "world", "speaker": "SPEAKER_A",
                "words": [{"word": "world", "start": 2.1, "end": 2.9}],
            },
        ]
        merged = self.worker.merge_segments_for_dubbing(segs)
        self.assertEqual(len(merged), 1)
        m = merged[0]
        self.assertAlmostEqual(m["start"], 0.0)
        self.assertAlmostEqual(m["end"], 3.0)
        # Slot is 3 s.  Speech: 0.8 + 0.8 = 1.6 s.  No silence in the dub.
        self.assertAlmostEqual(m["speech_duration"], 1.6, places=2)
        self.assertLess(m["speech_duration"], m["end"] - m["start"])

    def test_summarize_pacing_aggregates_basics(self):
        segs = [
            {"_pacing": {
                "applied_speed": 1.05, "applied_atempo": 1.00,
                "qa_retry": "no", "fit_action": "passthrough",
                "placed_action": "passthrough",
                "target_speech_seconds": 3.0, "actual_seconds": 3.05,
                "overflow_into_gap": 0.0,
            }},
            {"_pacing": {
                "applied_speed": 1.10, "applied_atempo": 1.05,
                "qa_retry": "improved", "fit_action": "atempo",
                "placed_action": "tail_trim",
                "target_speech_seconds": 4.0, "actual_seconds": 4.20,
                "overflow_into_gap": 0.10,
            }},
        ]
        summary = self.worker.summarize_pacing(segs)
        self.assertEqual(summary["appliedSpeed"]["count"], 2)
        self.assertAlmostEqual(summary["appliedSpeed"]["mean"], 1.075, places=3)
        self.assertEqual(summary["qaRetries"]["improved"], 1)
        self.assertEqual(summary["qaRetries"]["no"], 1)
        self.assertEqual(summary["fitActions"]["passthrough"], 1)
        self.assertEqual(summary["fitActions"]["atempo"], 1)
        self.assertEqual(summary["placedActions"]["tail_trim"], 1)

    # ── Pause-aware window pacing (the "artificial speed" fix) ────────────
    def test_annotate_dub_windows_reclaims_bounded_gap(self):
        # slot=3, gap_to_next=2 → usable_gap capped at GAP_REUSE_MAX_SECONDS.
        segs = [
            {"id": 0, "start": 0.0, "end": 3.0},
            {"id": 1, "start": 5.0, "end": 6.0},
        ]
        self.worker.annotate_dub_windows(segs, video_duration=10.0)
        expected = 3.0 + self.worker.GAP_REUSE_MAX_SECONDS - self.worker.TARGET_SLOT_SAFETY_PAD_SECONDS
        self.assertAlmostEqual(segs[0]["dub_window_seconds"], expected, places=3)

    def test_annotate_dub_windows_small_gap_uses_whole_gap(self):
        # gap=0.30 (< cap) → entire gap is reusable.
        segs = [
            {"id": 0, "start": 0.0, "end": 3.0},
            {"id": 1, "start": 3.3, "end": 4.0},
        ]
        self.worker.annotate_dub_windows(segs, video_duration=10.0)
        expected = 3.0 + 0.30 - self.worker.TARGET_SLOT_SAFETY_PAD_SECONDS
        self.assertAlmostEqual(segs[0]["dub_window_seconds"], expected, places=3)

    def test_annotate_dub_windows_last_segment_uses_video_duration(self):
        segs = [{"id": 0, "start": 0.0, "end": 3.0}]
        self.worker.annotate_dub_windows(segs, video_duration=10.0)
        expected = 3.0 + self.worker.GAP_REUSE_MAX_SECONDS - self.worker.TARGET_SLOT_SAFETY_PAD_SECONDS
        self.assertAlmostEqual(segs[0]["dub_window_seconds"], expected, places=3)

    def test_compute_target_prefers_annotated_window_over_phonation(self):
        # When a window is annotated it overrides the phonation-only target —
        # this is what stops a longer translation being sped up to fit the
        # shorter phonation window.
        seg = {"start": 0.0, "end": 5.0, "speech_duration": 2.0, "dub_window_seconds": 4.2}
        self.assertAlmostEqual(
            self.worker.compute_target_speech_seconds(seg), 4.2, places=3
        )

    def test_compute_target_window_larger_than_phonation(self):
        # End-to-end: a 5 s slot with 2 s phonation and a following pause.
        # Old behaviour targeted ~2 s (forcing speed-up); the window now gives
        # the dub the full natural slot, so the target is materially larger.
        seg = {"id": 0, "start": 0.0, "end": 5.0,
               "speech_duration": 2.0,
               "words": [{"word": "hi", "start": 0.0, "end": 2.0}]}
        phonation_target = self.worker.compute_target_speech_seconds(dict(seg))
        self.worker.annotate_dub_windows([seg], video_duration=8.0)
        window_target = self.worker.compute_target_speech_seconds(seg)
        self.assertGreater(window_target, phonation_target)


class DynamicTimelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_no_expansion_keeps_original_starts(self):
        segs = [{"start": 0.0, "end": 2.0}, {"start": 3.0, "end": 5.0}]
        natural = [1.5, 1.5]
        placements, freezes, new_total, extra, tail = self.worker.build_dynamic_timeline(
            segs, natural, video_duration=6.0, min_gap=0.12,
        )
        self.assertEqual(freezes, [])
        self.assertAlmostEqual(extra, 0.0, places=6)
        self.assertAlmostEqual(tail, 0.0, places=6)
        self.assertAlmostEqual(placements[0], 0.0, places=6)
        self.assertAlmostEqual(placements[1], 3.0, places=6)
        self.assertAlmostEqual(new_total, 6.0, places=6)

    def test_expansion_pushes_later_and_records_freeze(self):
        # First line's natural dub (3.0s) runs past the next line's start (2.0s).
        segs = [{"start": 0.0, "end": 2.0}, {"start": 2.0, "end": 3.0}]
        natural = [3.0, 1.0]
        placements, freezes, new_total, extra, tail = self.worker.build_dynamic_timeline(
            segs, natural, video_duration=5.0, min_gap=0.1,
        )
        # A freeze is inserted at the second line's original start.
        self.assertEqual(len(freezes), 1)
        self.assertAlmostEqual(freezes[0][0], 2.0, places=6)
        self.assertGreater(freezes[0][1], 0.0)
        # The second line never overlaps the first → no speed-up needed.
        self.assertGreaterEqual(placements[1] - placements[0], natural[0] - 1e-6)
        self.assertAlmostEqual(extra, 1.1, places=3)
        self.assertAlmostEqual(new_total, 6.1, places=3)

    def test_last_segment_overflow_extends_tail(self):
        segs = [{"start": 0.0, "end": 2.0}]
        natural = [4.0]
        placements, freezes, new_total, extra, tail = self.worker.build_dynamic_timeline(
            segs, natural, video_duration=3.0, min_gap=0.1,
        )
        self.assertEqual(freezes, [])
        self.assertAlmostEqual(placements[0], 0.0, places=6)
        # Audio (4s) exceeds the 3s video → tail hold extends the picture.
        self.assertAlmostEqual(new_total, 4.1, places=3)
        self.assertAlmostEqual(tail, 1.1, places=3)

    def test_every_segment_has_natural_room(self):
        # General invariant: under dynamic length, consecutive placements never
        # overlap a line's natural duration (so the voice is never compressed).
        segs = [
            {"start": 0.0, "end": 1.0},
            {"start": 1.2, "end": 2.0},
            {"start": 2.1, "end": 3.0},
            {"start": 5.0, "end": 6.0},
        ]
        natural = [2.5, 1.8, 0.6, 1.0]
        placements, _f, _nt, _ex, _t = self.worker.build_dynamic_timeline(
            segs, natural, video_duration=7.0, min_gap=0.1,
        )
        for i in range(len(segs) - 1):
            self.assertGreaterEqual(
                placements[i + 1] - placements[i], natural[i] - 1e-6,
                f"segment {i} would be compressed",
            )


if __name__ == "__main__":
    unittest.main()
