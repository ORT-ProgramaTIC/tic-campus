#!/usr/bin/env python3
"""Check FEATURES.md and DEPLOY-DAY.md against their own rules.

The family copy of tic-host's checker (tic-host F149); the rules are in
`../tic-platform/RECORD-CONVENTIONS.md`.

Both files keep a hand-written index of items whose full text lives either below the index
(open) or in a milestone archive (closed). This checks that each index row matches where its
heading actually is, that statuses come from the fixed lists, that a `built` item names an open
deploy-day entry, that every `amends F<n>` has its back-link, and that an open entry's Touched
date is not older than its own text.

    bin/check-docs.py        # print problems, exit 1 if any
    bin/check-docs.py --it   # print the open IT-only entries as one request
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

F_STATUSES = {"open", "decided", "building", "built", "done", "dropped", "deprecated"}
F_BELOW = {"open", "decided", "building"}
D_STATUSES = {"open", "partly", "done", "moot", "superseded"}
D_OPEN = {"open", "partly"}
WHO = {"panel", "root", "IT"}
BELOW = ("below", "below, under Open")
DATE = re.compile(r"20\d\d-\d\d-\d\d")


def _rows(text: str, prefix: str) -> list[list[str]]:
    return [
        [c.strip() for c in line.strip().strip("|").split("|")]
        for line in text.splitlines()
        if re.match(rf"^\| {prefix}\d+ ·", line)
    ]


def _items(path: Path, prefix: str) -> dict[str, str]:
    """`F12` -> the item's text, from its `### F12 ·` heading to the next heading of its kind."""
    text = path.read_text(encoding="utf-8")
    parts = re.split(rf"^(?=### {prefix}\d+ ·)", text, flags=re.M)
    out = {}
    for part in parts[1:]:
        ident = re.match(rf"### ({prefix}\d+) ·", part).group(1)
        out[ident] = re.split(r"^## ", part, flags=re.M)[0]
    return out


def _where(cell: str) -> str:
    m = re.search(r"\]\(([^)]+)\)", cell)
    return m.group(1) if m else cell


def _base(root: Path) -> Path:
    """The folder holding FEATURES.md and DEPLOY-DAY.md: the repo root, or `docs/`."""
    return root if (root / "FEATURES.md").exists() else root / "docs"


def _locate(
    root: Path, index_file: Path, archive: str, prefix: str
) -> tuple[dict[str, str], dict[str, str], list[str]]:
    """Each heading's text and file ("below" = the index file), plus duplicate headings.

    A file's place is its path relative to the index file, as the index's links write it.
    """
    texts, where, problems = {}, {}, []
    for path in [index_file, *sorted((root / archive).glob("*.md"))]:
        place = "below" if path == index_file else path.relative_to(index_file.parent).as_posix()
        for ident, body in _items(path, prefix).items():
            if ident in where:
                problems.append(f"{ident}: heading in both {where[ident]} and {place}")
            texts[ident], where[ident] = body, place
    return texts, where, problems


def _check_rows(rows, where, index_name, status_col, statuses, below_statuses) -> list[str]:
    problems, seen = [], set()
    for row in rows:
        ident = row[0].split(" ·")[0]
        status, place = row[status_col], _where(row[-1])
        if ident in seen:
            problems.append(f"{index_name}: {ident} has two index rows")
        seen.add(ident)
        if status not in statuses:
            problems.append(
                f"{index_name}: {ident} status {status!r} is not one of {sorted(statuses)}"
            )
        actual = where.get(ident)
        if actual is None:
            problems.append(f"{index_name}: {ident} has a row but no heading anywhere")
        elif (place in BELOW) != (actual == "below") or (actual != "below" and place != actual):
            problems.append(f"{index_name}: {ident} row says {place!r}, heading is in {actual!r}")
        elif (actual == "below") != (status in below_statuses):
            problems.append(f"{index_name}: {ident} is {status!r} but its text is in {actual!r}")
    for ident in sorted(set(where) - seen, key=lambda i: int(i[1:])):
        problems.append(f"{index_name}: {ident} has a heading but no index row")
    return problems


