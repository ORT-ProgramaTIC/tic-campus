# tic-campus

`api/` (TypeScript, Node) and `web/` (TypeScript), one pnpm workspace.

```sh
pnpm install
pnpm build          # both
pnpm typecheck
pnpm test           # the api's own checks
pnpm format         # prettier
```

`docs/FEATURES.md` is what this is being built to.

## Deploy

On the VM, as root, from `/opt/tic-campus` — see `../DEPLOY-CONVENTIONS.md`:

```sh
make deploy
```

`tic-campus-web` (nginx) serves the frontend at `/` and proxies `/api/` to
`tic-campus-api`. tic-proxy reaches it over `tic-campus-edge`.

### The database

`tic-campus-api` is also on `tic-db`, tic-platform's shared Postgres, and `tic-campus-web`
deliberately is not. Four roles, two of them created by hand at install time
(`docs/FEATURES.md` F31): the container connects as **`campus_svc`**, which holds no
`CREATE` anywhere, and migrations run as **`campus_owner`** from the host. Reads of people,
courses and offerings go to tic-auth's `directory.*` views; campus owns no roster.

Two files live only on the box, both root-owned 0600 and gitignored:
`.env` (from `.env.example`) and `secrets/db_svc_password`. `make deploy` refuses before
rolling if either is missing, or if `tic-db` is not healthy.

`/api/health` is liveness and says nothing about the database — restarting the container
does not fix a database that is down. `/api/readyz` is the one that reads `directory.*`,
and answers 503 with the reason when it cannot.

## Doctor

```sh
make doctor                              # the report, painted if you are looking at it
/opt/tic-campus/bin/doctor.py --json     # the same run as one document, for tic-platform
python3 bin/test_doctor.py               # its tests
```

`bin/doctor.py` is this stack's diagnosis in tic-host's contract
(`tic-host/docs/doctor-contract.md`, `schema_version: 2`; `../DEPLOY-CONVENTIONS.md` §8),
read by `tic-platform/bin/tic-doctor` from its `STACKS` table. Python 3, stdlib only, one
executable file: on the box Node exists only inside the containers. Every finding is
`platform`; exit 1 only on a `fail`. Off the box every check `skip`s and it exits 0.

| Check                | What moves it                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `containers-settled` | **fail** a container named in `docker-compose.yml` is missing, not `running` across three reads, or `unhealthy` (the api's is `/api/health`) · **warn** health `starting`, or a restart within the last minute |
| `web-api-proxy`      | **fail** `/api/health` asked inside `tic-campus-web` does not come back from the api — the nginx hop neither healthcheck covers                                                                                |
| `db-reachable`       | **fail** `/api/readyz` asked inside `tic-campus-api` does not answer ok — the stack is up and cannot serve anything that needs data, which no healthcheck notices                                              |

Left to tic-platform, because a stack checks only what it deploys: `/opt/tic-campus`'s git
drift, `tic-campus-edge` membership, and the origin through tic-proxy (which `make smoke`
also asks).
