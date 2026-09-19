#!/usr/bin/env python3
"""tic-campus's own diagnosis, in the shape DEPLOY-CONVENTIONS.md §8 asks for.

Runs on the box, as root, with no virtualenv and no Node: tic-campus's runtime lives inside
two containers, and what this looks at — the docker socket, a container's state — is what
a process inside them cannot see. `python3 bin/doctor.py`, and tic-platform's
`bin/tic-doctor` runs exactly that with `--json`.

The wire format is tic-host's (`tic-host/docs/doctor-contract.md`, `schema_version: 2`).
The report layer below is MEV's `bin/doctor.py` (itself tic-auth's), copied rather than
shared: the family shares a contract, not a library. What it checks, and what it leaves to
tic-platform, is the README's "Doctor" section.

Two rules are load-bearing rather than stylistic. A check `title` is a noun phrase, never an
assertion — under `[fail]` an assertion says the opposite of what happened. And every
`message` is whole on the line of its marker, so `grep '^\\[fail\\]'` returns sentences.
`skip` is the absence of an answer, never a mild failure, and no `worst` ever counts it.
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import subprocess
import sys
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Literal, cast

SCHEMA_VERSION = 2

Severity = Literal["ok", "warn", "fail", "skip"]
Scope = Literal["platform", "tenant"]
SubjectKind = Literal["host", "project", "app", "container", "network", "origin"]

# `skip` ranks lowest and is filtered out before any comparison, so forty un-run checks can
# never read as forty passing ones.
_SEVERITY_RANK: dict[str, int] = {"skip": 0, "ok": 1, "warn": 2, "fail": 3}

ALL_SCOPES: tuple[Scope, ...] = ("platform", "tenant")

# tic-campus hosts nothing, so every finding is `platform`. The field is emitted anyway so the
# aggregator never has to know which stack is which.
STACK_SCOPE: Scope = "platform"

# Resolved from this file, never the cwd: tic-platform runs this from its own directory.
ROOT = Path(__file__).resolve().parents[1]
WEB = "tic-campus-web"
API = "tic-campus-api"

_CONTAINER_NAME = re.compile(r"^\s*container_name:\s*(\S+)\s*$", re.M)


def compose_containers(root: Path) -> tuple[str, ...]:
    """The pinned `container_name:`s, read from the compose file rather than listed twice."""
    return tuple(_CONTAINER_NAME.findall((root / "docker-compose.yml").read_text("utf-8")))


# ---------------------------------------------------------------------------- the shape


@dataclass(frozen=True)
class Subject:
    """What a finding is about. Never what its verdict is — that is `scope`."""

    kind: SubjectKind = "host"
    ref: str = "host"

    def as_json(self) -> dict[str, Any]:
        return {"kind": self.kind, "ref": self.ref, "project": None, "app": None}

    @classmethod
    def container(cls, ref: str) -> Subject:
        return cls(kind="container", ref=ref)


HOST = Subject()


@dataclass(frozen=True)
class Finding:
    severity: Severity
    message: str
    remedy: str = ""  # never None: a consumer testing `remedy != ""` would print "→ null"
    subject: Subject = HOST
    scope: Scope = STACK_SCOPE

    def as_json(self) -> dict[str, Any]:
        return {
            "severity": self.severity,
            "scope": self.scope,
            "subject": self.subject.as_json(),
            "message": self.message,
            "remedy": self.remedy,
        }


@dataclass(frozen=True)
class CheckResult:
    id: str
    title: str
    severity: Severity
    findings: tuple[Finding, ...]
    scope: Scope = STACK_SCOPE

    def as_json(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "scope": self.scope,
            "severity": self.severity,
            "findings": [f.as_json() for f in self.findings],
        }


def _worst_of(findings: Sequence[Finding]) -> Severity:
    answered = [f.severity for f in findings if f.severity != "skip"]
    if answered:
        return cast(Severity, max(answered, key=lambda s: _SEVERITY_RANK[s]))
    return "skip" if findings else "ok"


@dataclass(frozen=True)
class Report:
    schema_version: int = SCHEMA_VERSION
    generated_at: float = 0.0
    duration_s: float = 0.0
    results: tuple[CheckResult, ...] = ()

    def findings(self, scope: Scope | None = None) -> list[Finding]:
        return [
            f for r in self.results for f in r.findings if scope is None or f.scope == scope
        ]

    def worst_in(self, scope: Scope | None = None) -> Severity:
        return _worst_of(self.findings(scope))

    def counts(self, scope: Scope | None = None) -> dict[str, int]:
        tally = {"ok": 0, "warn": 0, "fail": 0, "skip": 0}
        for finding in self.findings(scope):
            tally[finding.severity] += 1
        return tally

    def as_json(self) -> dict[str, Any]:
        return {
            "schema_version": self.schema_version,
            "generated_at": self.generated_at,
            "duration_s": self.duration_s,
            "results": [r.as_json() for r in self.results],
        }


def ok(message: str, *, subject: Subject = HOST) -> Finding:
    return Finding("ok", message, "", subject)


def warn(message: str, *, remedy: str = "", subject: Subject = HOST) -> Finding:
    return Finding("warn", message, remedy, subject)


def fail(message: str, *, remedy: str = "", subject: Subject = HOST) -> Finding:
    return Finding("fail", message, remedy, subject)


def skip(message: str, *, remedy: str = "", subject: Subject = HOST) -> Finding:
    """The question cannot be asked from here. Never a way to soften a real finding."""
    return Finding("skip", message, remedy, subject)


# -------------------------------------------------------------- talking to the outside


@dataclass(frozen=True)
class Completed:
    rc: int
    out: str
    err: str


# argv, stdin -> Completed. The one seam to the box, which is what lets the tests drive
# every check without a docker socket.
Runner = Callable[[Sequence[str], "str | None"], Completed]


def run_subprocess(argv: Sequence[str], stdin: str | None = None) -> Completed:
    try:
        proc = subprocess.run(list(argv), input=stdin, capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return Completed(127, "", f"{argv[0]}: no such command")
    except subprocess.TimeoutExpired:
        return Completed(124, "", f"{' '.join(argv)}: timed out after 30s")
    return Completed(proc.returncode, proc.stdout, proc.stderr)


class Unanswerable(Exception):
    """A precondition is not here. run_all() turns it into exactly one `skip`."""

    def __init__(self, message: str, remedy: str = "", subject: Subject = HOST) -> None:
        super().__init__(message)
        self.message = message
        self.remedy = remedy
        self.subject = subject


def _first_line(text: str, limit: int = 200) -> str:
    for line in text.splitlines():
        if line.strip():
            return line.strip()[:limit]
    return ""


@dataclass
class Ctx:
    """Everything a check may ask, memoized, with one seam to the outside world."""

    run: Runner
    root: Path
    now: float = field(default_factory=time.time)
    _inspected: dict[str, dict[str, Any] | None] = field(default_factory=dict)
    _docker_reason: str | None = None

    def containers(self) -> tuple[str, ...]:
        try:
            return compose_containers(self.root)
        except OSError as exc:
            raise Unanswerable(f"no se pudo leer docker-compose.yml: {exc}") from None

    def require_docker(self) -> None:
        if self._docker_reason is None:
            probe = self.run(["docker", "version", "--format", "{{.Server.Version}}"], None)
            detail = _first_line(probe.err) or _first_line(probe.out) or f"rc={probe.rc}"
            self._docker_reason = (
                "" if probe.rc == 0 else f"no se pudo hablar con el docker daemon: {detail}"
            )
        if self._docker_reason:
            raise Unanswerable(self._docker_reason, remedy="sudo -i")

    def inspect(self, container: str, *, fresh: bool = False) -> dict[str, Any] | None:
        """The container's inspect document, or None if there is no such container."""
        self.require_docker()
        if fresh or container not in self._inspected:
            done = self.run(["docker", "inspect", "--format", "{{json .}}", container], None)
            try:
                self._inspected[container] = json.loads(done.out) if done.rc == 0 else None
            except json.JSONDecodeError:
                self._inspected[container] = None
        return self._inspected[container]

    def require_deployed(self) -> None:
        """None of the containers existing is a laptop, not a broken deploy: skip, once."""
        self.require_docker()
        if not any(self.inspect(name) is not None for name in self.containers()):
            raise Unanswerable(
                "este stack no está desplegado en esta máquina: no existe ninguno de sus "
                "containers",
                remedy="make deploy  # como root en /opt/tic-campus",
            )

    def in_container(self, container: str, *argv: str) -> Completed:
        """Run inside a running container. An exec-based FAIL means nothing until it is up."""
        self.require_deployed()
        subject = Subject.container(container)
        doc = self.inspect(container)
        if doc is None:
            raise Unanswerable(
                f"{container}: no existe el container, así que no hay nada que preguntarle",
                remedy="make deploy  # como root en /opt/tic-campus",
                subject=subject,
            )
        status = str(doc.get("State", {}).get("Status", "unknown"))
        if status != "running":
            raise Unanswerable(
                f"{container}: el container está {status}, así que no puede contestar",
                remedy=f"docker logs {container}",
                subject=subject,
            )
        return self.run(["docker", "exec", container, *argv], None)


