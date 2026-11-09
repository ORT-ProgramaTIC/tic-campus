# M1 — the rebuild: closed deploy-day entries

Closed `DEPLOY-DAY.md` entries whose source item is in `docs/features/M1-the-rebuild.md`, moved verbatim.

---

### D1 · tic-campus answers tic-platform's doctor

- **Assumed:** on the box, `bin/doctor.py` finds nothing failing, and tic-platform's
  `bin/tic-doctor` gets campus's report over the contract (`stack-doctor-tic-campus`, `schema_version: 2`)
  rather than skipping it. Backups need no entry: tic-platform's nightly dump covers the
  `campus` schema and archives the `tic-campus-uploads` volume (`tic-platform/bin/backup.sh`).
- **Why not verified locally:** the doctor reads the box's docker socket and the deployed stack,
  and the aggregator only runs in `/opt/tic-platform`.
- **Check:**
  1. As root in `/opt/tic-campus`: `make doctor`. No `[fail]` line.
  2. As root in `/opt/tic-platform`: `bin/tic-doctor`. The tic-campus stack has a verdict, not `skip`.
- **If it fails:** a `[fail]` names its check (README, "Doctor"). A `skip` in step 2 means the
  aggregator did not reach `bin/doctor.py --json` in `/opt/tic-campus`; see
  `stack-doctor-tic-campus` in `tic-platform/bin/tic-doctor`.
- **Source:** F31
- **Done 2026-11-09:** the user ran `make doctor` in `/opt/tic-platform` (`bin/tic-doctor`):
  `stack-doctor-tic-campus — tic-campus doctor: platform clean (5 checks)`, a verdict rather than
  a skip. The same run showed `tic-campus-edge` with exactly its three members,
  `tic-campus.ort.edu.ar` and `campus-tic.ort.edu.ar` answering `/api/health` 200, `campus_owner`
  and `campus_svc` capped at 3 and 15, `/opt/tic-campus` level with `origin/main`, and the
  nightly backup fresh. Platform verdict: 72 ok, 1 warn (tic-host's, not campus's).