def problems(root: Path = ROOT) -> list[str]:
    feat, dd = _base(root) / "FEATURES.md", _base(root) / "DEPLOY-DAY.md"
    f_text, f_where, out = _locate(root, feat, "docs/features", "F")
    d_text, d_where, d_dupes = _locate(root, dd, "docs/deploy-day", "D")
    out += d_dupes
    f_rows = _rows(feat.read_text(encoding="utf-8"), "F")  # Item | Status | Notes | Where
    d_rows = _rows(
        dd.read_text(encoding="utf-8"), "D"
    )  # Entry | Source | Status | Who | Touched | Blocks | Where
    out += _check_rows(f_rows, f_where, "FEATURES.md", 1, F_STATUSES, F_BELOW)
    out += _check_rows(d_rows, d_where, "DEPLOY-DAY.md", 2, D_STATUSES, D_OPEN)

    d_status = {r[0].split(" ·")[0]: r[2] for r in d_rows}
    named: set[str] = set()  # D entries some FEATURES row's Notes point at: the D -> F link
    for ident, status, notes, _ in f_rows:
        fid = ident.split(" ·")[0]
        waits = re.findall(r"D\d+", notes)
        named.update(waits)
        still_open = [d for d in waits if d_status.get(d) in D_OPEN]
        if status == "built" and not still_open:
            closed = ", ".join(waits) or "none named"
            out.append(
                f"FEATURES.md: {fid} is built but every D it waits on is closed "
                f"({closed}): mark it done"
            )
        if status == "done" and still_open:
            out.append(f"FEATURES.md: {fid} is done but waits on open {', '.join(still_open)}")
        for target in re.findall(r"amends (F\d+)", ident):
            if f"Amended by {fid}**" not in f_text.get(target, ""):
                out.append(
                    f"FEATURES.md: {fid} amends {target}, which lacks '> **Amended by {fid}**'"
                )
        if f_where.get(fid) == "below" and status in {"decided", "building"}:
            if "**Decision, in short:**" not in f_text[fid]:
                out.append(f"FEATURES.md: {fid} is {status} but has no '**Decision, in short:**'")
    for did, status in d_status.items():
        if status in D_OPEN and did not in named:
            out.append(f"DEPLOY-DAY.md: {did} is {status} but no FEATURES row's Notes name it")

    for ident, source, status, who, touched, blocks, _ in d_rows:
        did = ident.split(" ·")[0]
        for ref in re.findall(r"[FD]\d+", source):
            if ref not in (f_where if ref[0] == "F" else d_where):
                out.append(f"DEPLOY-DAY.md: {did} cites {ref}, which does not exist")
        if status in D_OPEN:
            if who not in WHO:
                out.append(f"DEPLOY-DAY.md: {did} is {status} but Who is {who!r}")
            if not DATE.fullmatch(touched) or blocks in ("", "—"):
                out.append(f"DEPLOY-DAY.md: {did} is {status} but has no Touched date or Blocks")
            elif dates := DATE.findall(d_text.get(did, "")):
                if max(dates) > touched:
                    out.append(f"DEPLOY-DAY.md: {did} Touched {touched} < its text ({max(dates)})")
    return out


def it_request(root: Path = ROOT) -> str:
    dd = _base(root) / "DEPLOY-DAY.md"
    texts = _items(dd, "D")
    out = []
    for ident, _source, status, who, *_ in _rows(dd.read_text(encoding="utf-8"), "D"):
        did = ident.split(" ·")[0]
        if who == "IT" and status in D_OPEN:
            check = re.search(r"^- \*\*Check:?\*\*:?(.*?)(?=^- \*\*)", texts[did], re.S | re.M)
            out.append(
                f"## {ident} ({status})\n{check.group(1).strip() if check else '(no Check)'}\n"
            )
    return "\n".join(out)


if __name__ == "__main__":
    if "--it" in sys.argv[1:]:
        print(it_request())
        sys.exit(0)
    found = problems()
    print("\n".join(found) or "ok")
    sys.exit(1 if found else 0)