# ------------------------------------------------------------------------------ checks
#
# `fn(ctx) -> list[Finding]`; raising Unanswerable is how a check says its precondition is
# not here. A stack checks only what it deploys (§8): the membership of `tic-campus-edge`,
# the origin through tic-proxy and `/opt/tic-campus`'s git drift are all
# tic-platform's, and a second opinion here would go red every time a neighbour restarts.


def _parse_docker_time(value: str) -> float | None:
    """Docker's RFC3339 with nanoseconds, which `fromisoformat` refuses before 3.11."""
    match = re.match(r"^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})", value)
    if not match:
        return None
    return float(calendar.timegm(time.strptime(match.group(1), "%Y-%m-%dT%H:%M:%S")))


def check_containers_settled(ctx: Ctx) -> list[Finding]:
    ctx.require_deployed()
    findings: list[Finding] = []
    for name in ctx.containers():
        subject = Subject.container(name)
        # Three reads back to back and no sleep: a container about to exit on bad config is
        # briefly `running`, and a doctor that waits describes a moment that has gone.
        docs = [ctx.inspect(name, fresh=True) for _ in range(3)]
        if docs[0] is None:
            findings.append(
                fail(
                    f"{name}: no existe el container que este stack despliega",
                    remedy="make deploy  # como root en /opt/tic-campus",
                    subject=subject,
                )
            )
            continue
        states = [str((d or {}).get("State", {}).get("Status", "gone")) for d in docs]
        bad = [s for s in states if s != "running"]
        if bad:
            findings.append(
                fail(
                    f"{name}: quedó en estado {bad[0]} durante el chequeo, así que no está "
                    "sirviendo",
                    remedy=f"docker logs {name}",
                    subject=subject,
                )
            )
            continue
        last = docs[-1] or {}
        state = last.get("State", {})
        health = str((state.get("Health") or {}).get("Status", ""))
        restarts = int(last.get("RestartCount", 0) or 0)
        started = _parse_docker_time(str(state.get("StartedAt", "")))
        if health == "unhealthy":
            findings.append(
                fail(
                    f"{name}: corre pero su healthcheck lo declara unhealthy",
                    remedy=f"docker logs {name}",
                    subject=subject,
                )
            )
        elif health == "starting":
            findings.append(
                warn(
                    f"{name}: corre y su healthcheck todavía no contestó (starting)",
                    remedy=f"docker logs {name}",
                    subject=subject,
                )
            )
        elif restarts > 0 and started is not None and ctx.now - started < 60:
            findings.append(
                warn(
                    f"{name}: arrancó hace menos de un minuto y lleva {restarts} reinicio(s), "
                    "que es la forma de un loop de arranque",
                    remedy=f"docker logs {name}",
                    subject=subject,
                )
            )
        else:
            findings.append(ok(f"{name}: corriendo, healthcheck {health or 'ausente'}", subject=subject))
    return findings


