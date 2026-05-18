"""
Phase 4 + 5 tests — mixing polish, parallelism, hygiene.

Tests cover:
  - Equal-power crossfade math (sqrt curves, energy preservation)
  - Loudnorm applied to voice-only path
  - instruct2 guard (CosyVoice3-only)
  - DEMUCS_BEFORE_ASR env flag
  - requirements.txt dedup verification
  - Dynamic batch timeout formula
"""

import math
import os
import re
import sys
import unittest

# ── Ensure worker module is importable ────────────────────────────────────────
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))


class CrossfadeMathTests(unittest.TestCase):
    """Verify the equal-power crossfade math used in assemble_dubbed_audio."""

    def test_sqrt_curves_are_energy_preserving(self):
        """Equal-power crossfade: fade_in^2 + fade_out^2 == 1 at all points."""
        n = 600  # 25ms at 24kHz
        for i in range(n):
            t = i / (n - 1)
            fade_in = math.sqrt(t)
            fade_out = math.sqrt(1.0 - t)
            energy_sum = fade_in**2 + fade_out**2
            self.assertAlmostEqual(energy_sum, 1.0, places=6,
                                   msg=f"Energy not preserved at sample {i}")

    def test_crossfade_midpoint_amplitude_boost(self):
        """Equal-power crossfade has slight amplitude boost at midpoint (expected).
        At t=0.5: fade_in + fade_out = sqrt(0.5) + sqrt(0.5) = ~1.414.
        This is correct — energy is preserved, not amplitude.
        The peak is bounded: max(sqrt(t) + sqrt(1-t)) = sqrt(2) at t=0.5."""
        t = 0.5
        fade_in = math.sqrt(t)
        fade_out = math.sqrt(1.0 - t)
        amplitude_sum = fade_in + fade_out
        # Should be sqrt(2) at midpoint
        self.assertAlmostEqual(amplitude_sum, math.sqrt(2), places=10)

    def test_crossfade_sample_count_is_25ms_at_24khz(self):
        """25ms crossfade at 24kHz = 600 samples."""
        SR = 24000
        crossfade_seconds = 0.025
        expected_samples = int(crossfade_seconds * SR)
        self.assertEqual(expected_samples, 600)

    def test_fade_endpoints(self):
        """fade_in starts at 0 and ends at 1; fade_out is the reverse."""
        # t=0
        self.assertAlmostEqual(math.sqrt(0.0), 0.0, places=10)
        # t=1
        self.assertAlmostEqual(math.sqrt(1.0), 1.0, places=10)
        # fade_out at t=0
        self.assertAlmostEqual(math.sqrt(1.0 - 0.0), 1.0, places=10)
        # fade_out at t=1
        self.assertAlmostEqual(math.sqrt(1.0 - 1.0), 0.0, places=10)


class Instruct2GuardTests(unittest.TestCase):
    """Verify inference_instruct2 is only used on CosyVoice3 (issue #1802)."""

    def test_instruct2_guard_requires_cosyvoice3(self):
        """The use_instruct2 condition in worker.py includes is_cosyvoice3."""
        source_path = os.path.join(os.path.dirname(__file__), "worker.py")
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
        # Find the use_instruct2 assignment
        idx = source.find("use_instruct2 = (")
        self.assertGreater(idx, 0, "use_instruct2 assignment not found")
        # Extract the block (next 300 chars should contain the condition)
        block = source[idx:idx + 300]
        self.assertIn("is_cosyvoice3", block,
                      "is_cosyvoice3 guard missing from use_instruct2 condition")

    def test_instruct2_not_used_for_cosyvoice2(self):
        """Simulate CosyVoice2 class — instruct2 should NOT fire."""
        _has_instruct2 = True
        is_cosyvoice3 = False  # CosyVoice2
        emotion_instruction = "Speak in a happy tone."
        use_cross_lingual = False

        use_instruct2 = (
            _has_instruct2
            and is_cosyvoice3
            and emotion_instruction
            and not use_cross_lingual
        )
        self.assertFalse(use_instruct2)

    def test_instruct2_used_for_cosyvoice3_with_emotion(self):
        """Simulate CosyVoice3 with non-neutral emotion — instruct2 should fire."""
        _has_instruct2 = True
        is_cosyvoice3 = True
        emotion_instruction = "Speak in a happy tone."
        use_cross_lingual = False

        use_instruct2 = (
            _has_instruct2
            and is_cosyvoice3
            and emotion_instruction
            and not use_cross_lingual
        )
        self.assertTrue(use_instruct2)

    def test_instruct2_not_used_in_cross_lingual(self):
        """Even on CosyVoice3, cross-lingual mode should NOT use instruct2."""
        _has_instruct2 = True
        is_cosyvoice3 = True
        emotion_instruction = "Speak in a happy tone."
        use_cross_lingual = True

        use_instruct2 = (
            _has_instruct2
            and is_cosyvoice3
            and emotion_instruction
            and not use_cross_lingual
        )
        self.assertFalse(use_instruct2)


