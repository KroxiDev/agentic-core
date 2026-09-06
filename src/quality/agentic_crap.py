"""Pinned crap4py adapter: execution-scope ownership and attributable coverage."""

import ast
import base64
import copy
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys

try:
    import crap4py
    from crap4py._crap import crap_score
    from crap4py.complexity import cyclomatic_complexity
except ImportError:
    print(json.dumps({"error": "unsupported_crap_engine"}))
    raise SystemExit(2)


class ExecutionBody(ast.NodeTransformer):
    """Keep definition-time expressions; deferred function bodies have their own row."""

    def visit_FunctionDef(self, node):
        expressions = [*node.decorator_list, *node.args.defaults,
                       *(value for value in node.args.kw_defaults if value is not None)]
        return [ast.Expr(value=self.visit(value)) for value in expressions] or [ast.Pass()]

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node):
        # Bounds/defaults of type parameters are lazy; bases and decorators are not.
        node.type_params = []
        return self.generic_visit(node)

    def visit_AnnAssign(self, node):
        if node.value is not None:
            return self.visit(ast.Assign(targets=[node.target], value=node.value))
        if isinstance(node.target, ast.Name):
            return ast.Pass()
        # Without a value, attribute/subscript targets still evaluate their operands.
        node.annotation = ast.Constant(value=None)
        return self.generic_visit(node)

    def visit_TypeAlias(self, node):
        # Binding the alias does not evaluate its value or type parameter expressions.
        return ast.Assign(targets=[node.name], value=ast.Constant(value=None))

    def visit_AsyncFor(self, node):
        # The pinned engine's For rule also describes the branching of async for.
        node = self.generic_visit(node)
        return ast.For(target=node.target, iter=node.iter,
                       body=node.body, orelse=node.orelse, type_comment=None)


def annotation_evaluation(tree, python_version):
    # The private tool's interpreter need not be the interpreter running pytest.
    if not isinstance(python_version, list) or len(python_version) < 2:
        return "unknown"
    if python_version[0] != 3 or type(python_version[1]) is not int or python_version[1] < 11:
        return "unknown"
    if any(isinstance(node, ast.ImportFrom) and node.module == "__future__"
           and any(alias.name == "annotations" for alias in node.names) for node in tree.body):
        return "stringized"
    return "deferred" if python_version[1] >= 14 else "eager"


def function_annotations(node):
    arguments = [*node.args.posonlyargs, *node.args.args, *node.args.kwonlyargs,
                 node.args.vararg, node.args.kwarg]
    values = [arg.annotation for arg in arguments if arg is not None and arg.annotation is not None]
    return [*values, *([node.returns] if node.returns is not None else [])]


def type_parameter_annotations(node):
    return [value for parameter in getattr(node, "type_params", [])
            for field in ("bound", "default_value")
            if (value := getattr(parameter, field, None)) is not None]


def source_lines(node):
    return set(range(node.lineno, node.end_lineno + 1))