def check_web_api_proxy(ctx: Ctx) -> list[Finding]:
    """The one hop neither healthcheck covers: nginx's `/api/` → tic-campus-api, asked from
    inside tic-campus-web the way a request through tic-proxy arrives. Both containers can be
    healthy with this broken — a wrong upstream name, a resolver that lost the api."""
    subject = Subject.container(WEB)
    done = ctx.in_container(WEB, "wget", "-q", "-O", "-", "http://127.0.0.1/api/health")
    if done.rc == 0 and '"ok"' in done.out:
        return [ok("tic-campus-web llega a la api por /api/", subject=subject)]
    detail = _first_line(done.err) or (
        f"wget salió {done.rc}" if done.rc else 'la respuesta no trae "ok"'
    )
    return [
        fail(
            f"tic-campus-web no llegó a la api por /api/ ({detail}), así que el frontend "
            "carga y ninguna llamada a la api contesta",
            remedy="revisá docker/web/nginx.conf; docker logs tic-campus-web",
            subject=subject,
        )
    ]


def check_db_reachable(ctx: Ctx) -> list[Finding]:
    """`/api/readyz` asked from inside tic-campus-api: does this process reach tic-db as
    `campus_svc` and read `directory.*`? The liveness healthcheck deliberately says nothing
    about the database — restarting the container does not fix a database that is down — so
    a stack whose every container is healthy can still serve nothing. Asked *inside* the api
    rather than through nginx so a failure here is never the proxy hop, which is the check
    above."""
    subject = Subject.container(API)
    # node:24-slim carries no curl and no wget; global fetch is in the image already.
    done = ctx.in_container(
        API,
        "node",
        "-e",
        "fetch('http://127.0.0.1:3000/api/readyz')"
        ".then(async r=>{console.log(await r.text());process.exit(r.ok?0:1)})"
        ".catch(e=>{console.log(String(e));process.exit(1)})",
    )
    if done.rc == 0 and '"ok"' in done.out:
        return [ok("tic-campus-api llega a tic-db como campus_svc", subject=subject)]
    detail = _first_line(done.out) or _first_line(done.err) or f"node salió {done.rc}"
    return [
        fail(
            f"tic-campus-api no llegó a la base ({detail}), así que el stack está arriba y "
            "no puede contestar nada que dependa de datos",
            remedy=(
                "revisá que tic-db esté healthy, que .env apunte a campus_svc y que "
                "secrets/db_svc_password tenga su contraseña; docker logs tic-campus-api"
            ),
            subject=subject,
        )
    ]


