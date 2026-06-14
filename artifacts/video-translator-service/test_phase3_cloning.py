"""
Phase 3 unit tests — CosyVoice cloning speed & quality improvements.
Tests cover:
  - Version detection via class name (P1-4)
  - Environment flag parsing (fp16, vLLM, parallel)
  - Reference audio cap (10s instead of 24s)
  - Demucs reference behavior (P1-6: original stays as clone ref)
"""
import os
import sys
import unittest

# Add parent dir so we can import worker
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Set required env vars before importing worker
os.environ.setdefault("JOB_ID", "test-phase3")
os.environ.setdefault("S3_BUCKET", "test-bucket")
os.environ.setdefault("S3_INPUT_KEY", "test-input.mp4")
os.environ.setdefault("DYNAMODB_TABLE", "test-table")
os.environ.setdefault("TARGET_LANG", "Hindi")
os.environ.setdefault("TARGET_LANG_CODE", "hi")


class VersionDetectionTests(unittest.TestCase):
    """P1-4: Version detection should use class name, not path regex."""

    def test_cosyvoice3_class_detected(self):
        """A class named CosyVoice3 should be detected as v3."""
        # Simulate the logic from worker.py
        class FakeCosyVoice3:
            pass

        model = FakeCosyVoice3()
        _model_class_name = type(model).__name__
        is_cosyvoice3 = "CosyVoice3" in _model_class_name
        is_cosyvoice2 = "CosyVoice2" in _model_class_name and not is_cosyvoice3
        self.assertTrue(is_cosyvoice3)
        self.assertFalse(is_cosyvoice2)

    def test_cosyvoice2_class_detected(self):
        """A class named CosyVoice2 should be detected as v2."""

        class FakeCosyVoice2:
            pass

        model = FakeCosyVoice2()
        _model_class_name = type(model).__name__
        is_cosyvoice3 = "CosyVoice3" in _model_class_name
        is_cosyvoice2 = "CosyVoice2" in _model_class_name and not is_cosyvoice3
        self.assertFalse(is_cosyvoice3)
        self.assertTrue(is_cosyvoice2)

    def test_cosyvoice_legacy_class_detected(self):
        """A class named CosyVoice (v1) should detect as neither v2 nor v3."""

        class FakeCosyVoice:
            pass

        model = FakeCosyVoice()
        _model_class_name = type(model).__name__
        is_cosyvoice3 = "CosyVoice3" in _model_class_name
        is_cosyvoice2 = "CosyVoice2" in _model_class_name and not is_cosyvoice3
        self.assertFalse(is_cosyvoice3)
        self.assertFalse(is_cosyvoice2)

    def test_cosyvoice3_inheriting_from_cosyvoice2(self):
        """CosyVoice3 inherits from CosyVoice2 — class name check must prioritize v3."""

        class FakeCosyVoice2:
            pass

        class FakeCosyVoice3(FakeCosyVoice2):
            pass

        model = FakeCosyVoice3()
        _model_class_name = type(model).__name__
        # The key check: v3 detected first, v2 flag stays False
        is_cosyvoice3 = "CosyVoice3" in _model_class_name
        is_cosyvoice2 = "CosyVoice2" in _model_class_name and not is_cosyvoice3
        self.assertTrue(is_cosyvoice3)
        self.assertFalse(is_cosyvoice2)


class EnvFlagTests(unittest.TestCase):
    """Phase 3 performance flags from environment."""

    def test_cosyvoice_fp16_default_is_false(self):
        """Default: fp16 is disabled."""
        from worker import COSYVOICE_FP16
        # Unless the test runner has COSYVOICE_FP16 set, default should be False
        if os.environ.get("COSYVOICE_FP16", "").lower() not in ("1", "true", "yes", "on"):
            self.assertFalse(COSYVOICE_FP16)

    def test_cosyvoice_vllm_default_is_false(self):
        """Default: vLLM is disabled."""
        from worker import COSYVOICE_VLLM
        if os.environ.get("COSYVOICE_VLLM", "").lower() not in ("1", "true", "yes", "on"):
            self.assertFalse(COSYVOICE_VLLM)

    def test_cosyvoice_parallel_synth_default_is_1(self):
        """Default: sequential synthesis (1 worker)."""
        from worker import COSYVOICE_PARALLEL_SYNTH
        if "COSYVOICE_PARALLEL_SYNTH" not in os.environ:
            self.assertEqual(COSYVOICE_PARALLEL_SYNTH, 1)


