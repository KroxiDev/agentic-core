"""Private pytest observer: preserve collection and run coverage in the project Python."""

import json
import hashlib
import os
from pathlib import Path
import sys
import uuid

import pytest


_settings = json.loads(Path(os.environ["AGENTIC_CORE_TEST_SETTINGS"]).read_text(encoding="utf-8"))
_report = Path(_settings["temporary"], f"pytest-{uuid.uuid4().hex}.json")
_state = {
    "schemaVersion": 1,
    "interpreter": sys.executable,
    "version": list(sys.version_info[:3]),
    "pytestVersion": pytest.__version__,
    "suite": {"status": "NO_VERIFICADO"},
    "coverage": {"status": "unknown", "files": None},
}
_coverage = None
_phases = {"setup": 0, "call": 0, "teardown": 0}
_failures = []
_root = Path(_settings["projectRoot"]).resolve()
_measured = {str((_root / file).resolve()): file for file in _settings["measured"]}


def _public_path(value):
    if value is None:
        return None
    try:
        relative = Path(value).resolve().relative_to(_root).as_posix()
        if relative == "." or any(file == relative or file.startswith(relative + "/") for file in _settings["inputs"]):
            return relative
    except ValueError:
        pass
    _state["error"] = "isolation_unsupported"
    return None


def _save():
    _report.write_text(json.dumps(_state), encoding="utf-8")


_save()


@pytest.hookimpl(tryfirst=True)
def pytest_load_initial_conftests(early_config, parser, args):
    global _coverage
    _save()
    if (os.path.normcase(os.path.abspath(sys.executable)) !=
            os.path.normcase(os.path.abspath(_settings["interpreter"]))):
        _state["error"] = "interpreter_mismatch"
        _save()
        pytest.exit("El wrapper no usó el intérprete Python seleccionado", returncode=2)
    try:
        # Only the private coverage wheel is exposed, never the tools' site-packages.
        sys.path.insert(0, _settings["coverageWheel"])
        try:
            import coverage
        finally:
            sys.path.remove(_settings["coverageWheel"])
        if not os.path.abspath(coverage.__file__).startswith(_settings["coverageWheel"] + os.sep):
            raise RuntimeError("coverage_conflict")
        _coverage = coverage.Coverage(
            data_file=str(Path(_settings["temporary"], f"data-{uuid.uuid4().hex}")),
            config_file=False, branch=True, timid=True,
            include=list(_measured) or [str(_root / ".no-measured-inputs")],
        )
        _coverage.start()
    except Exception:
        _state["error"] = "coverage_unavailable"
        _save()
        pytest.exit("No se pudo iniciar la cobertura privada", returncode=2)


def pytest_runtest_logreport(report):
    # Collection and fixture coverage do not prove that pytest reached a test call.
    if report.when in _phases:
        _phases[report.when] += 1
    if report.failed:
        # Parameter values and traceback text can contain private runtime data.
        _failures.append({
            "id": hashlib.sha256(report.nodeid.encode("utf-8")).hexdigest(),
            "path": _public_path(report.location[0]),
            "line": report.location[1] + 1,
            "phase": report.when,
        })


def pytest_collection_finish(session):
    _public_path(session.config.rootpath)
    _public_path(session.config.inipath)
    for item in session.items:
        _public_path(item.path)
    if _state.get("error") == "isolation_unsupported":
        _save()
        pytest.exit("La suite usa rutas ajenas a la copia controlada", returncode=2)


@pytest.hookimpl(trylast=True)
def pytest_sessionfinish(session, exitstatus):
    status = "failed"
    if int(exitstatus) == 0:
        status = "passed" if _phases["call"] else "not_executed"
    _state["suite"] = {
        "status": status,
        "exitCode": int(exitstatus),
        "collected": session.testscollected,
        "failed": session.testsfailed,
        "phases": dict(_phases),
        "failures": list(_failures),
        "root": _public_path(session.config.rootpath),
        "configuration": _public_path(session.config.inipath),
    }
    try:
        if _coverage is None:
            return
        _coverage.stop()
        _coverage.save()
        json_path = _report.with_suffix(".coverage.json")
        _coverage.json_report(outfile=str(json_path))
        document = json.loads(json_path.read_text(encoding="utf-8"))
        # Keep LCOV with the private invocation, never overwrite a consumer report.
        lcov_path = Path(_settings["temporary"], _settings["lcovPath"])
        lcov_path.parent.mkdir(parents=True, exist_ok=True)
        _coverage.lcov_report(outfile=str(lcov_path))
        files = {_measured[str(Path(file).resolve())]: data for file, data in document["files"].items()
                 if str(Path(file).resolve()) in _measured}
        # LCOV paths are regenerated from the same allowlist as JSON coverage.
        lcov = []
        allowed = False
        for line in lcov_path.read_text(encoding="utf-8").splitlines():
            if line.startswith("SF:"):
                public = _measured.get(str(Path(line[3:]).resolve()))
                allowed = public is not None
                if allowed:
                    lcov.append("SF:" + public)
            elif allowed:
                lcov.append(line)
        _state["coverage"] = {
            "status": "measured", "backend": "coverage.py", "version": "7.13.4",
            "files": files,
            "lcov": "\n".join(lcov) + "\n",
        }
    except Exception:
        _state["coverage"] = {"status": "error", "code": "coverage_failed", "files": None}
    finally:
        _save()
