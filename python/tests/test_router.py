import unittest

from vierrataleai.utils.router import route_model


class RouterTest(unittest.TestCase):
    def test_file_folder_code_routes_to_coder(self):
        self.assertEqual(route_model("Look at this file and fix it"), "VTL-3.3-Pro")
        self.assertEqual(route_model("create a config file"), "VTL-3.3-Pro")
        self.assertEqual(route_model("show me the diff of my changes"), "VTL-3.3-Pro")
        self.assertEqual(route_model("please fix this bug in app.py"), "VTL-3.3-Pro")
        self.assertEqual(route_model("refactor the folder src"), "VTL-3.3-Pro")

    def test_research_routes_to_reasoning(self):
        self.assertEqual(route_model("explain the difference between react and vue"), "VTL-3.5-Reason")
        self.assertEqual(route_model("what is the capital of france"), "VTL-3.5-Reason")
        self.assertEqual(route_model("research the history of the roman empire"), "VTL-3.5-Reason")
        self.assertEqual(route_model("compare machine learning models"), "VTL-3.5-Reason")

    def test_daily_chat_stays_on_default_flash(self):
        self.assertEqual(route_model("hello, how are you doing today"), "VTL-2.7-Flash")
        self.assertEqual(route_model("tell me a joke"), "VTL-2.7-Flash")
        self.assertEqual(route_model("i like pizza"), "VTL-2.7-Flash")

    def test_slash_commands_and_empty_input_are_not_routed(self):
        self.assertIsNone(route_model("/search python"))
        self.assertIsNone(route_model(""))


if __name__ == "__main__":
    unittest.main()