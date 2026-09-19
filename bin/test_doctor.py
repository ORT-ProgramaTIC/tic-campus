"""bin/doctor.py against tic-host/docs/doctor-contract.md. Stdlib only: `python3 bin/test_doctor.py`."""

from __future__ import annotations

import ast
import json
import os
import re
import sys
import tempfile
import unittest
from collections.abc import Sequence
from pathlib import Path

import doctor
from doctor import Completed, Ctx, Finding, Report, CheckResult


def _running(health: str = "healthy") -> str:
    return json.dumps({"State": {"Status": "running", "Health": {"Status": health}}, "RestartCount": 0})


def _box(execs: dict[str, Completed], *, inspect: dict[str, str] | None = None):
    """A fake box: docker answers, every container runs healthy unless `inspect` says otherwise,
    and `docker exec` answers by the first key its command line starts with."""

    def run(argv: Sequence[str], stdin: str | None = None) -> Completed:
        cmd = " ".join(argv)
        if cmd.startswith("docker version"):
            return Completed(0, "27.0\n", "")
        if cmd.startswith("docker inspect"):
            out = (inspect or {}).get(argv[-1], _running())
            return Completed(0, out, "") if out else Completed(1, "", "No such object")
        for prefix, done in execs.items():
            if cmd.startswith(prefix):
                return done
        return Completed(1, "", f"unexpected: {cmd}")

    return run


def _severities(findings: list[Finding]) -> list[str]:
    return [f.severity for f in findings]


class TestContract(unittest.TestCase):
    def test_container_names_come_from_the_compose_file(self) -> None:
        names = doctor.compose_containers(doctor.ROOT)
        self.assertEqual(names, ("tic-campus-api", "tic-campus-web"))
        self.assertIn(doctor.WEB, names)

    def test_the_file_imports_only_the_standard_library(self) -> None:
        """It runs on the box's python3, where no tic-campus dependency exists."""
        modules: set[str] = set()
        for node in ast.walk(ast.parse(Path(doctor.__file__).read_text("utf-8"))):
            if isinstance(node, ast.Import):
                modules |= {alias.name.split(".")[0] for alias in node.names}
            elif isinstance(node, ast.ImportFrom):
                modules.add((node.module or "").split(".")[0])
        self.assertLessEqual(modules, set(sys.stdlib_module_names) | {"__future__"})

    def test_it_is_executable_because_tic_platform_runs_the_path(self) -> None:
        self.assertTrue(os.access(doctor.__file__, os.X_OK))

    def test_off_the_box_every_check_skips_and_the_document_is_whole(self) -> None:
        def no_docker(argv: Sequence[str], stdin: str | None = None) -> Completed:
            return Completed(1, "", "Cannot connect to the Docker daemon")

        with tempfile.TemporaryDirectory() as root:
            report = doctor.run_all(Ctx(run=no_docker, root=Path(root)))
        doc = json.loads(json.dumps(report.as_json()))
        self.assertEqual(doc["schema_version"], 2)
        self.assertEqual([r["id"] for r in doc["results"]], [c.id for c in doctor.CHECKS])
        for result in doc["results"]:
            self.assertEqual(result["severity"], "skip")
            self.assertEqual(result["scope"], "platform")
            for finding in result["findings"]:
                self.assertEqual(set(finding), {"severity", "scope", "subject", "message", "remedy"})
                self.assertIsInstance(finding["remedy"], str)
                self.assertEqual(set(finding["subject"]), {"kind", "ref", "project", "app"})
        self.assertEqual(doctor.exit_code(report), 0)

    def test_skip_never_competes_and_only_a_platform_fail_exits_1(self) -> None:
        def report(*severities: str) -> Report:
            findings = tuple(Finding(s, "m") for s in severities)  # type: ignore[arg-type]
            return Report(results=(CheckResult("c", "t", doctor._worst_of(findings), findings),))

        self.assertEqual(report("ok", "skip").worst_in("platform"), "ok")
        self.assertEqual(report("skip").worst_in("platform"), "skip")
        self.assertEqual(doctor.exit_code(report("warn", "skip")), 0)
        self.assertEqual(doctor.exit_code(report("fail", "skip")), 1)
        self.assertEqual(doctor.exit_code(report("fail"), scopes=("tenant",)), 0)
        self.assertEqual(doctor.format_report(report("fail"), scopes=("tenant",)), [])

    def test_painted_minus_escapes_is_the_bare_text(self) -> None:
        findings = tuple(Finding(s, f"{s} dijo algo", "hacé esto") for s in ("ok", "warn", "fail", "skip"))  # type: ignore[arg-type]
        report = Report(results=(CheckResult("c", "t", "fail", findings),))
        for render in (doctor.format_report, doctor.format_summary):
            bare = render(report, color=False)
            painted = render(report, color=True)
            self.assertNotEqual(bare, painted)
            self.assertEqual([re.sub(r"\033\[[0-9;]*m", "", line) for line in painted], bare)


class TestChecks(unittest.TestCase):
    def test_containers_health_and_absence(self) -> None:
        inspect = {"tic-campus-web": _running("starting"), "tic-campus-api": _running("unhealthy")}
        found = doctor.check_containers_settled(Ctx(run=_box({}, inspect=inspect), root=doctor.ROOT))
        self.assertEqual(_severities(found), ["fail", "warn"])
        inspect = {"tic-campus-api": ""}
        found = doctor.check_containers_settled(Ctx(run=_box({}, inspect=inspect), root=doctor.ROOT))
        self.assertEqual(_severities(found), ["fail", "ok"])

    def test_web_api_proxy_needs_the_apis_own_answer(self) -> None:
        def proxy(done: Completed) -> list[str]:
            run = _box({"docker exec tic-campus-web wget": done})
            return _severities(doctor.check_web_api_proxy(Ctx(run=run, root=doctor.ROOT)))

        self.assertEqual(proxy(Completed(0, '{"status":"ok"}', "")), ["ok"])
        # nginx's own 502 page: wget exits non-zero and the api never answered.
        self.assertEqual(proxy(Completed(1, "", "wget: server returned error: HTTP/1.1 502")), ["fail"])
        # The SPA shell on a 200 is the api location falling through to try_files.
        self.assertEqual(proxy(Completed(0, "<!doctype html>", "")), ["fail"])


if __name__ == "__main__":
    unittest.main()
