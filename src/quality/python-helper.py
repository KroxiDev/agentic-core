import argparse
import ast
import json
import os
import runpy
import sys
import unittest


FUNCTION_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef)


def is_default_case(case):
    pattern = case.pattern
    return isinstance(pattern, ast.MatchAs) and pattern.pattern is None and pattern.name is None


class Complexity(ast.NodeVisitor):
    def __init__(self, root):
        self.root = root
        self.value = 1

    def visit_FunctionDef(self, node):
        if node is self.root:
            self.generic_visit(node)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_Lambda(self, node):
        return

    def visit_If(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_For(self, node):
        self.value += 1
        self.generic_visit(node)

    visit_AsyncFor = visit_For

    def visit_While(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_ExceptHandler(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_IfExp(self, node):
        self.value += 1
        self.generic_visit(node)

    def visit_BoolOp(self, node):
        self.value += max(0, len(node.values) - 1)
        self.generic_visit(node)

    def visit_Match(self, node):
        self.value += sum(not is_default_case(case) for case in node.cases)
        self.generic_visit(node)

    def visit_comprehension(self, node):
        self.value += 1 + len(node.ifs)
        self.generic_visit(node)


class ExecutableLines(ast.NodeVisitor):
    def __init__(self, root):
        self.root = root
        self.lines = set()

    def visit_FunctionDef(self, node):
        if node is self.root:
            for statement in node.body:
                self.visit(statement)

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        return

    def visit_Lambda(self, node):
        return

    def generic_visit(self, node):
        if isinstance(node, FUNCTION_TYPES) and node is not self.root:
            return
        if isinstance(node, ast.stmt) and not isinstance(node, (ast.Pass, ast.Global, ast.Nonlocal)):
            self.lines.add(node.lineno)
        super().generic_visit(node)


def analyze(file_path):
    with open(file_path, encoding="utf-8") as source_file:
        source = source_file.read()
    tree = ast.parse(source, filename=file_path)
    symbols = []
    for node in ast.walk(tree):
        if not isinstance(node, FUNCTION_TYPES):
            continue
        complexity = Complexity(node)
        complexity.visit(node)
        executable = ExecutableLines(node)
        executable.visit(node)
        symbols.append({
            "name": node.name,
            "startLine": node.lineno,
            "endLine": node.end_lineno,
            "complexity": complexity.value,
            "executableLines": sorted(executable.lines),
            "ast": ast.dump(node, annotate_fields=True, include_attributes=False),
        })
    symbols.sort(key=lambda symbol: (symbol["startLine"], symbol["name"]))
    return symbols


def run_tests(runner):
    project_root = os.getcwd()
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    if runner == "pytest":
        original_argv = sys.argv
        sys.argv = ["pytest", "-q"]
        try:
            try:
                runpy.run_module("pytest", run_name="__main__")
            except SystemExit as error:
                return int(error.code or 0)
            return 0
        finally:
            sys.argv = original_argv
    start_directory = "tests" if os.path.isdir("tests") else "."
    suite = unittest.defaultTestLoader.discover(start_directory, pattern="test*.py")
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    return 0 if result.wasSuccessful() else 1


def trace_tests(output, runner, targets):
    normalized = {os.path.normcase(os.path.realpath(target)) for target in targets}
    covered = {target: set() for target in normalized}
    attributable = set()
    filenames = {}

    def tracer(frame, event, _argument):
        raw_path = frame.f_code.co_filename
        file_path = filenames.get(raw_path)
        if file_path is None:
            file_path = os.path.normcase(os.path.realpath(raw_path))
            filenames[raw_path] = file_path
        if file_path in normalized:
            attributable.add(file_path)
            if event == "line":
                covered[file_path].add(frame.f_lineno)
        return tracer

    sys.settrace(tracer)
    try:
        code = run_tests(runner)
    finally:
        sys.settrace(None)
        with open(output, "w", encoding="utf-8") as output_file:
            json.dump({
                "attributable": sorted(attributable),
                "covered": {target: sorted(lines) for target, lines in covered.items() if target in attributable},
            }, output_file)
    return code


def main():
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    analyze_parser = subparsers.add_parser("analyze")
    analyze_parser.add_argument("file")
    trace_parser = subparsers.add_parser("trace")
    trace_parser.add_argument("--output", required=True)
    trace_parser.add_argument("--runner", choices=("pytest", "unittest"), required=True)
    trace_parser.add_argument("--targets", required=True)
    args = parser.parse_args()
    if args.command == "analyze":
        json.dump(analyze(args.file), sys.stdout)
        return 0
    return trace_tests(args.output, args.runner, json.loads(args.targets))


if __name__ == "__main__":
    raise SystemExit(main())