def execution_scopes(tree, evaluation):
    module = {"name": "<module>", "kind": "module", "node": tree,
              "line": 1, "endLine": max((getattr(n, "end_lineno", 1) or 1 for n in ast.walk(tree)), default=1)}
    module["lines"] = set(range(1, module["endLine"] + 1))
    scopes = [module]

    def annotations(values, name, mode):
        if values:
            scopes.append({"name": name, "kind": "annotations",
                           "node": ast.Module(body=[ast.Expr(value=value) for value in values], type_ignores=[]),
                           "line": min(value.lineno for value in values),
                           "endLine": max(value.end_lineno for value in values), "evaluation": mode})

    def visit(node, owner, names, block="module"):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)) or type(node).__name__ == "TypeAlias":
            name = ".".join([*names, node.name.id if isinstance(node.name, ast.Name) else node.name])
            parameters = type_parameter_annotations(node)
            annotations(parameters, name + ".__type_params__", "unknown" if evaluation == "unknown" else "deferred")
            for value in parameters:
                owner["lines"] -= source_lines(value) - {node.lineno}
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            lines = set(range(node.body[0].lineno, node.end_lineno + 1))
            owner["lines"] -= lines
            current = {"name": ".".join([*names, node.name]), "kind": "function",
                       "node": node, "line": node.lineno, "endLine": node.end_lineno,
                       "lines": lines, "sharedHeader": node.body[0].lineno == node.lineno}
            scopes.append(current)
            annotations(function_annotations(node), current["name"] + ".__annotations__", evaluation)
            for child in node.body:
                visit(child, current, [*names, node.name], "function")
        elif isinstance(node, ast.AnnAssign):
            # Local annotations are never evaluated or stored. Non-simple targets
            # are not evaluated in deferred/stringized mode either.
            if block != "function" and (node.simple or evaluation in ("eager", "unknown")):
                target = node.target.id if isinstance(node.target, ast.Name) else "<target>"
                annotations([node.annotation], ".".join([*names, target, "__annotations__"]), evaluation)
            retained = {node.lineno} | source_lines(node.target)
            if node.value is not None:
                retained |= source_lines(node.value)
                visit(node.value, owner, names, block)
            owner["lines"] -= source_lines(node.annotation) - retained
            visit(node.target, owner, names, block)
        elif type(node).__name__ == "TypeAlias":
            annotations([node.value], name + ".__value__", "unknown" if evaluation == "unknown" else "deferred")
            owner["lines"] -= source_lines(node.value) - {node.lineno}
        else:
            context = [*names, node.name] if isinstance(node, ast.ClassDef) else names
            for child in ast.iter_child_nodes(node):
                visit(child, owner, context, "class" if isinstance(node, ast.ClassDef) else block)

    for node in tree.body:
        visit(node, module, [])
    return scopes


def normalized_body(scope):
    wrapper = ast.parse("def measured_scope():\n    pass\n")
    wrapper.body[0].body = copy.deepcopy(scope["node"].body)
    transformer = ExecutionBody()
    # Transform the body, not the synthetic root function itself.
    holder = transformer.visit(ast.Module(body=wrapper.body[0].body, type_ignores=[]))
    wrapper.body[0].body = holder.body or [ast.Pass()]
    return ast.fix_missing_locations(wrapper)


def executable_body(body):
    return any(not isinstance(node, ast.Pass) and not (
        isinstance(node, ast.Expr) and isinstance(node.value, ast.Constant)
        and isinstance(node.value.value, str)) for node in body)


def coverage_for(scope, file, coverage):
    data = (coverage.get("files") or {}).get(file)
    if data is None:
        known = coverage.get("status") == "measured" or coverage.get("loadedFiles") == []
        return {"status": "not_loaded" if known else "attribution_missing", "fraction": None}
    if scope.get("sharedHeader"):
        return {"status": "attribution_ambiguous", "fraction": None}
    try:
        executed = set(data["executed_lines"])
        missing = set(data["missing_lines"])
        if executed & missing or any(type(n) is not int or n < 1 for n in executed | missing):
            raise ValueError("lines")
        covered_lines = executed & scope["lines"]
        missing_lines = missing & scope["lines"]
        if not covered_lines and not missing_lines:
            raise ValueError("no attributable statements")
        branches = []
        for key in ["executed_branches", "missing_branches"]:
            records = data[key]
            if any(len(record) != 2 or any(type(n) is not int for n in record) for record in records):
                raise ValueError("branches")
            branches.append({tuple(record) for record in records if record[0] in scope["lines"]})
        taken, untaken = branches
        if taken & untaken:
            raise ValueError("branch overlap")
        total = len(taken | untaken)
        fraction = len(taken) / total if total else len(covered_lines) / len(covered_lines | missing_lines)
        return {"status": "zero" if fraction == 0 else "measured", "fraction": fraction,
                "basis": "branches" if total else "statements", "executedLines": sorted(covered_lines),
                "missingLines": sorted(missing_lines), "coveredBranches": len(taken), "totalBranches": total}
    except (KeyError, TypeError, ValueError):
        return {"status": "attribution_missing", "fraction": None}


