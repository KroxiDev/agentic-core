"""Pinned mutate4py discovery/splicing; execution belongs to the authoritative runner.

Never invoke the upstream CLI: its runner/defaults cannot represent this project's
wrapper, budget or inconclusive states. See third_party/python/NOTICE.md for MIT attribution.
"""
import base64
import hashlib
import importlib.metadata
import json
from pathlib import Path
import sys


def main():
    request = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    if importlib.metadata.version("mutate4py") != "0.1.4":
        raise ValueError("version")
    from mutate4py._discovery import discover_sites, apply_mutant

    results = []
    for entry in request["sources"]:
        source = base64.b64decode(entry["content"]).decode("utf-8-sig")
        for site in discover_sites(source):
            mutated = apply_mutant(source, site).encode("utf-8")
            if base64.b64decode(entry["content"]).startswith(b"\xef\xbb\xbf"):
                mutated = b"\xef\xbb\xbf" + mutated
            identity = json.dumps([entry["path"], entry["sha256"], site.index, site.desc])
            results.append({"id": hashlib.sha256(identity.encode()).hexdigest(),
                            "file": entry["path"], "line": site.line, "column": site.col,
                            "symbol": site.function_id, "mutation": site.desc,
                            "sourceHash": entry["sha256"],
                            "mutatedHash": hashlib.sha256(mutated).hexdigest(),
                            "content": base64.b64encode(mutated).decode("ascii")})
    print(json.dumps({"engine": "mutate4py", "version": "0.1.4", "mutants": results}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        print(json.dumps({"error": "mutation_generation_failed"}))
        sys.exit(2)
