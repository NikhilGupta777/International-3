"""
Phase 2 translation-correctness smoke tests.

These are pure-function unit tests on the helpers introduced by the
Phase 2 audit fixes.  They do NOT call Gemini, CosyVoice, or any external API.
"""
import math
import unittest

from test_worker_guards import import_worker


class TranslationModelSelectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_default_model_is_flash(self):
        """Default translation model should be gemini-3.5-flash."""
        model = self.worker._gemini_model_for_mode("default")
        self.assertEqual(model, "gemini-3.5-flash")

    def test_pro_mode_returns_flash(self):
        """All modes now use gemini-3.5-flash."""
        model = self.worker._gemini_model_for_mode("pro")
        self.assertEqual(model, "gemini-3.5-flash")

    def test_fallback_model_is_flash(self):
        """QA fallback model should be gemini-3.5-flash."""
        model = self.worker._gemini_fallback_model()
        self.assertEqual(model, "gemini-3.5-flash")

    def test_env_override_respected(self):
        """TRANSLATION_MODEL env override should take precedence."""
        import os
        original = os.environ.get("TRANSLATION_MODEL")
        try:
            os.environ["TRANSLATION_MODEL"] = "gemini-custom-model"
            model = self.worker._gemini_model_for_mode("default")
            self.assertEqual(model, "gemini-custom-model")
        finally:
            if original is None:
                os.environ.pop("TRANSLATION_MODEL", None)
            else:
                os.environ["TRANSLATION_MODEL"] = original


class MaxCharsBudgetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_basic_budget_calculation(self):
        """5 seconds at 13.5 cps (Hindi) = ~74 chars (with 10% overshoot)."""
        budget = self.worker.compute_segment_max_chars(5.0, 13.5)
        # 5 * 13.5 * 1.10 = 74.25 -> ceil = 75
        self.assertEqual(budget, 75)

    def test_short_segment_has_minimum_budget(self):
        """Very short segments should still get the minimum budget."""
        budget = self.worker.compute_segment_max_chars(0.1, 13.5)
        self.assertEqual(budget, self.worker._MIN_CHARS_BUDGET)

    def test_zero_target_returns_minimum(self):
        budget = self.worker.compute_segment_max_chars(0.0, 13.5)
        self.assertEqual(budget, self.worker._MIN_CHARS_BUDGET)

    def test_budget_scales_with_duration(self):
        """Longer segments get proportionally more chars."""
        budget_3s = self.worker.compute_segment_max_chars(3.0, 16.5)
        budget_6s = self.worker.compute_segment_max_chars(6.0, 16.5)
        self.assertGreater(budget_6s, budget_3s)
        # Should be roughly 2x
        self.assertAlmostEqual(budget_6s / budget_3s, 2.0, delta=0.1)

    def test_budget_scales_with_language_rate(self):
        """Faster languages (higher cps) get more chars per second."""
        budget_hindi = self.worker.compute_segment_max_chars(5.0, 13.5)
        budget_english = self.worker.compute_segment_max_chars(5.0, 16.5)
        self.assertGreater(budget_english, budget_hindi)


class NativeScriptCheckTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_hindi_devanagari_passes(self):
        """Pure Devanagari text should pass for Hindi."""
        text = "यह एक परीक्षण वाक्य है।"
        self.assertTrue(self.worker.check_native_script(text, "hi"))

    def test_hindi_roman_fails(self):
        """Roman Hindi (Hinglish) should fail for Hindi target."""
        text = "Yeh ek test sentence hai."
        self.assertFalse(self.worker.check_native_script(text, "hi"))

    def test_hindi_mixed_with_numbers_passes(self):
        """Devanagari with numbers and punctuation should pass."""
        text = "बी जे पी ने 2024 में जीत हासिल की।"
        self.assertTrue(self.worker.check_native_script(text, "hi"))

    def test_english_always_passes(self):
        """English (Latin script) should always pass — no script check needed."""
        text = "This is an English sentence."
        self.assertTrue(self.worker.check_native_script(text, "en"))

    def test_unknown_language_passes(self):
        """Unknown language codes should pass (no check applied)."""
        text = "Any text here"
        self.assertTrue(self.worker.check_native_script(text, "xx"))

    def test_tamil_script_passes(self):
        """Tamil script text should pass for Tamil target."""
        text = "இது ஒரு சோதனை வாக்கியம்."
        self.assertTrue(self.worker.check_native_script(text, "ta"))

    def test_tamil_roman_fails(self):
        """Romanized Tamil should fail."""
        text = "Ithu oru sothanai vaakkiyam."
        self.assertFalse(self.worker.check_native_script(text, "ta"))

    def test_bengali_script_passes(self):
        """Bengali script should pass for Bengali target."""
        text = "এটি একটি পরীক্ষা বাক্য।"
        self.assertTrue(self.worker.check_native_script(text, "bn"))

    def test_arabic_script_passes(self):
        """Arabic script should pass for Arabic target."""
        text = "هذه جملة اختبار."
        self.assertTrue(self.worker.check_native_script(text, "ar"))

    def test_korean_hangul_passes(self):
        """Hangul should pass for Korean target."""
        text = "이것은 테스트 문장입니다."
        self.assertTrue(self.worker.check_native_script(text, "ko"))

    def test_cyrillic_passes_for_russian(self):
        """Cyrillic should pass for Russian target."""
        text = "Это тестовое предложение."
        self.assertTrue(self.worker.check_native_script(text, "ru"))

    def test_empty_text_passes(self):
        """Empty or whitespace-only text should pass."""
        self.assertTrue(self.worker.check_native_script("", "hi"))
        self.assertTrue(self.worker.check_native_script("   ", "hi"))

    def test_mostly_native_with_some_latin_passes(self):
        """80%+ native with some English words should pass (proper nouns)."""
        # 'Modi' is a proper noun that might stay in Latin
        text = "प्रधानमंत्री Modi ने कहा कि देश आगे बढ़ रहा है।"
        self.assertTrue(self.worker.check_native_script(text, "hi"))

    def test_mostly_latin_with_some_devanagari_fails(self):
        """Mostly Latin with few Devanagari chars should fail."""
        text = "Prime Minister ne kaha ki desh aage badh raha hai।"
        self.assertFalse(self.worker.check_native_script(text, "hi"))


class ScriptRangesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_all_script_families_have_ranges(self):
        """Every script family in _SCRIPT_RANGES should have at least one range."""
        for family, ranges in self.worker._SCRIPT_RANGES.items():
            self.assertGreater(len(ranges), 0, f"No ranges for {family}")
            for start, end in ranges:
                self.assertLess(start, end, f"Invalid range in {family}: ({start}, {end})")

    def test_all_lang_to_script_keys_exist_in_ranges(self):
        """Every script key referenced in _LANG_TO_SCRIPT must exist in _SCRIPT_RANGES."""
        for lang, script_keys in self.worker._LANG_TO_SCRIPT.items():
            for key in script_keys:
                self.assertIn(
                    key, self.worker._SCRIPT_RANGES,
                    f"Language '{lang}' references script '{key}' not in _SCRIPT_RANGES"
                )


class DurationOvershootDetectionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.worker = import_worker()

    def test_short_text_no_overshoot(self):
        """Short text in a long slot should NOT trigger overshoot."""
        # 5 second slot, short text
        seg = {"start": 0.0, "end": 5.0, "speech_duration": 4.5, "tts_text": "नमस्ते"}
        target = self.worker.compute_target_speech_seconds(seg)
        predicted = self.worker.predict_segment_speech_seconds("नमस्ते", 1.0, 13.5)
        self.assertLess(predicted / target, self.worker._DURATION_OVERSHOOT_THRESHOLD)

    def test_long_text_triggers_overshoot(self):
        """Very long text in a short slot should trigger overshoot."""
        # 2 second slot with long text
        seg = {"start": 0.0, "end": 2.0, "speech_duration": 1.8}
        long_text = "यह एक बहुत लंबा वाक्य है जो दो सेकंड के स्लॉट में नहीं आ सकता है और इसलिए इसे छोटा करना होगा"
        target = self.worker.compute_target_speech_seconds(seg)
        predicted = self.worker.predict_segment_speech_seconds(long_text, 1.0, 13.5)
        self.assertGreater(predicted / target, self.worker._DURATION_OVERSHOOT_THRESHOLD)


if __name__ == "__main__":
    unittest.main()
