"""Private pytest observer: preserve collection and run coverage in the project Python."""

import json
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
            include=_settings["include"], omit=_settings["omit"],
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
        "root": str(session.config.rootpath),
        "configuration": str(session.config.inipath) if session.config.inipath else None,
        "args": list(session.config.invocation_params.args),
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
        _state["coverage"] = {
            "status": "measured", "backend": "coverage.py", "version": "7.13.4",
            "files": {str(Path(file).resolve()): data for file, data in document["files"].items()},
            "lcov": lcov_path.read_text(encoding="utf-8"),
        }
    except Exception:
        _state["coverage"] = {"status": "error", "code": "coverage_failed", "files": None}
    finally:
        _save()
