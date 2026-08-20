from html.parser import HTMLParser
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[1]


class ExportButtonParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.button_attrs = None
        self.button_text = []
        self.has_decorative_icon = False
        self._inside_button = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "button" and attributes.get("id") == "btnDownloadAll":
            self.button_attrs = attributes
            self._inside_button = True
        elif self._inside_button and tag == "svg":
            self.has_decorative_icon = attributes.get("aria-hidden") == "true"

    def handle_endtag(self, tag):
        if tag == "button" and self._inside_button:
            self._inside_button = False

    def handle_data(self, data):
        if self._inside_button:
            self.button_text.append(data)


class ExportCallToActionTests(unittest.TestCase):
    def test_export_button_is_a_prominent_accessible_call_to_action(self):
        parser = ExportButtonParser()
        parser.feed((ROOT / "index.html").read_text(encoding="utf-8"))

        self.assertIsNotNone(parser.button_attrs)
        classes = set(parser.button_attrs.get("class", "").split())
        self.assertIn("primary", classes)
        self.assertIn("export-cta", classes)
        self.assertEqual(
            parser.button_attrs.get("aria-label"),
            "Export current ACC folder to Excel",
        )
        self.assertEqual(" ".join("".join(parser.button_text).split()), "Export to Excel")
        self.assertTrue(parser.has_decorative_icon)


if __name__ == "__main__":
    unittest.main()
