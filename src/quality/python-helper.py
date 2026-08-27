import argparse
import ast
import hashlib
import json
import os
import runpy
import sys
import tokenize
import unittest
from io import StringIO


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


TOKEN_MUTATIONS = {
    "True": ("False", "boolean"),
    "False": ("True", "boolean"),
    "None": ("0", "null"),
    "==": ("!=", "equality"),
    "!=": ("==", "equality"),
    ">": (">=", "comparison"),
    ">=": (">", "comparison"),
    "<": ("<=", "comparison"),
    "<=": ("<", "comparison"),
    "and": ("or", "logical"),
    "or": ("and", "logical"),
    "+": ("-", "arithmetic"),
    "-": ("+", "arithmetic"),
    "*": ("/", "arithmetic"),
    "/": ("*", "arithmetic"),
    "//": ("*", "arithmetic"),
    "%": ("*", "arithmetic"),
    "**": ("*", "arithmetic"),
}


def line_offsets(source):
    offsets = [0]
    for index, character in enumerate(source):
        if character == "\n":
            offsets.append(index + 1)
    return offsets


def absolute_offset(offsets, position):
    line, column = position
    return offsets[line - 1] + column


def utf16_offset(source, offset):
    return len(source[:offset].encode("utf-16-le")) // 2


def enclosing_function(functions, line):
    candidates = [node for node in functions if node.lineno <= line <= node.end_lineno]
    return min(candidates, key=lambda node: (node.end_lineno - node.lineno, node.col_offset), default=None)


def unary_token_positions(tree):
    return {(node.lineno, node.col_offset) for node in ast.walk(tree) if isinstance(node, ast.UnaryOp)}


def constant_mutation(token):
    if token.type == tokenize.NUMBER:
        try:
            return ("1" if float(token.string.replace("_", "")) == 0 else "0", "constant")
        except ValueError:
            return None
    if token.type == tokenize.STRING:
        try:
            value = ast.literal_eval(token.string)
        except (SyntaxError, ValueError):
            return None
        if isinstance(value, (str, bytes)) and len(value) > 0:
            return (repr(type(value)()), "constant")
    return None


def mutation_candidates(source, tree):
    tokens = list(tokenize.generate_tokens(StringIO(source).readline))
    unary_positions = unary_token_positions(tree)
    offsets = line_offsets(source)
    candidates = []
    index = 0
    while index < len(tokens):
        token = tokens[index]
        replacement = TOKEN_MUTATIONS.get(token.string) or constant_mutation(token)
        end = token.end
        original = token.string
        if token.string == "is":
            following = tokens[index + 1] if index + 1 < len(tokens) else None
            if following and following.string == "not":
                replacement = ("is", "identity")
                end = following.end
                original = source[absolute_offset(offsets, token.start):absolute_offset(offsets, end)]
                index += 1
            else:
                replacement = ("is not", "identity")
        elif token.string == "not":
            previous = tokens[index - 1].string if index > 0 else None
            following = tokens[index + 1] if index + 1 < len(tokens) else None
            if following and following.string == "in":
                replacement = ("in", "comparison")
                end = following.end
                original = source[absolute_offset(offsets, token.start):absolute_offset(offsets, end)]
                index += 1
            elif previous != "is":
                replacement = ("", "unary")
        elif token.string == "in":
            previous = tokens[index - 1].string if index > 0 else None
            if previous != "not":
                replacement = ("not in", "comparison")
        elif token.string in ("+", "-") and token.start in unary_positions:
            replacement = ("-" if token.string == "+" else "+", "unary")
        if replacement:
            candidates.append((token.start, end, original, replacement[0], replacement[1]))
        index += 1
    return candidates


def generate_mutants(file_path, logical_path, selected_symbols=None):
    with open(file_path, encoding="utf-8") as source_file:
        source = source_file.read()
    tree = ast.parse(source, filename=file_path)
    functions = [node for node in ast.walk(tree) if isinstance(node, FUNCTION_TYPES)]
    offsets = line_offsets(source)
    selected = set(selected_symbols or [])
    mutants = []
    for start_position, end_position, original, replacement, category in mutation_candidates(source, tree):
        symbol = enclosing_function(functions, start_position[0])
        if symbol is None or (selected and symbol.name not in selected):
            continue
        start = absolute_offset(offsets, start_position)
        end = absolute_offset(offsets, end_position)
        mutated = source[:start] + replacement + source[end:]
        try:
            ast.parse(mutated, filename=file_path)
        except SyntaxError:
            continue
        identity = f"{logical_path}:{start_position[0]}:{start_position[1]}:{end_position[0]}:{end_position[1]}:{replacement}"
        mutants.append({
            "id": hashlib.sha256(identity.encode()).hexdigest()[:16],
            "symbol": symbol.name,
            "category": category,
            "mutation": f"{original} -> {replacement}",
            "location": {"line": start_position[0], "column": start_position[1] + 1},
            "start": utf16_offset(source, start),
            "end": utf16_offset(source, end),
            "replacement": replacement,
        })
    return mutants


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
    mutants_parser = subparsers.add_parser("mutants")
    mutants_parser.add_argument("file")
    mutants_parser.add_argument("--logical-path", required=True)
    mutants_parser.add_argument("--symbols", default="[]")
    trace_parser = subparsers.add_parser("trace")
    trace_parser.add_argument("--output", required=True)
    trace_parser.add_argument("--runner", choices=("pytest", "unittest"), required=True)
    trace_parser.add_argument("--targets", required=True)
    args = parser.parse_args()
    if args.command == "analyze":
        json.dump(analyze(args.file), sys.stdout)
        return 0
    if args.command == "mutants":
        json.dump(generate_mutants(args.file, args.logical_path, json.loads(args.symbols)), sys.stdout)
        return 0
    return trace_tests(args.output, args.runner, json.loads(args.targets))


if __name__ == "__main__":
    raise SystemExit(main())