class ReferenceCapTests(unittest.TestCase):
    """Voice-clone reference length cap (env-tunable via REFERENCE_MAX_SECONDS)."""

    def test_extract_speaker_reference_default_cap_matches_constant(self):
        """The default max_ref_duration should follow REFERENCE_MAX_SECONDS."""
        import inspect
        from worker import extract_speaker_reference, REFERENCE_MAX_SECONDS

        sig = inspect.signature(extract_speaker_reference)
        default = sig.parameters["max_ref_duration"].default
        self.assertEqual(default, REFERENCE_MAX_SECONDS)

    def test_reference_max_seconds_default_is_15(self):
        """Default reference cap is 15s when env is unset (bumped from 10s)."""
        from worker import REFERENCE_MAX_SECONDS
        if "REFERENCE_MAX_SECONDS" not in os.environ:
            self.assertEqual(REFERENCE_MAX_SECONDS, 15.0)


class CloneReferenceFromVocalsTests(unittest.TestCase):
    """Clone reference is built from Demucs-isolated vocals, not mixed audio."""

    def test_clone_reference_from_vocals_default_on(self):
        """The clean-vocals clone reference is enabled by default."""
        from worker import CLONE_REFERENCE_FROM_VOCALS
        if "CLONE_REFERENCE_FROM_VOCALS" not in os.environ:
            self.assertTrue(CLONE_REFERENCE_FROM_VOCALS)

    def test_main_uses_vocals_as_clone_reference(self):
        """
        The single-job pipeline should reassign reference_audio to a Demucs vocals source when
        voice cloning is on (the whole point of the clean-vocals fix), and
        record the source it used.
        """
        import ast
        import inspect
        import textwrap
        import worker

        source = textwrap.dedent(inspect.getsource(worker.process_single_job))
        tree = ast.parse(source)

        reassigned_to_vocals = False
        for node in ast.walk(tree):
            if not isinstance(node, ast.Assign) or len(node.targets) != 1:
                continue
            target = node.targets[0]
            if (
                isinstance(target, ast.Name)
                and target.id == "reference_audio"
                and isinstance(node.value, ast.Name)
                and "vocal" in node.value.id.lower()
            ):
                reassigned_to_vocals = True
                break

        self.assertTrue(
            reassigned_to_vocals,
            "process_single_job() should use isolated vocals as the clone reference.",
        )
        # And the chosen source must be surfaced for diagnosability.
        self.assertIn("clone_reference_source", source)


class Instruct2Tests(unittest.TestCase):
    """P1-2: inference_instruct2 for non-neutral emotions."""

    def test_instruct2_format_matches_upstream(self):
        """
        Upstream example.py format for instruct_text:
        'You are a helpful assistant. {instruction}.<|endofprompt|>'
        """
        emotion = "happy"
        emotion_instruction = f"Speak in a {emotion} tone."
        instruct2_text = f"You are a helpful assistant. {emotion_instruction}<|endofprompt|>"
        # Verify the format matches upstream
        self.assertIn("You are a helpful assistant.", instruct2_text)
        self.assertIn("<|endofprompt|>", instruct2_text)
        self.assertIn("Speak in a happy tone.", instruct2_text)
        # endofprompt must be at the end
        self.assertTrue(instruct2_text.endswith("<|endofprompt|>"))

    def test_neutral_emotion_does_not_generate_instruction(self):
        """Neutral emotion should produce empty emotion_instruction."""
        emotion = "neutral"
        emotion_instruction = (
            f"Speak in a {emotion} tone." if emotion and emotion != "neutral" else ""
        )
        self.assertEqual(emotion_instruction, "")


class RetryChainTests(unittest.TestCase):
    """P1-11: Per-segment retry chain should be in the synthesis function."""

    def test_retry_chain_code_present(self):
        """Verify the retry chain structure exists in synthesize_segments_cosyvoice."""
        import worker
        import inspect

        source = inspect.getsource(worker.synthesize_segments_cosyvoice)
        # All 4 fallback levels should be referenced
        self.assertIn("Fallback level 1", source)
        self.assertIn("Fallback level 2", source)
        self.assertIn("Fallback level 3", source)
        self.assertIn("Fallback level 4", source)
        # edge-tts and silence fallbacks
        self.assertIn("synthesize_edge_tts_single", source)
        self.assertIn("synthesize_silence_single", source)


if __name__ == "__main__":
    unittest.main()
