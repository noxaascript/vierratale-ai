import unittest

from vierrataleai.utils.intents import detect_intent, extract_search_topic


class IntentTest(unittest.TestCase):
    def test_file_requests_stay_in_chat(self):
        self.assertEqual(detect_intent("Can you create a config file?"), "chat")
        self.assertEqual(detect_intent("Please write a file called hello.txt"), "chat")
        self.assertEqual(detect_intent("Make a new folder called src"), "chat")
        self.assertEqual(detect_intent("Generate a python script for me"), "chat")
        self.assertEqual(detect_intent("build a project for me"), "chat")

    def test_story_write_requests_search_the_subject(self):
        self.assertEqual(detect_intent("Write me a story about Malin Kundang in a txt file"), "knowledge")
        self.assertEqual(detect_intent("write me a story about malin kundang in a txt file"), "knowledge")

    def test_topic_extraction_uses_subject_not_sentence(self):
        self.assertEqual(
            extract_search_topic("Write me a story about Malin Kundang in a txt file"),
            "Malin Kundang",
        )
        self.assertEqual(extract_search_topic("tell me the story of the phoenix"), "the phoenix")
        self.assertEqual(
            extract_search_topic(
                "tell me a story about Malin Kundang from indonesia and write it in txt/json format file"
            ),
            "Malin Kundang from indonesia",
        )
        self.assertIsNone(extract_search_topic("Who is Cristiano Ronaldo?"))
        self.assertIsNone(extract_search_topic("hello there"))

    def test_any_story_subject_is_recognized(self):
        self.assertEqual(
            extract_search_topic("tell me about timun mas"), "timun mas"
        )
        self.assertEqual(
            extract_search_topic("write the legend of roro jonggrang into a txt file"),
            "roro jonggrang",
        )
        self.assertEqual(
            extract_search_topic("narrate the tale of bawang putih?"), "bawang putih"
        )
        self.assertEqual(
            extract_search_topic("tell me the story of sangkuriang from indonesia"),
            "sangkuriang from indonesia",
        )
        self.assertEqual(
            detect_intent("write the legend of roro jonggrang into a txt file"),
            "knowledge",
        )
        self.assertEqual(detect_intent("narrate the tale of bawang putih"), "knowledge")
        self.assertEqual(detect_intent("tell me about timun mas"), "knowledge")
        self.assertEqual(
            detect_intent("tell me about timun mas and save it to a file"), "knowledge"
        )
        self.assertEqual(
            detect_intent("The legend of Timun Mas from indonesia"), "knowledge"
        )
        self.assertEqual(detect_intent("Can you create a config file?"), "chat")

    def test_informational_questions_trigger_search(self):
        self.assertEqual(detect_intent("How do I create a file?"), "knowledge")
        self.assertEqual(detect_intent("What is a json file?"), "knowledge")
        self.assertEqual(detect_intent("Why is my file empty?"), "knowledge")
        self.assertEqual(detect_intent("What is the weather today?"), "knowledge")

    def test_greetings_are_answered_instantly(self):
        self.assertEqual(detect_intent("hey"), "greeting")
        self.assertEqual(detect_intent("hello"), "greeting")
        self.assertEqual(detect_intent("good morning"), "greeting")
        self.assertEqual(detect_intent("hello there"), "chat")

    def test_specific_topic_and_story_of_queries_trigger_search(self):
        self.assertEqual(detect_intent("Malin Kundang from indonesia"), "knowledge")
        self.assertEqual(detect_intent("The legend of Maung from vietnam"), "knowledge")
        self.assertEqual(detect_intent("tell me the story of the phoenix"), "knowledge")
        self.assertEqual(detect_intent("tell me a story about the phoenix"), "knowledge")
        self.assertEqual(detect_intent("I like pizza"), "chat")

    def test_generic_story_requests_stay_in_chat(self):
        self.assertEqual(detect_intent("tell me a story"), "chat")
        self.assertEqual(detect_intent("hello there"), "chat")


if __name__ == "__main__":
    unittest.main()