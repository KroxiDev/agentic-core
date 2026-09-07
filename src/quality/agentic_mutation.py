"""Pinned mutate4py discovery/splicing; execution belongs to the authoritative runner.

Never invoke the upstream CLI: its runner/defaults cannot represent this project's
wrapper, budget or inconclusive states. See third_party/python/NOTICE.md for MIT attribution.
"""
import ast
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def syntax_hash(source):
    tree = ast.parse(source)
    normalized = ast.dump(tree, annotate_fields=True, include_attributes=False)
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if importlib.metadata.version("mutate4py") != "0.1.4":
        raise ValueError("version")
    from mutate4py._discovery import discover_sites, apply_mutant

    results = []
    for entry in request["sources"]:
        source = base64.b64decode(entry["content"]).decode("utf-8-sig")
        source_syntax_hash = syntax_hash(source)
        for site in discover_sites(source):
            mutated_source = apply_mutant(source, site)
            mutated = mutated_source.encode("utf-8")
            if base64.b64decode(entry["content"]).startswith(b"\xef\xbb\xbf"):
                mutated = b"\xef\xbb\xbf" + mutated
            identity = json.dumps([entry["path"], entry["sha256"], site.index, site.desc])
            mutated_hash = hashlib.sha256(mutated).hexdigest()
            result = {"id": hashlib.sha256(identity.encode()).hexdigest(),
                            "file": entry["path"], "line": site.line, "column": site.col,
                            "endLine": site.end_line, "endColumn": site.end_col,
                            "symbol": site.function_id, "mutation": site.desc,
                            "sourceHash": entry["sha256"],
                            "mutatedHash": mutated_hash,
                            "content": base64.b64encode(mutated).decode("ascii")}
            try:
                mutated_syntax_hash = syntax_hash(mutated_source)
            except SyntaxError:
                mutated_syntax_hash = None
            if mutated_hash != entry["sha256"] and mutated_syntax_hash == source_syntax_hash:
                result["staticEquivalence"] = {
                    "kind": "python_ast",
                    "sourceHash": entry["sha256"],
                    "mutatedHash": mutated_hash,
                    "astHash": source_syntax_hash,
                }
            results.append(result)
    print(json.dumps({"engine": "mutate4py", "version": "0.1.4", "mutants": results}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "mutation_generation_failed"}))
        sys.exit(2)
