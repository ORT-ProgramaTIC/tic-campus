# Deploy-day checklist

What only the box can show: tic-auth for real, the directory's real data, the doctor and the
backups. An item touching one of those is `built` until its entry here closes. Started
2026-11-08, when tic-campus adopted the family's record rules. Earlier deploy checks are in
`../README.md` ("Deploy").

## How this file works

Like `FEATURES.md`, under `../../tic-platform/RECORD-CONVENTIONS.md`: an **index of every
entry**, then the full text of the ones still open. Closed entries move verbatim to
`docs/deploy-day/M<n>-*.md`, filed under the milestone of their source item. IDs (`D<n>`) are
never reused.

- **Source:** the item(s) the entry came from. The link that matters runs the other way: every
  open entry is named in the Notes of the `FEATURES.md` item that waits on it.
- **Status:** `open` or `partly`; once closed, `done`, `moot` (what it checked no longer
  exists) or `superseded`.
- **Who** can run the check: **panel** (a signed-in teacher or admin, a browser), **root** (a
  root shell on the box, in `/opt/tic-campus` or `/opt/tic-platform`), or **IT** (AD, DNS, the
  firewall, a real student account TIC does not control). Closed rows show `—`.
- **Touched**, open entries only: the date of the newest edit or dated bullet.
- **Blocks**, open entries only: what goes wrong, for whom, if the assumption is false
  (`students: …`, `security: …`, `data: …`, `operators: …`, or `confirms only`).
- **Closing:** add a dated `- **Done YYYY-MM-DD:** …` bullet, move the entry verbatim to its
  milestone file, and set its row closed with Touched and Blocks `—`.

## Before you deploy

Rollout-order rules that fail silently. The once-per-box steps (the uploads volume, the tic-auth
client) are in `../README.md`, "Deploy".

## Entry format

```markdown
### D<n> · <short title>

- **Assumed:** what the code assumes to be true
- **Why not verified locally:** what local dev cannot reach or simulate
- **Check:** the exact commands or actions on the box, numbered when there are several
- **If it fails:** what that means, and where to look
- **Source:** F<n>
```

## Index

| Entry                                         | Source | Status | Who | Touched | Blocks | Where                                                               |
| --------------------------------------------- | ------ | ------ | --- | ------- | ------ | ------------------------------------------------------------------- |
| D1 · tic-campus answers tic-platform's doctor | F31    | done   | —   | —       | —      | [`docs/deploy-day/M1-the-rebuild.md`](deploy-day/M1-the-rebuild.md) |

## Open entries

None.
