import unittest

from vierrataleai.engine import _resolve_from_list


class ModelResolveTest(unittest.TestCase):
    INSTALLED = ["qwen3:0.6b", "gemma3:1b", "llama3.2:1b", "qwen2.5-coder:1.5b"]

    def test_exact_installed_model_used_as_is(self):
        r = _resolve_from_list(self.INSTALLED, "gemma3:1b")
        self.assertEqual(r["model"], "gemma3:1b")
        self.assertFalse(r["substituted"])
        self.assertIsNone(r["reason"])

    def test_same_family_sibling_substitutes(self):
        r = _resolve_from_list(self.INSTALLED, "qwen2.5:1.5b")
        self.assertEqual(r["model"], "qwen2.5-coder:1.5b")
        self.assertTrue(r["substituted"])
        self.assertIn("same family", r["reason"])

    def test_variant_suffix_matches_family(self):
        r = _resolve_from_list(self.INSTALLED, "qwen2.5-instruct:3b")
        self.assertEqual(r["model"], "qwen2.5-coder:1.5b")

    def test_no_match_returns_none_model(self):
        r = _resolve_from_list(self.INSTALLED, "mistral:7b")
        self.assertIsNone(r["model"])
        self.assertTrue(r["substituted"])

    def test_empty_installed_never_matches(self):
        self.assertIsNone(_resolve_from_list([], "gemma3:1b")["model"])


if __name__ == "__main__":
    unittest.main()