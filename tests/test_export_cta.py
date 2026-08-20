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
        self.sections = []
        self._current_section = None
        self._inside_button = False

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if tag == "section" and "section" in attributes.get("class", "").split():
            self._current_section = {"text": [], "button_ids": []}
            self.sections.append(self._current_section)
        if tag == "button" and attributes.get("id") == "btnDownloadAll":
            self.button_attrs = attributes
            self._inside_button = True
        if tag == "button" and self._current_section is not None:
            self._current_section["button_ids"].append(attributes.get("id"))
        elif self._inside_button and tag == "svg":
            self.has_decorative_icon = attributes.get("aria-hidden") == "true"

    def handle_endtag(self, tag):
        if tag == "button" and self._inside_button:
            self._inside_button = False
        elif tag == "section":
            self._current_section = None

    def handle_data(self, data):
        if self._current_section is not None:
            self._current_section["text"].append(data)
        if self._inside_button:
            self.button_text.append(data)


class ExportCallToActionTests(unittest.TestCase):
    def test_export_has_its_own_readable_panel_and_standard_button(self):
        parser = ExportButtonParser()
        parser.feed((ROOT / "index.html").read_text(encoding="utf-8"))

        self.assertGreaterEqual(len(parser.sections), 3)
        section_titles = [
            " ".join("".join(section["text"]).split())
            for section in parser.sections[:3]
        ]
        compact_titles = [title.replace(" ", "") for title in section_titles]
        self.assertIn("SH-01Contents", compact_titles[0])
        self.assertIn("SH-02ExcelExport", compact_titles[1])
        self.assertIn("SH-03Matchsource", compact_titles[2])
        self.assertNotIn("btnDownloadAll", parser.sections[0]["button_ids"])
        self.assertIn("btnDownloadAll", parser.sections[1]["button_ids"])

        self.assertIsNotNone(parser.button_attrs)
        classes = set(parser.button_attrs.get("class", "").split())
        self.assertIn("primary", classes)
        self.assertNotIn("export-cta", classes)
        self.assertEqual(
            parser.button_attrs.get("aria-label"),
            "Export current ACC folder to Excel",
        )
        self.assertEqual(" ".join("".join(parser.button_text).split()), "Export to Excel")
        self.assertTrue(parser.has_decorative_icon)


if __name__ == "__main__":
    unittest.main()
