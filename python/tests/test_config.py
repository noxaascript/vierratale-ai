import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from vierrataleai import config


class ConfigModelMemoryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        cfg_file = Path(self.tmp.name) / "config.json"
        self.patcher = patch.object(config, "_config_file", lambda: cfg_file)
        self.patcher.start()
        config._config = None

    def tearDown(self):
        self.patcher.stop()
        self.tmp.cleanup()

    def test_effective_model_defaults(self):
        config.load()
        self.assertEqual(config.get_effective_model("cortex"), "VTL-2.7-Flash")

    def test_legacy_names_are_canonicalized(self):
        config.load()
        config.set_provider_model("cortex", "vierratale-pro")
        self.assertEqual(config.get_effective_model("cortex"), "VTL-3.7-Ultra")
        config._config["model"] = "vierratale-fast"
        self.assertEqual(config.get_effective_model("openai"), "VTL-2.7-Flash")

    def test_provider_model_persists(self):
        config.load()
        config.set_provider_model("cortex", "VRTL-6.pro")
        config._config = None  # simulate reload from disk
        self.assertEqual(config.get_effective_model("cortex"), "VTL-3.7-Ultra")
        # different provider unaffected
        self.assertEqual(config.get_effective_model("openai"), "VTL-2.7-Flash")


if __name__ == "__main__":
    unittest.main()