CheckFn = Callable[[Ctx], "list[Finding]"]


@dataclass(frozen=True)
class Check:
    id: str
    title: str
    fn: CheckFn


# `title` says what the check is ABOUT, never what it found.
CHECKS: list[Check] = [
    Check("containers-settled", "estado de los containers del stack", check_containers_settled),
    Check("web-api-proxy", "proxy /api/ de tic-campus-web", check_web_api_proxy),
    Check("db-reachable", "acceso de la api a tic-db", check_db_reachable),
]

assert len({check.id for check in CHECKS}) == len(CHECKS), "duplicate check id in CHECKS"


def run_all(ctx: Ctx) -> Report:
    started = time.time()
    results: list[CheckResult] = []
    for check in CHECKS:
        try:
            findings = list(check.fn(ctx))
        except Unanswerable as exc:
            findings = [skip(exc.message, remedy=exc.remedy, subject=exc.subject)]
        except Exception as exc:  # a check's own failure is data, not a crash
            findings = [fail(f"el chequeo lanzó {type(exc).__name__}: {exc}")]
        if not findings:
            findings = [fail("el chequeo no devolvió ningún hallazgo — es un bug del chequeo")]
        results.append(CheckResult(check.id, check.title, _worst_of(findings), tuple(findings)))
    return Report(SCHEMA_VERSION, time.time(), time.time() - started, tuple(results))


# ------------------------------------------------------------------- text, and its paint
#
# Everything visual is conditional on the stream, and the text underneath never changes:
# painted output with the escapes stripped is character-for-character the bare output
# (bin/test_doctor.py). Progress lines are not drawn — two checks do not need one.

_RESET = "\033[0m"
_SGR: dict[str, str] = {
    "bold": "\033[1m",
    "dim": "\033[2m",
    "green": "\033[32m",
    "yellow": "\033[33m",
    "red": "\033[31m",
}
# `skip` dim rather than a hue: it is the absence of an answer.
_SEVERITY_SGR: dict[str, str] = {"ok": "green", "warn": "yellow", "fail": "red", "skip": "dim"}
_SECTION_TITLES: dict[str, str] = {"platform": "Plataforma (tic-campus)", "tenant": "Alojados"}


def _paint(text: str, name: str, *, color: bool) -> str:
    return f"{_SGR[name]}{text}{_RESET}" if color else text


def format_finding(check_id: str, finding: Finding, *, color: bool = False) -> list[str]:
    marker = _paint(f"[{finding.severity:<4}]", _SEVERITY_SGR[finding.severity], color=color)
    lines = [f"{marker} {_paint(check_id, 'dim', color=color)} — {finding.message}"]
    if finding.remedy:
        lines.append(_paint(f"         → {finding.remedy}", "dim", color=color))
    return lines