def analyze_file(entry, coverage, limit, python_version):
    file = entry["path"]
    common = {"file": file, "limit": limit, "sourceHash": entry["sha256"]}
    if entry["kind"] != "measured_code":
        return [{**common, "line": 1, "status": "NO_VERIFICADO", "code": "unsupported_language", "value": None}]
    try:
        tree = ast.parse(base64.b64decode(entry["content"]), filename=file)
    except (SyntaxError, ValueError) as error:
        return [{**common, "line": getattr(error, "lineno", None) or 1,
                 "status": "NO_VERIFICADO", "code": "unsupported_syntax", "value": None}]
    rows = []
    occurrences = {}
    for scope in execution_scopes(tree, annotation_evaluation(tree, python_version)):
        normalized = normalized_body(scope)
        if scope["kind"] == "module" and not executable_body(normalized.body[0].body):
            continue
        key = (scope["kind"], scope["name"])
        occurrences[key] = occurrences.get(key, 0) + 1
        identifier = json.dumps([file, *key, occurrences[key]], ensure_ascii=True)
        row = {**common, "id": hashlib.sha256(identifier.encode()).hexdigest(),
               **{key: scope[key] for key in ["name", "kind", "line", "endLine"]},
               "fingerprint": hashlib.sha256(ast.dump(normalized).encode()).hexdigest()}
        if scope["kind"] == "annotations":
            # Declaration lines conflate eager execution and annotation scopes.
            # Annotations, alias values and type parameters can run on introspection.
            # Keep their own identity and limitation instead of inventing coverage.
            rows.append({**row, "evaluation": scope["evaluation"], "status": "NO_VERIFICADO",
                         "code": "annotation_coverage_unsupported", "value": None,
                         "coverage": {"status": "attribution_missing", "fraction": None}})
            continue
        if any(isinstance(node, ast.GeneratorExp) for node in ast.walk(normalized)):
            # Creation executes the first iterable, but not the deferred body.
            # Line coverage cannot separate them, including on a single line.
            rows.append({**row, "status": "NO_VERIFICADO", "code": "generator_coverage_unsupported",
                         "value": None, "coverage": {"status": "attribution_missing", "fraction": None}})
            continue
        if any(isinstance(node, ast.Lambda) for node in ast.walk(normalized)):
            rows.append({**row, "status": "NO_VERIFICADO", "code": "unsupported_construct", "value": None})
            continue
        cc = cyclomatic_complexity(ast.unparse(normalized))[0].cc
        attributed = coverage_for(scope, file, coverage)
        value = crap_score(cc, attributed["fraction"]) if attributed["fraction"] is not None else None
        rows.append({**row, "complexity": cc, "coverage": attributed, "value": value,
                     "status": "NO_VERIFICADO" if value is None else "approved" if value <= limit else "rejected",
                     "code": "coverage_" + attributed["status"] if value is None else "within_limit" if value <= limit else "crap_limit_exceeded"})
    return rows or [{**common, "line": 1, "status": "NO_APLICA", "code": "no_executable_code", "value": None}]


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    version = importlib.metadata.version("crap4py")
    if version != "0.1.1":
        print(json.dumps({"error": "unsupported_crap_engine"}))
        return 2
    package = Path(crap4py.__file__).parent
    engine_hash = hashlib.sha256(b"".join(file.name.encode() + file.read_bytes() for file in sorted(package.glob("*.py")))).hexdigest()
    rows = []
    for entry in request["sources"]:
        try:
            rows.extend(analyze_file(entry, request["coverage"], request["limit"], request.get("pythonVersion")))
        except Exception:
            rows.append({"file": entry["path"], "line": 1, "limit": request["limit"],
                         "status": "NO_VERIFICADO", "code": "crap_analysis_failed", "value": None})
    print(json.dumps({"engine": {"name": "crap4py", "version": version, "sha256": engine_hash, "adapter": "execution-scopes-v3"}, "details": rows}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Parser paths, source snippets and exception messages are never public diagnostics.
        print(json.dumps({"error": "crap_adapter_failed"}))
        raise SystemExit(2)
