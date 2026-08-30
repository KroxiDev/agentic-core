import importlib.util
import sys
import tempfile
import unittest
from pathlib import Path


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
HELPER_PATH = REPOSITORY_ROOT / "src" / "quality" / "python-helper.py"
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("agentic_core_python_helper", HELPER_PATH)
HELPER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(HELPER)


class PythonHelperTests(unittest.TestCase):
    def write_source(self, directory, content):
        source_path = Path(directory) / "subject.py"
        source_path.write_text(content, encoding="utf-8")
        return source_path

    def test_analysis_reports_containers_complexity_and_body_stable_signature(self):
        with tempfile.TemporaryDirectory(prefix="agentic-core-python-") as directory:
            original = self.write_source(
                directory,
                "def choose(value):\n"
                "    if value and value > 0:\n"
                "        return value\n"
                "    return 0\n\n"
                "class Greeter:\n"
                "    def choose(self, value):\n"
                "        return 'hello' if value else ''\n",
            )
            before = HELPER.analyze(original)
            self.write_source(
                directory,
                "def choose(value):\n"
                "    if value and value > 0:\n"
                "        return value + 1\n"
                "    return -1\n\n"
                "class Greeter:\n"
                "    def choose(self, value):\n"
                "        return 'hi' if value else ''\n",
            )
            after = HELPER.analyze(original)

            module_choose = next(item for item in before if item["qualifiedName"] == "choose")
            method_choose = next(item for item in before if item["qualifiedName"] == "Greeter.choose")
            after_module = next(item for item in after if item["qualifiedName"] == "choose")
            self.assertEqual(module_choose["container"], "<module>")
            self.assertEqual(module_choose["declarationKind"], "function")
            self.assertEqual(module_choose["complexity"], 3)
            self.assertEqual(method_choose["container"], "Greeter")
            self.assertEqual(method_choose["declarationKind"], "method")
            self.assertEqual(method_choose["complexity"], 2)
            self.assertEqual(module_choose["disambiguator"], after_module["disambiguator"])
            self.assertNotEqual(module_choose["ast"], after_module["ast"])

    def test_mutants_are_deterministic_and_respect_explicit_symbol_selection(self):
        with tempfile.TemporaryDirectory(prefix="agentic-core-python-") as directory:
            source = self.write_source(
                directory,
                "def alpha(value):\n"
                "    return value + 1 if value == 0 else value - 1\n\n"
                "def beta(value):\n"
                "    return True and value > 0\n",
            )
            first = HELPER.generate_mutants(source, "subject.py", ["alpha"])
            second = HELPER.generate_mutants(source, "subject.py", ["alpha"])

            self.assertEqual(first, second)
            self.assertTrue(first)
            self.assertEqual({mutant["symbol"] for mutant in first}, {"alpha"})
            self.assertTrue({"arithmetic", "equality", "constant"}.issubset(
                {mutant["category"] for mutant in first}
            ))
            self.assertTrue(all(len(mutant["id"]) == 16 for mutant in first))


if __name__ == "__main__":
    unittest.main()
