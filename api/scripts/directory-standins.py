"""Emit the slice of tic-auth's schema that tic-campus's database tests stand in for.

**Run by `gen-directory-standins.mjs`, never by the test suite.** The suite reads the
committed `.sql` this produces, so a laptop with no Python and no tic-auth checkout can
still run `make test-db`. Only *regenerating* needs this file.

Why generate rather than hand-write: campus's tables carry real foreign keys into
`public."user"` and `public.offering`, and every roster read goes to the `directory.*`
views (F5, F31). A bare Postgres has none of it, so the migrations will not apply at all.
Hand-writing the stand-ins would be a second definition of somebody else's schema, free to
drift from tic-auth's without anything noticing — which is the exact failure F5 deleted
campus's own roster to avoid. Generated, the drift is a build step's problem.

Ported from `MEV/api/scripts/directory-standins.py`, which solved this first; the lists
below are campus's, because what a consumer *reads* has to be the consumer's own decision.

Nothing here is retyped: the base tables come out of tic-auth's own SQLAlchemy metadata,
`public.enrollment` out of `ENROLLMENT_VIEW_SQL`, and the views out of `DIRECTORY_VIEWS`.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import Enum as SAEnum
from sqlalchemy import Table
from sqlalchemy.dialects import postgresql
from sqlalchemy.schema import CreateTable

# Ahead of the tic_auth imports, so a repo passed on the command line wins over whatever
# the interpreter would otherwise find. It does not always win — see `assert_importing_from`.
if len(sys.argv) == 2:
    sys.path.insert(0, str(Path(sys.argv[1]).resolve()))

from tic_auth.models.base import Base
from tic_auth.models.contract import DIRECTORY_SCHEMA, DIRECTORY_VIEWS
from tic_auth.models.directory import ENROLLMENT_VIEW_SQL

# The seven views campus reads (`api/src/db/schema/directory.ts`). Named one by one and
# not taken from `DIRECTORY_VIEWS` wholesale, and that is the point: `0005`'s
# ALTER DEFAULT PRIVILEGES grants campus_app every future view in that schema whether
# campus wanted it or not, so the list of what campus *reads* has to be campus's own.
#
# Absent on purpose: `user_role`, because the token already says whether somebody is a
# student and a second source of one fact is how the two disagree; `student_course`,
# because campus asks about offerings and never about course membership;
# `offering_time_slot` and `time_slot_teacher`, which are F14's timetable and carry the
# override rule campus has not implemented yet; `project` and `project_member`, which are
# tic-host's and would drag their tables and enums in behind them for no reader.
CAMPUS_VIEWS: tuple[str, ...] = (
    "user",
    "course",
    "subject",
    "offering",
    "offering_course",
    "teacher_offering",
    "enrollment",
)

# Where the closure below starts: every base table those seven views select from, named
# because a view's SQL is text and walking it would be guesswork. The closure then follows
# outgoing foreign keys, so a column tic-auth adds a reference to comes along by itself.
SEED_TABLES: tuple[str, ...] = (
    "user",
    "academic_year",
    "term",
    "course",
    "subject",
    "offering",
    "offering_course",
    "teacher_offering",
    # Neither is read, and both are selected from: `public.enrollment` unions a student's
    # course-borne offerings with their optional ones, and `student_offering` is never
    # published on its own.
    "student_course",
    "student_offering",
)

# Hashed into the provenance file so `db:stubs:check` can tell "nobody regenerated" from
# "nothing changed" without needing Python to answer it.
UPSTREAM_SOURCES: tuple[str, ...] = (
    "tic_auth/models/contract.py",
    "tic_auth/models/directory.py",
    "tic_auth/models/identity.py",
    "tic_auth/models/base.py",
    "tic_auth/models/enums.py",
    "tic_auth/settings_db.py",
)

DIALECT = postgresql.dialect()


def base_tables() -> list[Table]:
    """The seed set plus the outgoing-foreign-key closure over it, in dependency order.

    Outgoing only. Following incoming references would pull in every table that happens to
    point at `public."user"` — most of tic-auth — and none of it is anything campus reads.
    """
    by_name = {t.name: t for t in Base.metadata.tables.values() if not t.info.get("is_view")}

    missing = [n for n in SEED_TABLES if n not in by_name]
    if missing:
        # Loud, because the alternative is a stand-in that silently stops matching the
        # thing it stands in for.
        raise SystemExit(
            f"tic-auth no longer defines {missing}. The seed list in this script is stale — "
            f"reconcile it against tic_auth/models/ before regenerating."
        )

    wanted: set[str] = set()
    queue = list(SEED_TABLES)
    while queue:
        name = queue.pop()
        if name in wanted:
            continue
        wanted.add(name)
        for fk in by_name[name].foreign_keys:
            target = fk.column.table
            if target.name in by_name and target.name not in wanted:
                queue.append(target.name)

    # `sorted_tables` is metadata-wide and dependency-ordered; filtering it preserves that
    # order, which is what lets the emitted DDL be applied top to bottom.
    return [t for t in Base.metadata.sorted_tables if t.name in wanted and not t.info.get("is_view")]


def enum_ddl(tables: list[Table]) -> list[str]:
    """`CREATE TYPE` for every enum the tables use.

    `CreateTable` names the type and assumes it exists — SQLAlchemy creates it in a separate
    DDL pass during `create_all`, which is not the pass being used here. Miss this and the
    generated SQL fails on `type "offering_kind" does not exist`, several tables in.

    The check is `sqlalchemy.Enum` rather than `postgresql.ENUM`: tic-auth's `pg_enum`
    helper returns the generic type with `native_enum=True`, and `type_.enums` already
    carries the member *values* because that helper pins `values_callable` to `.value`.
    """
    seen: dict[str, list[str]] = {}
    for table in tables:
        for column in table.columns:
            type_ = column.type
            if isinstance(type_, (SAEnum, postgresql.ENUM)) and type_.name and type_.name not in seen:
                seen[type_.name] = list(type_.enums)
    return [
        f"CREATE TYPE {name} AS ENUM ({', '.join(quote_literal(v) for v in values)});"
        for name, values in sorted(seen.items())
    ]


def quote_literal(value: str) -> str:
    escaped = value.replace("'", "''")
    return f"'{escaped}'"


def source_hashes(repo: Path) -> dict[str, str]:
    return {
        rel: hashlib.sha256((repo / rel).read_bytes()).hexdigest()
        for rel in UPSTREAM_SOURCES
        if (repo / rel).exists()
    }


def upstream_revision(repo: Path) -> str | None:
    try:
        out = subprocess.run(
            ["git", "-C", str(repo), "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        )
        return out.stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def assert_importing_from(repo: Path) -> None:
    """Refuse to generate from a repo other than the one named on the command line.

    tic-auth is installed into its own venv as an **editable** install, and
    `_editable_impl_tic_auth.pth` pins `import tic_auth` to one absolute path. So pointing
    this script at a second checkout silently reads the first one instead — the generated
    SQL describes a repo nobody asked about, and the only visible symptom is a drift check
    that reports the hashes moved while the SQL did not. Measured, not hypothetical: that
    is exactly what happened the first time this was tested.

    For the ordinary case (one checkout, beside this repo) the paths agree and this is a
    no-op. It exists for the case where they do not.
    """
    imported = Path(Base.__module__ and sys.modules["tic_auth"].__file__ or "").resolve().parent.parent
    if imported != repo.resolve():
        raise SystemExit(
            f"refusing to generate: asked for {repo.resolve()}, but `import tic_auth` "
            f"resolved to {imported}.\n"
            f"tic-auth is an editable install, so its .pth file pins the import to one "
            f"absolute path regardless of sys.path or cwd.\n"
            f"Generate from that checkout instead, or run this inside a venv installed "
            f"from the checkout you mean."
        )


def render(repo: Path) -> tuple[str, dict]:
    assert_importing_from(repo)
    tables = base_tables()

    parts: list[str] = [
        "-- GENERATED by api/scripts/directory-standins.py — do not edit by hand.",
        "-- Regenerate with `pnpm db:stubs:generate`; `pnpm db:stubs:check` proves it is current.",
        "--",
        "-- The slice of tic-auth's schema campus foreign-keys into and reads through.",
        "-- Applied by `make test-db` BEFORE campus's own migrations, because a bare Postgres",
        "-- has none of it and the migrations would not apply (F31, docs/FEATURES.md Group J).",
        "",
        "-- Enum types, named by the columns below.",
        *enum_ddl(tables),
        "",
        "-- Base tables, in dependency order.",
    ]

    for table in tables:
        ddl = str(CreateTable(table).compile(dialect=DIALECT)).strip()
        parts.append(f"{ddl};")

    parts += [
        "",
        "-- `public.enrollment`, itself a view. Taken verbatim from tic-auth's",
        "-- ENROLLMENT_VIEW_SQL rather than re-derived: two copies of the mandatory/optional",
        "-- union is exactly the logic campus owns no roster in order not to keep.",
        f"{ENROLLMENT_VIEW_SQL.strip()};",
        "",
        f"CREATE SCHEMA {DIRECTORY_SCHEMA};",
        "",
        "-- The contract views, verbatim from tic_auth/models/contract.py.",
    ]

    wanted_views = set(CAMPUS_VIEWS)
    emitted: list[str] = []
    for name, sql in DIRECTORY_VIEWS:
        if name in wanted_views:
            parts.append(f"{sql.strip()};")
            emitted.append(name)

    if set(emitted) != wanted_views:
        raise SystemExit(
            f"tic-auth no longer publishes {sorted(wanted_views - set(emitted))}. "
            f"Campus reads those views — reconcile CAMPUS_VIEWS before regenerating."
        )

    provenance = {
        "generatedAt": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "upstreamRepo": str(repo),
        "upstreamRevision": upstream_revision(repo),
        "views": emitted,
        "baseTables": [t.name for t in tables],
        "sourceHashes": source_hashes(repo),
    }

    return "\n".join(parts) + "\n", provenance


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: directory-standins.py <tic-auth repo root>", file=sys.stderr)
        return 2
    repo = Path(sys.argv[1]).resolve()
    sql, provenance = render(repo)
    # One JSON document on stdout, so the Node driver owns every path and this script
    # writes nothing.
    json.dump({"sql": sql, "provenance": provenance}, sys.stdout)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
