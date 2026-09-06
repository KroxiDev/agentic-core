import importlib.util
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "agentic_dry", Path(__file__).resolve().parents[1] / "src/quality/agentic_dry.py")
helper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(helper)


class DryPreparationTests(unittest.TestCase):
    def prepare(self, content, min_lines=4, min_nodes=20):
        with tempfile.TemporaryDirectory() as root:
            file = Path(root) / "source.py"
            file.write_bytes(content)
            result = helper.prepare_source(str(file), min_lines, min_nodes)
            return result, file.read_bytes()

    def test_comments_cannot_exclude_but_strings_and_encoding_survive(self):
        content = ("# coding: latin-1\n# dry4python: ignore-file\n"
                   "text = '# dry4python: ignore café'\n"
                   "def first(value):\n    return value + 1\n").encode("latin-1")
        result, prepared = self.prepare(content)
        self.assertNotIn(b"# dry4python: ignore-file", prepared)
        self.assertIn("'# dry4python: ignore café'".encode("latin-1"), prepared)
        self.assertEqual(content.count(b"\n"), prepared.count(b"\n"))
        self.assertEqual(result["functions"][0]["references"], ["return value + 1"])

    def test_body_identity_ignores_location_but_detects_behavior(self):
        source = b"@decorator\ndef first(value):\n    return value + 1\n"
        first, _ = self.prepare(source)
        moved, _ = self.prepare(b"# moved\n" + source + b"OTHER_SETTING = 17\n")
        changed, _ = self.prepare(source.replace(b"+ 1", b"+ 2"))
        self.assertEqual(first["functions"][0]["startLine"], 1)
        self.assertEqual(first["functions"][0]["sha256"], moved["functions"][0]["sha256"])
        self.assertNotEqual(first["functions"][0]["sha256"], changed["functions"][0]["sha256"])

    def test_uncovered_class_execution_and_explicit_size_limits(self):
        source = b"class Example:\n    result = []\n    for value in range(10):\n        if value > 0:\n            result.append(value + 1)\n        else:\n            result.append(value - 1)\n"
        result, _ = self.prepare(source)
        self.assertEqual(result["issues"][0]["code"], "dry_procedural_unsupported")
        self.assertEqual(result["issues"][0]["startLine"], 2)
        below_limit, _ = self.prepare(source, min_nodes=1000)
        self.assertEqual(below_limit["issues"], [])

    def test_syntax_error_has_location_without_source_text(self):
        result, _ = self.prepare(b"def malformed(:\n")
        self.assertFalse(result["scannable"])
        self.assertEqual(result["issues"], [{"code": "dry_syntax_unsupported", "startLine": 1}])

    def test_every_statement_kind_has_a_compact_resolution_reference(self):
        for statement in ["assert value > 0", "del value['key']", "result: int = value",
                          "return '" + "x" * 200 + "'", "if value:\n        pass"]:
            with self.subTest(statement=statement[:30]):
                result, _ = self.prepare(("def first(value):\n    " + statement + "\n").encode())
                references = result["functions"][0]["references"]
                self.assertTrue(references)
                self.assertTrue(all(len(reference) <= 120 for reference in references))


if __name__ == "__main__":
    unittest.main()
