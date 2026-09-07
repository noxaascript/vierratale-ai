import os
import tempfile
import unittest

from vierrataleai import catalog


class CatalogTest(unittest.TestCase):
    def test_mapping(self):
        self.assertEqual(catalog.get_real_model("VRTL-2.fast"), "gemma3:1b")
        self.assertEqual(catalog.get_display_name("gemma3:1b"), "VTL-2.7-Flash")

    def test_legacy_vierratale_names_still_map(self):
        self.assertEqual(catalog.get_real_model("vierratale-fast"), "gemma3:1b")
        self.assertEqual(catalog.get_real_model("vierratale-cloud-mini"), "gpt-4o-mini")
        self.assertEqual(catalog.normalize("vierratale-pro"), "VTL-3.7-Ultra")
        self.assertEqual(catalog.normalize("VRTL-6.pro"), "VTL-3.7-Ultra")
        self.assertEqual(catalog.normalize("nonsense"), "nonsense")

    def test_local_vs_cloud(self):
        self.assertTrue(catalog.is_local_model("VRTL-2.fast"))
        self.assertFalse(catalog.is_local_model("VRTL-8.cloud"))
        self.assertTrue(catalog.is_local_model("vierratale-fast"))
        self.assertTrue(catalog.is_cloud_model("VRTL-7.cloud-mini"))
        self.assertFalse(catalog.is_cloud_model("VRTL-6.pro"))
        self.assertTrue(catalog.is_cloud_model("vierratale-cloud"))

    def test_default_cloud(self):
        default = catalog.get_default_cloud_model()
        self.assertTrue(catalog.is_cloud_model(default))
        self.assertTrue(catalog.get_real_model(default).startswith("gpt-"))

    def test_model_info_present(self):
        for display in catalog.get_all_models().values():
            self.assertIsNotNone(catalog.get_model_info(display), f"no info for {display}")

    def test_coder_tier_maps_to_installed_coder_model(self):
        self.assertEqual(catalog.get_real_model("VRTL-4.coder"), "qwen2.5-coder:1.5b")
        self.assertEqual(catalog.get_display_name("qwen2.5-coder:1.5b"), "VTL-3.3-Pro")
        self.assertTrue(catalog.is_local_model("VRTL-4.coder"))
        info = catalog.get_model_info("VRTL-4.coder")
        self.assertEqual(info["real_model"], "qwen2.5-coder:1.5b")
        self.assertTrue(info["is_local"])
        self.assertFalse(info["is_cloud"])

    def test_raw_engine_names_not_remapped(self):
        self.assertEqual(catalog.get_real_model("qwen3:0.6b"), "qwen3:0.6b")
        self.assertEqual(catalog.get_real_model("qwen2.5-coder:1.5b"), "qwen2.5-coder:1.5b")


class OpenAIProviderTest(unittest.IsolatedAsyncioTestCase):
    def test_local_model_falls_back(self):
        from vierrataleai.providers.openai import OpenAIProvider
        from vierrataleai import config

        config.load()
        config._config["model"] = "VRTL-2.fast"
        provider = OpenAIProvider()
        real = provider._resolve_model("VRTL-2.fast")
        self.assertEqual(real, catalog.get_real_model(catalog.get_default_cloud_model()))
        self.assertTrue(real.startswith("gpt-"))

    def test_cloud_model_verbatim(self):
        from vierrataleai.providers.openai import OpenAIProvider

        provider = OpenAIProvider()
        self.assertEqual(provider._resolve_model("VRTL-8.cloud"), "gpt-4o")


if __name__ == "__main__":
    unittest.main()