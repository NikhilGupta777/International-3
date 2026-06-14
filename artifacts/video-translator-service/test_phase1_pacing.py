"""
Phase 1 pacing-primitives smoke tests.

These are pure-function unit tests on the helpers introduced by the
Phase 1 audit fix.  They do NOT call CosyVoice, ffmpeg, or AssemblyAI.
"""
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


class DdbSafeTests(unittest.TestCase):
    """
    Regression guard for the DynamoDB resource serializer rejecting Python
    floats.  The DONE status payload carries float fields (outputDurationSeconds,
    dynamicExtraSeconds); if any reaches table.update_item un-coerced, the whole
    status write raises TypeError and is swallowed — the job never reaches DONE.
    """
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    @staticmethod
    def _assert_no_float(value):
        from decimal import Decimal
        # bool is a subclass of int — allowed (serializes to BOOL).
        if isinstance(value, bool):
            return
        assert not isinstance(value, float), f"float leaked through: {value!r}"
        if isinstance(value, dict):
            for v in value.values():
                DdbSafeTests._assert_no_float(v)
        elif isinstance(value, (list, tuple)):
            for v in value:
                DdbSafeTests._assert_no_float(v)
        else:
            # Numbers must be int or Decimal for the DDB resource serializer.
            if isinstance(value, (int, Decimal)):
                return

    def test_float_becomes_decimal(self):
        from decimal import Decimal
        self.assertIsInstance(self.worker._ddb_safe(0.0), Decimal)
        self.assertIsInstance(self.worker._ddb_safe(312.456), Decimal)
        self.assertEqual(self.worker._ddb_safe(312.456), Decimal("312.456"))

    def test_bool_stays_bool_not_decimal(self):
        from decimal import Decimal
        # bool must survive as bool so it serializes to BOOL, not a number.
        self.assertIs(self.worker._ddb_safe(True), True)
        self.assertIs(self.worker._ddb_safe(False), False)
        self.assertNotIsInstance(self.worker._ddb_safe(True), Decimal)

    def test_int_and_str_pass_through(self):
        self.assertEqual(self.worker._ddb_safe(12), 12)
        self.assertIsInstance(self.worker._ddb_safe(12), int)
        self.assertEqual(self.worker._ddb_safe("k"), "k")

    def test_non_finite_floats_dropped(self):
        self.assertIsNone(self.worker._ddb_safe(float("nan")))
        self.assertIsNone(self.worker._ddb_safe(float("inf")))
        self.assertIsNone(self.worker._ddb_safe(float("-inf")))

    def test_done_shaped_payload_is_float_free(self):
        # Mirrors the real DONE extra dict (worker.py update_progress).
        payload = {
            "outputKey": "k", "srtKey": "s", "transcriptKey": "t",
            "segmentCount": 12, "targetLang": "hi",
            "voiceClone": True, "voiceCloneApplied": False,
            "lipSync": False, "lipSyncApplied": False,
            "dynamicVideoLength": False, "dynamicVideoLengthApplied": True,
            "dynamicExtraSeconds": round(8.123, 3),
            "outputDurationSeconds": round(312.456, 3),
            "reportKey": "r",
        }
        safe = {k: self.worker._ddb_safe(v) for k, v in payload.items()}
        self._assert_no_float(safe)
        # bools preserved
        self.assertIs(safe["dynamicVideoLengthApplied"], True)

    def test_nested_structures_sanitized(self):
        out = self.worker._ddb_safe({"a": [1.5, {"b": 2.5}], "c": (0.1,)})
        self._assert_no_float(out)


class TimewarpPlanTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_dub_fits_leaves_video_untouched(self):
        # Each line's natural dub fits inside its source span → factor 1.0,
        # no speed-up, video plays exactly as-is.
        segs = [{"start": 0.0, "end": 2.0}, {"start": 5.0, "end": 7.0}]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, [1.5, 1.5], video_duration=10.0,
        )
        self.assertTrue(all(abs(c["factor"] - 1.0) < 1e-6 for c in chunks))
        self.assertTrue(all(abs(p["dub_speed"] - 1.0) < 1e-6 for p in seg_plan))
        self.assertAlmostEqual(total, 10.0, places=3)
        self.assertAlmostEqual(seg_plan[0]["out_start"], 0.0, places=3)
        self.assertAlmostEqual(seg_plan[1]["out_start"], 5.0, places=3)

    def test_slightly_longer_slows_video_only(self):
        # Dub a touch longer than the span → video slows within the cap, voice
        # stays natural (dub_speed 1.0).
        segs = [{"start": 0.0, "end": 3.0}]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, [3.3], video_duration=3.0,
        )
        self.assertAlmostEqual(chunks[-1]["factor"], 1.1, places=3)
        self.assertAlmostEqual(seg_plan[0]["dub_speed"], 1.0, places=6)
        self.assertAlmostEqual(total, 3.3, places=3)

    def test_dense_line_clamps_video_and_nudges_voice(self):
        # Dub far longer than the span: video slows to the cap (1.25) and the
        # leftover is absorbed by a small voice speed-up.
        segs = [{"start": 0.0, "end": 2.0}]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, [3.0], video_duration=2.0, max_stretch=1.25,
        )
        self.assertAlmostEqual(chunks[-1]["factor"], 1.25, places=3)
        self.assertAlmostEqual(seg_plan[0]["dub_speed"], 1.2, places=3)
        self.assertAlmostEqual(seg_plan[0]["placed_dur"], 2.5, places=3)
        self.assertAlmostEqual(total, 2.5, places=3)

    def test_lead_chunk_before_first_line_is_untouched(self):
        segs = [{"start": 2.0, "end": 4.0}]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, [1.5], video_duration=6.0,
        )
        self.assertIsNone(chunks[0]["seg_index"])
        self.assertAlmostEqual(chunks[0]["out_dur"], 2.0, places=3)
        self.assertAlmostEqual(chunks[0]["factor"], 1.0, places=6)
        self.assertAlmostEqual(seg_plan[0]["out_start"], 2.0, places=3)

    def test_no_overlap_and_total_consistency(self):
        segs = [
            {"start": 0.0, "end": 1.0},
            {"start": 1.2, "end": 2.0},
            {"start": 3.0, "end": 4.0},
        ]
        natural = [2.5, 0.6, 1.0]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, natural, video_duration=6.0,
        )
        # placements never overlap the placed dub of the previous line.
        for i in range(len(seg_plan) - 1):
            self.assertGreaterEqual(
                seg_plan[i + 1]["out_start"] + 1e-6,
                seg_plan[i]["out_start"] + seg_plan[i]["placed_dur"],
            )
        # total equals the sum of all chunk output durations.
        self.assertAlmostEqual(total, sum(c["out_dur"] for c in chunks), places=3)
        # video factors stay within [1.0, cap].
        for c in chunks:
            self.assertGreaterEqual(c["factor"], 1.0 - 1e-6)
            self.assertLessEqual(c["factor"], self.worker.DYNAMIC_MAX_VIDEO_STRETCH + 1e-6)

    def test_empty_segments_yield_degenerate_plan(self):
        # No segments -> empty plan, zero total.  main() must guard this and
        # fall back to fixed-length timing (a zero-length mux would be broken).
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            [], [], video_duration=10.0,
        )
        self.assertEqual(chunks, [])
        self.assertEqual(seg_plan, [])
        self.assertEqual(total, 0.0)


class SmoothTimewarpTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def _seg_chunks(self, chunks, seg_index):
        return [c for c in chunks if c.get("seg_index") == seg_index]

    def test_ease_weight_zero_at_edges_one_in_middle(self):
        w = self.worker._ease_weight
        sh = 0.3
        self.assertAlmostEqual(w(0.0, sh), 0.0, places=6)
        self.assertAlmostEqual(w(1.0, sh), 0.0, places=6)
        self.assertAlmostEqual(w(0.5, sh), 1.0, places=6)
        # Monotonic non-decreasing on the rising shoulder.
        prev = -1.0
        for k in range(0, 31):
            x = (k / 30.0) * sh
            cur = w(x, sh)
            self.assertGreaterEqual(cur + 1e-9, prev)
            prev = cur

    def test_smooth_subdivides_stretched_line_into_slices(self):
        # One line whose dub is longer than its span -> multiple eased slices.
        segs = [{"start": 0.0, "end": 4.0}]
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, [4.8], video_duration=4.0, max_stretch=1.25, smooth=True,
        )
        seg_chunks = self._seg_chunks(chunks, 0)
        self.assertGreater(len(seg_chunks), 1)  # not a single hard-step chunk
        # Slice output durations sum exactly to the line's output slot.
        self.assertAlmostEqual(
            sum(c["out_dur"] for c in seg_chunks), seg_plan[0]["out_dur"], places=4
        )

    def test_smooth_peak_factor_never_exceeds_cap(self):
        segs = [{"start": 0.0, "end": 4.0}]
        cap = 1.25
        chunks, _seg, _total = self.worker.build_timewarp_plan(
            segs, [10.0], video_duration=4.0, max_stretch=cap, smooth=True,
        )
        for c in chunks:
            self.assertLessEqual(c["factor"], cap + 1e-6)
            self.assertGreaterEqual(c["factor"], 1.0 - 1e-6)

    def test_smooth_edges_are_near_normal_speed(self):
        # First/last slice of a stretched line should be close to 1.0x so it
        # joins its neighbours without a visible jump.
        segs = [{"start": 0.0, "end": 5.0}]
        chunks, _seg, _total = self.worker.build_timewarp_plan(
            segs, [6.0], video_duration=5.0, max_stretch=1.25, smooth=True,
        )
        seg_chunks = self._seg_chunks(chunks, 0)
        self.assertLess(seg_chunks[0]["factor"], 1.10)
        self.assertLess(seg_chunks[-1]["factor"], 1.10)
        # The middle is the slowest part of the curve.
        mid = seg_chunks[len(seg_chunks) // 2]["factor"]
        self.assertGreater(mid, seg_chunks[0]["factor"])

    def test_smooth_fitting_line_is_single_untouched_chunk(self):
        # A line whose dub already fits is never sliced.
        segs = [{"start": 0.0, "end": 3.0}]
        chunks, seg_plan, _total = self.worker.build_timewarp_plan(
            segs, [2.0], video_duration=3.0, smooth=True,
        )
        seg_chunks = self._seg_chunks(chunks, 0)
        self.assertEqual(len(seg_chunks), 1)
        self.assertAlmostEqual(seg_chunks[0]["factor"], 1.0, places=6)
        self.assertAlmostEqual(seg_plan[0]["dub_speed"], 1.0, places=6)

    def test_smooth_total_matches_seg_plan_and_chunks(self):
        segs = [
            {"start": 0.0, "end": 2.0},
            {"start": 2.0, "end": 5.0},
            {"start": 5.0, "end": 6.0},
        ]
        natural = [3.0, 3.2, 0.8]  # first two stretch, last fits
        chunks, seg_plan, total = self.worker.build_timewarp_plan(
            segs, natural, video_duration=6.0, max_stretch=1.25, smooth=True,
        )
        self.assertAlmostEqual(total, sum(c["out_dur"] for c in chunks), places=3)
        self.assertAlmostEqual(total, seg_plan[-1]["out_start"] + seg_plan[-1]["out_dur"], places=3)
        # out_start of each segment equals the running sum of its slices.
        for i in range(len(seg_plan) - 1):
            self.assertGreaterEqual(seg_plan[i + 1]["out_start"] + 1e-6,
                                    seg_plan[i]["out_start"] + seg_plan[i]["placed_dur"])

    def test_smooth_slice_budget_caps_total_slices(self):
        # Many stretched lines must not blow past the global slice budget.
        segs = [{"start": float(i), "end": float(i) + 1.0} for i in range(200)]
        natural = [1.2] * 200  # every line stretches
        chunks, _seg, _total = self.worker.build_timewarp_plan(
            segs, natural, video_duration=200.0, max_stretch=1.25, smooth=True,
        )
        # Allow a little headroom for the lead/passthrough chunks.
        self.assertLessEqual(
            len(chunks), self.worker.DYNAMIC_TIMEWARP_SLICE_BUDGET + 16
        )


if __name__ == "__main__":
    unittest.main()