def format_report(
    report: Report, *, scopes: Sequence[Scope] = ALL_SCOPES, color: bool = False
) -> list[str]:
    lines: list[str] = []
    for scope in scopes:
        pairs = [(r.id, f) for r in report.results for f in r.findings if f.scope == scope]
        if not pairs:
            continue
        if lines:
            lines.append("")
        title = _SECTION_TITLES[scope]
        rule = "─" * max(3, 56 - len(title))  # measured on the plain title, then painted
        lines.append(f"── {_paint(title, 'bold', color=color)} {rule}")
        for check_id, finding in pairs:
            lines.extend(format_finding(check_id, finding, color=color))
    return lines


def format_counts(report: Report, *, scopes: Sequence[Scope] = ALL_SCOPES) -> str:
    tallies = []
    for scope in scopes:
        counts = report.counts(scope)
        parts = [f"{counts[s]} {s}" for s in ("ok", "warn", "fail", "skip") if counts[s]]
        tallies.append(f"{_SECTION_TITLES[scope]}: {', '.join(parts) or 'sin hallazgos'}")
    return f"{len(report.results)} chequeos · " + " · ".join(tallies)


def _counts_toward_exit(scope: Scope, *, strict: bool, scopes: Sequence[Scope]) -> bool:
    if scope == "platform":
        return "platform" in scopes
    return "tenant" in scopes and (strict or tuple(scopes) == ("tenant",))


def exit_code(report: Report, *, strict: bool = False, scopes: Sequence[Scope] = ALL_SCOPES) -> int:
    return int(
        any(
            report.worst_in(scope) == "fail" and _counts_toward_exit(scope, strict=strict, scopes=scopes)
            for scope in ALL_SCOPES
        )
    )


def exit_reason(report: Report, *, strict: bool = False, scopes: Sequence[Scope] = ALL_SCOPES) -> str:
    """Always printed: "6 chequeos, 1 fail, salida 0" otherwise reads like a bug."""
    if exit_code(report, strict=strict, scopes=scopes) == 0:
        if "tenant" in scopes and report.worst_in("tenant") == "fail":
            return (
                "salida 0 — hay fallas en alojados, que no son fallas de la plataforma "
                "(usá --strict si querés que cuenten)"
            )
        return "salida 0"
    if "platform" in scopes and report.worst_in("platform") == "fail":
        return "salida 1 — falla de plataforma"
    return "salida 1 — falla en algo alojado"


def format_summary(
    report: Report, *, strict: bool = False, scopes: Sequence[Scope] = ALL_SCOPES, color: bool = False
) -> list[str]:
    return [
        format_counts(report, scopes=scopes),
        _paint(exit_reason(report, strict=strict, scopes=scopes), "dim", color=color),
    ]


# ------------------------------------------------------------------------------ the CLI


def _should_color(explicit: bool | None) -> bool:
    if explicit is not None:
        return explicit  # --color beats NO_COLOR: somebody piping into `less -R` asked
    return sys.stdout.isatty() and not os.environ.get("NO_COLOR")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="doctor.py",
        description=(
            "Diagnóstico de tic-campus. Sale 1 si falla un chequeo de plataforma. "
            "El contrato del documento está en el README."
        ),
    )
    parser.add_argument(
        "--json", dest="as_json", action="store_true", help="imprimir el reporte como JSON y nada más"
    )
    parser.add_argument(
        "--strict", action="store_true", help="salir 1 también si falla algo alojado"
    )
    parser.add_argument(
        "--scope",
        default="all",
        choices=("platform", "tenant", "all"),
        help="qué mostrar y qué contar para el código de salida",
    )
    color = parser.add_mutually_exclusive_group()
    color.add_argument(
        "--color", dest="color", action="store_true", default=None,
        help="forzar el color (por defecto: sólo si la salida es una terminal)",
    )  # fmt: skip
    color.add_argument("--no-color", dest="color", action="store_false", help="apagar el color")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    scopes: tuple[Scope, ...] = ALL_SCOPES if args.scope == "all" else (cast(Scope, args.scope),)
    report = run_all(Ctx(run=run_subprocess, root=ROOT))
    if args.as_json:
        # The exit code still moves, and the document is still whole: parseable stdout is
        # what tic-platform reads, not the code.
        print(json.dumps(report.as_json(), indent=2, ensure_ascii=False))
        return exit_code(report, strict=args.strict, scopes=scopes)
    painted = _should_color(args.color)
    for line in format_report(report, scopes=scopes, color=painted):
        print(line)
    print("")
    for line in format_summary(report, strict=args.strict, scopes=scopes, color=painted):
        print(line)
    return exit_code(report, strict=args.strict, scopes=scopes)


if __name__ == "__main__":
    sys.exit(main())
