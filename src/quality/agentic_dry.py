"""Prepare isolated DRY inputs without changing the pinned detection engine."""

import ast
import hashlib
import io
import json
from pathlib import Path
import re
import sys
import tokenize


def uncovered_statements(tree):
    """The engine visits function bodies, but not module/class execution."""
    for statement in tree.body:
        if isinstance(statement, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if isinstance(statement, ast.ClassDef):
            yield from uncovered_statements(statement)
        elif not isinstance(statement, (ast.Import, ast.ImportFrom, ast.Pass)):
            if not (isinstance(statement, ast.Expr)
                    and isinstance(statement.value, ast.Constant)
                    and isinstance(statement.value.value, str)):
                yield statement


def prepare_source(filename, min_lines, min_nodes):
    file = Path(filename)
    try:
        with tokenize.open(file) as stream:
            encoding = stream.encoding
            text = stream.read()
        tree = ast.parse(text, filename=filename, type_comments=True)
    except (SyntaxError, UnicodeError, LookupError) as error:
        return {"file": filename, "functions": [], "issues": [{
            "code": "dry_syntax_unsupported", "startLine": getattr(error, "lineno", None) or 1,
        }], "scannable": False}

    lines = text.splitlines(keepends=True)
    # Remove only comments interpreted by dry4python; preserve strings and line numbers.
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.COMMENT and "dry4python" in token.string.lower():
            row, column = token.start
            lines[row - 1] = lines[row - 1][:column] + re.sub(
                "dry4python", "dry_policy", lines[row - 1][column:], flags=re.IGNORECASE)
    file.write_bytes("".join(lines).encode(encoding))

    functions = []
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        references = {ast.unparse(item).splitlines()[0][:120]
                      for statement in node.body for item in ast.walk(statement)
                      if isinstance(item, ast.stmt)}
        functions.append({
            "startLine": min([node.lineno, *[d.lineno for d in node.decorator_list]]),
            "endLine": node.end_lineno,
            "sha256": hashlib.sha256(ast.dump(node, include_attributes=False).encode()).hexdigest(),
            "references": sorted(references),
        })
    statements = list(uncovered_statements(tree))
    issues = []
    if statements:
        start = min(node.lineno for node in statements)
        end = max(node.end_lineno for node in statements)
        # Apply the same explicit size floors: a lone literal setting is below DRY scope.
        nodes = sum(1 for statement in statements for _ in ast.walk(statement))
        if end - start + 1 >= min_lines and nodes >= min_nodes:
            issues.append({"code": "dry_procedural_unsupported", "startLine": start, "endLine": end})
    return {"file": filename, "functions": functions, "issues": issues, "scannable": True}


if __name__ == "__main__":
    print(json.dumps([prepare_source(file, int(sys.argv[1]), int(sys.argv[2]))
                      for file in sys.argv[3:]], ensure_ascii=True))
