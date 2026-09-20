# tic-campus

`api/` (TypeScript, Node) and `web/` (TypeScript), one pnpm workspace.

```sh
pnpm install
pnpm build          # both
pnpm typecheck
pnpm test           # the api's own checks
pnpm format         # prettier

pnpm --filter tic-campus-api db:generate   # after editing api/src/db/schema/
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

Three files live only on the box, all root-owned 0600 and gitignored: `.env` (from
`.env.example`), `secrets/db_svc_password` and `secrets/db_owner_password`. The first two
are what the container needs and `make deploy` refuses before rolling if either is missing,
or if `tic-db` is not healthy; the third is read on the host by `make migrate` and never
enters a container.

Campus owns three tables so far — the article library and the program units
(`api/src/db/schema/`, `docs/FEATURES.md` F37). Schema changes are Drizzle migrations:

```sh
make migrate        # `make deploy` already does this, after the roll
```

Boot does **not** migrate and cannot, since `campus_svc` holds no `CREATE`. So a container
serving against a schema older than its own code is a state that exists, and `/api/readyz`
is what says so.

`/api/health` is liveness and says nothing about the database — restarting the container
does not fix a database that is down. `/api/readyz` is the one that reads `directory.*` and
counts the applied migrations against the ones this build carries, and answers 503 naming
which of the two failed.

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
| `db-reachable`       | **fail** the `db` half of `/api/readyz`, asked inside `tic-campus-api`, is not ok — the stack is up and cannot serve anything that needs data, which no healthcheck notices                                    |
| `schema-current`     | **fail** the database has fewer migrations applied than this build carries — `make deploy` rolled and `make migrate` was skipped or failed, so the new routes run against an old schema                        |

Left to tic-platform, because a stack checks only what it deploys: `/opt/tic-campus`'s git
drift, `tic-campus-edge` membership, and the origin through tic-proxy (which `make smoke`
also asks).