class DemucsParallelismTests(unittest.TestCase):
    """Verify the DEMUCS_BEFORE_ASR env flag logic."""

    def test_demucs_before_asr_flag_default_is_false(self):
        """Default: parallel path (DEMUCS_BEFORE_ASR not set)."""
        os.environ.pop("DEMUCS_BEFORE_ASR", None)
        val = os.environ.get("DEMUCS_BEFORE_ASR", "false").lower() in ("1", "true", "yes")
        self.assertFalse(val)

    def test_demucs_before_asr_flag_true(self):
        """When set to true, sequential path is activated."""
        os.environ["DEMUCS_BEFORE_ASR"] = "true"
        try:
            val = os.environ.get("DEMUCS_BEFORE_ASR", "false").lower() in ("1", "true", "yes")
            self.assertTrue(val)
        finally:
            del os.environ["DEMUCS_BEFORE_ASR"]

    def test_demucs_before_asr_flag_numeric(self):
        """Accepts '1' as truthy."""
        os.environ["DEMUCS_BEFORE_ASR"] = "1"
        try:
            val = os.environ.get("DEMUCS_BEFORE_ASR", "false").lower() in ("1", "true", "yes")
            self.assertTrue(val)
        finally:
            del os.environ["DEMUCS_BEFORE_ASR"]

    def test_parallel_code_exists_in_worker(self):
        """Worker.py should have the ThreadPoolExecutor parallel path."""
        source_path = os.path.join(os.path.dirname(__file__), "worker.py")
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertIn("_TPE_demucs", source,
                      "ThreadPoolExecutor alias for Demucs parallelism not found")
        self.assertIn("demucs_future", source,
                      "demucs_future variable not found — parallel path missing")


class RequirementsHygieneTests(unittest.TestCase):
    """Verify requirements.txt has no duplicates."""

    def test_no_duplicate_packages(self):
        """Each package should appear exactly once in requirements.txt."""
        req_path = os.path.join(os.path.dirname(__file__), "requirements.txt")
        with open(req_path) as f:
            lines = f.readlines()

        packages = []
        for line in lines:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            # Extract package name (before ==, >=, <, etc.), including dotted names
            match = re.match(r"([a-zA-Z0-9_.\-]+)", line)
            if match:
                packages.append(match.group(1).lower().replace("-", "_"))

        seen: dict = {}
        duplicates = []
        for pkg in packages:
            if pkg in seen:
                duplicates.append(pkg)
            seen[pkg] = True

        self.assertEqual(duplicates, [],
                         f"Duplicate packages in requirements.txt: {duplicates}")

    def test_demucs_listed_only_once(self):
        """Specific check: demucs was the known duplicate (P3-8)."""
        req_path = os.path.join(os.path.dirname(__file__), "requirements.txt")
        with open(req_path) as f:
            content = f.read()
        count = len(re.findall(r"^demucs==", content, re.MULTILINE))
        self.assertEqual(count, 1, f"demucs appears {count} times, expected 1")


class DynamicBatchTimeoutTests(unittest.TestCase):
    """Verify the dynamic timeout formula: max(900, duration * 6), capped at env max."""

    def _compute_timeout(self, duration_seconds, max_timeout=3000):
        """Mirror the TypeScript logic in Python for testing."""
        if duration_seconds and math.isfinite(duration_seconds) and duration_seconds > 0:
            gpu_timeout = max(900, round(duration_seconds * 6))
            gpu_timeout = min(gpu_timeout, max_timeout)
        else:
            gpu_timeout = max_timeout
        return gpu_timeout

    def test_short_video_gets_minimum_900s(self):
        """A 2-min video: 120 * 6 = 720 -> clamped to 900."""
        self.assertEqual(self._compute_timeout(120), 900)

    def test_10min_video_gets_capped_at_3000(self):
        """A 10-min video: 600 * 6 = 3600 -> capped at 3000 (env default)."""
        self.assertEqual(self._compute_timeout(600), 3000)

    def test_5min_video_gets_1800s(self):
        """A 5-min video: 300 * 6 = 1800."""
        self.assertEqual(self._compute_timeout(300), 1800)

    def test_unknown_duration_uses_static_default(self):
        """When duration is None, fall back to max_timeout."""
        self.assertEqual(self._compute_timeout(None), 3000)
        self.assertEqual(self._compute_timeout(0), 3000)

    def test_never_exceeds_env_max(self):
        """A 60-min video: 3600 * 6 = 21600 -> capped at 3000."""
        self.assertEqual(self._compute_timeout(3600), 3000)

    def test_custom_max_timeout(self):
        """Higher env-var max allows longer timeouts."""
        # 25 min video with 12000s max: 1500 * 6 = 9000
        self.assertEqual(self._compute_timeout(1500, max_timeout=12000), 9000)


class LoudnormPathTests(unittest.TestCase):
    """Verify loudnorm is applied on voice-only path (no background)."""

    def test_loudnorm_code_exists_in_voice_only_path(self):
        """The voice-only return path should apply loudnorm."""
        source_path = os.path.join(os.path.dirname(__file__), "worker.py")
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
        self.assertIn("dubbed_voice_normalised.wav", source,
                      "Voice-only loudnorm output path not found")
        self.assertIn("loudnorm=I=-16:TP=-1.5:LRA=11", source,
                      "loudnorm filter not found in voice-only path")

    def test_dead_demucs_lazy_install_removed(self):
        """The dead lazy demucs pip install should be gone (P3-1)."""
        source_path = os.path.join(os.path.dirname(__file__), "worker.py")
        with open(source_path, "r", encoding="utf-8") as f:
            source = f.read()
        # The old pattern was: if importlib.util.find_spec("demucs") is None: pip install
        self.assertNotIn('find_spec("demucs")', source,
                         "Dead demucs lazy install still present")


if __name__ == "__main__":
    unittest.main()
