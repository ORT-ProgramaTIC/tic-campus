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

Four files live only on the box, all root-owned 0600 and gitignored: `.env` (from
`.env.example`), `secrets/db_svc_password`, `secrets/tic_auth_client_secret` and
`secrets/db_owner_password`. The first three are what the container needs and `make deploy`
refuses before rolling if any is missing, or if `tic-db` is not healthy; the last is read on
the host by `make migrate` and never enters a container.

`root:root` on the two mounted secrets is a property of `docker/api/Dockerfile` rather than
of the secrets: it sets no `USER`, so root is the uid that opens them. Adding one means
chowning both in the same commit (`../DEPLOY-CONVENTIONS.md` §4).

Campus owns seven tables so far — the article library, the program units, the two the login
needs, `offering_home` and `offering_article` (`api/src/db/schema/`, `docs/FEATURES.md`
F37). Schema changes are Drizzle migrations:

```sh
make migrate        # `make deploy` already does this, after the roll
```

Boot does **not** migrate and cannot, since `campus_svc` holds no `CREATE`. So a container
serving against a schema older than its own code is a state that exists, and `/api/readyz`
is what says so.

`/api/health` is liveness and says nothing about the database — restarting the container
does not fix a database that is down. `/api/readyz` is the one that reads `directory.*` and
counts the applied migrations against the ones this build carries, and answers 503 naming
which of the two failed. It deliberately says nothing about tic-auth either: that is a
network hop off this box, and `auth-reachable` in the doctor is where it is asked.

## El login

Campus is a **confidential tic-auth client** (`docs/FEATURES.md` F3,
`tic-auth/docs/CLIENTS.md`). The browser only ever talks to this origin: `tic-campus-api`
does the code exchange with a client secret, keeps the tokens in `campus.session` behind an
HttpOnly cookie, and refreshes them on the person's behalf.

```
GET  /api/auth/login?next=/donde     302 -> tic-auth /authorize
GET  /api/auth/callback              canje, verificación, Set-Cookie, 302 -> next
GET  /api/me                         401, o { me, csrf_token, idp_logout_url }
POST /api/auth/logout                revoca, limpia, 200 { idp_logout_url }
```

**Registering the client is a step on tic-auth's box, not here**, and it happens once,
before the first deploy that has this code. As root in `/opt/tic-auth` — `issue-secret`
**must** run in the `app` container, the only one with the real pepper, and it prints the
secret **once**:

```sh
docker compose exec -T app python -m scripts.manage_clients register \
  --client-id tic-campus --name "Campus TIC" \
  --audience tic-campus --audience tic-directory \
  --confidential \
  --redirect-uri https://tic-campus.ort.edu.ar/api/auth/callback \
  --grant authorization_code --grant refresh_token \
  --home-uri https://tic-campus.ort.edu.ar/
docker compose exec -T app python -m scripts.manage_clients check-redirect \
  --client-id tic-campus --uri 'https://tic-campus.ort.edu.ar/api/auth/callback'
umask 077
docker compose exec -T app python -m scripts.manage_clients issue-secret \
  --client-id tic-campus --name 'campus api' --days 365 --quiet \
  > /opt/tic-campus/secrets/tic_auth_client_secret
chmod 600 /opt/tic-campus/secrets/tic_auth_client_secret
test -s /opt/tic-campus/secrets/tic_auth_client_secret \
  && head -c 13 /opt/tic-campus/secrets/tic_auth_client_secret; echo
```

**`cd /opt/tic-auth` is load-bearing and `2>/dev/null` is not.** `app` is tic-auth's
service; from `/opt/tic-campus` the same command answers `service "app" is not running`.
tic-auth's own docs write that redirect with `2>/dev/null`, and it is worth leaving off:
with `--quiet` only the credential goes to stdout and `prefijo …, vence …` already goes to
stderr (`scripts/manage_clients.py:765`), so suppressing stderr hides nothing but the
errors — and a failed `issue-secret` then writes its empty stdout over the secret. That is
why the last line checks the file is not empty, and why `make deploy` checks the same
thing with `test -s` before it rolls.

Every flag is load-bearing. `--confidential` because a public client with the code grant is
a browser doing its own exchange, which is the design `CLIENTS.md` retires.
`--grant refresh_token` is **opt-in and never implied** by `authorization_code` — without it
campus gets a fifteen-minute token and nothing to renew it with, and signs everyone out
every fifteen minutes. The first `--audience` is the default a request naming none gets, so
the order is meaning. `--home-uri` needs its trailing slash. No `--scope` at all: campus
reads the directory over SQL, and `narrow_scopes` refuses a scope the client is not
registered for rather than dropping it quietly.

The redirect URI is matched **byte for byte**, at `/authorize` and again at `/token`, which
is why it is static configuration and never derived from a request: nginx is `listen 80`
behind two proxies, so a derived scheme is always `http`. When the callback lands on an
error page instead, `check-redirect` prints the index of the first differing character.

Without `secrets/tic_auth_client_secret` the four routes above do not exist — 404, never 401
or 503, so nothing loops through a login that cannot complete — and in production the
container refuses to boot at all.

### Off the box

`tic-auth.ort.edu.ar` is unreachable from a laptop, so the login is driven against
**tic-host's `tools/mock_oidc.py`** (`make dev-auth` there, `127.0.0.1:8899`). Point
`TIC_AUTH_ISSUER`, `TIC_AUTH_INTERNAL_BASE_URL` and `TIC_AUTH_JWKS_URL` at it.

It proves the round trip and **not** the refusals: it never reads `code_challenge` or
`code_verifier`, never validates `client_id`, `client_secret` or `redirect_uri`, mints a
token for an unknown `code`, and hardcodes `acr: "strong"`. Everything it cannot test —
`acr=campus`, `alg: none`, HS256 confusion, a wrong audience, the `Host` header, the
single-flight — is in `api/test/auth-*.test.mjs`, signed against a locally generated key.

#### Una sesión de verdad, para probar las rutas a mano

`make test-db` proves the queries; it never builds a session. To exercise the routes as a
signed-in person — the `roles[]` gate on `/mine`, `can` through `optionalSession`, the CSRF
check and `requireAdmin`'s 403 — the whole stack has to run on the host, because the mock is
on loopback. Three things bite, and all three are about the mock being a **fixture rather
than a configuration**:

- **`PEOPLE` has no `admin` persona and its `sub` values are fixture numbers.** `sub` _is_
  `public."user".id`, behind a real foreign key (`campus.session.user_id`), and roles come
  only from the token — campus stores none. So a database row cannot make anybody an admin,
  and the three shipped personas cannot reach `/api/admin/offerings` at all. `PEOPLE` is a
  module global read inside `_issue`, so a wrapper that imports `mock_oidc`, replaces it with
  personas whose `sub` matches the seeded ids, and calls `build_app` costs a dozen lines and
  edits nothing in tic-host. Give `admin` and `admin-hosting` the _same_ `sub`: then the 403
  the second one gets is attributable to the role and to nothing else.
- **The audience.** The mock defaults to `tic-directory` and campus asserts `tic-campus`
  (`TIC_AUTH_AUDIENCE`). `build_app(issuer, "tic-campus")`, or the flag.
- **The cookie is `tic_campus_session_dev`**, not the `__Host-` one, whenever `NODE_ENV` is
  not `production` — a curl sending the production name looks like a broken session.
- **The client secret is read from a _file_**, `TIC_AUTH_CLIENT_SECRET_FILE`, and there is no
  inline variable to set instead. Exporting a `TIC_AUTH_CLIENT_SECRET` that nothing reads
  leaves `config.auth` unset, and then the four `/api/auth/*` routes simply do not exist —
  so the first symptom is a **404 on `/api/auth/login`**, which reads like a mounting bug
  rather than a missing secret. `printf 'anything' > /tmp/secret` is enough; the mock never
  checks it.

The login is four steps, not one redirect, because `/authorize` serves a consent **form**:
`GET /api/auth/login` (keep the cookie jar, read `state` and `redirect_uri` off the
`Location`) → `POST /approve` with `who` → `GET` the callback it returns, with the jar →
`GET /api/me`, whose `csrf_token` is what every non-GET needs in `X-CSRF-Token`. CSRF is not
a cookie: it lives in the session row, so it can only come from `/api/me`.

Note the refusal order on an admin write — `guard` runs before `requireAdmin`, and the CSRF
check is _inside_ `guard`. A signed-in non-admin with no CSRF token gets `csrf_failed`, so
reaching the `forbidden` 403 at all requires sending a **valid** one.

The database is `make test-db`'s recipe with the container left running: the roles are
cluster-wide, so throw it away afterwards or the next run fails on
`role "campus" already exists`.

## Las materias

Campus owns no roster (F5). Who teaches what, who is enrolled in what and which courses an
offering serves are all read live from tic-auth's `directory.*` views, and the only thing
campus stores about an offering is that an admin said it is ours — `campus.offering_home`,
one row, which **is** the activation (F34). An offering the directory knows about and
nobody activated has no campus presence at all: not an empty home, not a 200 with nothing
in it.

```
GET    /api/offerings?year=2027                    público   el listado para elegir (F6)
GET    /api/offerings/mine?year=2027               sesión    "Mis materias" (F6)
GET    /api/offerings/:year/:materia/:oferta       público   resolver una URL pública (F32)
GET    /api/admin/offerings?year=2027              ADMIN     el directorio, con qué está activado
POST   /api/admin/offerings/:id/activation         ADMIN     activar (idempotente)
DELETE /api/admin/offerings/:id/activation         ADMIN     desactivar (archiva, F36)
```

**`year` is optional and absent means the _current_ school year**, which `directory.*`
states as `is_current` — never `new Date().getFullYear()`. Which year is current is
tic-auth's fact; a campus that computed its own would disagree with the directory in the
weeks either side of a year change and the symptom would be an empty site.

**The URL is derived and never stored** (F32): `/<año>/<materia>/<oferta>`, where the
offering's segment is its own name if it has one and its courses' names if it does not. A
directory rename therefore changes the URL, which is the point — there is no stored copy to
keep in step. Two offerings that would produce the same URL both resolve to **404** rather
than one of them winning.

**Deactivating archives, it does not delete** (F36, slice 5). The home now has an
offering's articles hanging off it, so a `DELETE` behind an idempotent admin button would
throw away a teacher's work — and a cascade would, in time, reach students' marks. The row
stays with `archived_at` set, every public read filters it out, and re-activating brings
the whole home back. `DELETE …/activation` answers `archived`, not `removed`.

### Three relations that look like one question

This is the trap, and it has already cost tic-auth a migration to discover:

| the question                    | the relation                                         |
| ------------------------------- | ---------------------------------------------------- |
| is this person a student at all | the token's `roles[]`                                |
| what course are they in         | `directory.student_course` — campus does not read it |
| what are they taking            | `directory.enrollment`                               |

On the 2026-09-02 snapshot, courses `NR5A`–`NR5E` had no `offering_course` rows, so
`directory.enrollment` omitted **129 of 356** current students. A student in that state sees
an empty "Mis materias", and **that is a directory row to add, not a campus bug** — the fix
is in BurocraTIC, and a `UNION` against `student_course` here would only hide it.

For the same reason, which half of "Mis materias" runs is decided by `roles[]` and not by
what the tables return: staff carry enrolments, and the real snapshot has an `admin` holding
one.

### The database tests

`pnpm test` needs no database. The joins and the grants do, and they are in
`api/test/db.test.mjs`, skipped unless `TEST_DATABASE_URL` is set:

```sh
make test-db                                    # throwaway Postgres, removed either way
pnpm --filter tic-campus-api db:stubs:check     # ¿siguen al día los stand-ins?
```

It applies `api/test/support/directory/standins.generated.sql` — a **generated** slice of
tic-auth's schema, committed, so neither Python nor a tic-auth checkout is needed to run the
tests — then creates campus's four roles and runs the real migrator as `campus_owner` and
the queries as `campus_svc`. That is what makes a missing `GRANT` a failing test instead of
a deploy that dies in a container log. Regenerating it (`db:stubs:generate`) needs both, and
`db:stubs:check` skips rather than fails when tic-auth is not on disk.

## Los artículos

An article belongs to a **subject's library**, not to a course and not to a year (F8). An
offering _uses_ it, and the use carries what differs between offerings: where it sits, when
it appears and who may read it. Next year's offering uses the same row, which is what makes
a fix reach every year instead of the one whose copy somebody remembered.

```
GET    /api/subjects/:id/articles                      staff     el índice de la biblioteca (F8)
POST   /api/subjects/:id/articles                      staff     crear: slug y título (F8, F32)
GET    /api/subjects/:id/articles/:slug                staff     borrador, publicada, historial (F11)
GET    /api/subjects/:id/articles/:slug/versions/:vid  staff     el cuerpo de una revisión (F11)
PUT    /api/subjects/:id/articles/:slug/draft          staff     guardar borrador (F11, F12)
POST   /api/subjects/:id/articles/:slug/publish        staff     mover el puntero (F8, F11)
DELETE /api/subjects/:id/articles/:slug                staff     archivar (F36)
GET    /api/subjects/:id/program                       staff     las unidades (F15)
PUT    /api/subjects/:id/program                       staff     crear/renombrar/reordenar (F15)
DELETE /api/subjects/:id/program/:unitId               staff     borrar una unidad (409 si está en uso)
PUT    /api/homes/:oferta/articles/:articleId          staff     usarlo: unidad, orden, fecha, visibilidad (F4, F8)
DELETE /api/homes/:oferta/articles/:articleId          staff     dejar de usarlo
GET    /api/offerings/:año/:materia/:oferta            público   ahora con programa y artículos (F13, F15)
GET    /api/offerings/:año/:materia/:oferta/:artículo  público   leer un artículo publicado (F4, F32)
```

`staff` is **not one gate**. The library is `editLibrary` — teaching _any_ offering of that
subject, in _any_ year — so a teacher fixing a typo in a 2026 article does not have to still
be teaching 2026. What an offering does with an article is `manageOffering`, which is
teaching _that_ offering. Both come from `capabilitiesFor` (F5) and neither reads `roles[]`.

**`/api/offerings` segments are a public URL; `/api/homes` segments are ids.** The two could
have shared a prefix, and that is exactly the trap: `/api/offerings` owns
`GET /:year/:subject/:offering`, Express matches in mount order, and the first staff `GET`
hung under it would be read as a public URL and answer `400 invalid_year` before anything
had a chance to 404. Today's two routes are a PUT and a DELETE, so nothing collides — which
is a coincidence, not a design, and a separate prefix costs one string.

**The api parses no Markdown, on purpose** (F7). `article_version.body` goes in and comes
out as the teacher typed it, directives and all. `remark-directive`, the `:::callout` /
`::download{…}` allowlist and the component set are the renderer's, because the alternative
is a server that decides how content looks — and the interface is a person's job (F44).

**Publishing is moving a pointer.** `POST …/publish` writes `article.published_version_id`
and nothing else, so every offering using that article serves the new text on its next
request, past years included (F8). There is no per-offering copy to update and no deploy.
Pinning a version per offering was rejected _because_ propagation is the reason the library
exists.

**There is no restore endpoint, and that is the feature.** Restoring a revision is
`GET …/versions/:vid` followed by `PUT …/draft` with that body — two calls the client
already has. The revision list comes back inline from the article read, because without it
there is nothing to restore _from_.

**Two teachers, last write wins — but not silently** (F12). `PUT …/draft` carries the
`baseVersionId` the edit started from; a save against a stale one is refused `409
stale_draft` with the other author's name in the message, and saving again against the
current one goes through. No lock, no CRDT, no websocket for something that is rare.

**An article nobody may read answers 404, never 403** (F4). A use is public when the library
article is published, `publishedAt` has arrived, and `restricted` is false — otherwise it
needs `seeOwnMarks` (enrolment) or staff. A 403 would confirm the article is there, which
for an exam statement or a solution is most of what somebody fishing wanted to know. The
rule is one function, `mayRead`, called by the home's list _and_ by the article page, so
they cannot disagree.

**The program lives in the library and every offering shows it** (F15). Units are typed once
and group the offering's articles (F13). An offering reordering or hiding units _for itself_
is deferred to F14 with the `offering_unit` table it needs — see F15 for why, and for why
deferring it makes propagation stronger rather than weaker. **`PUT …/program` never
deletes**: a teacher saving a list they loaded before a colleague added a unit would
otherwise wipe it, and by foreign key every article filed under it, with no version history
to recover from.

**A slug is set once** (F32) and is rejected rather than repaired: `checkSlug` refuses
anything `slugify` would change, and says what to type instead. Silently normalizing would
make two different titles collide into a 409 naming a slug neither author wrote. There is no
rename, so there is no old slug to redirect from yet — when rename arrives it wants a
`previous_slug` column, not a table. Archiving keeps the slug (the unique index is total),
and re-creating it revives that row, so one typo does not burn a URL forever.

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

| Check                | What moves it                                                                                                                                                                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `containers-settled` | **fail** a container named in `docker-compose.yml` is missing, not `running` across three reads, or `unhealthy` (the api's is `/api/health`) · **warn** health `starting`, or a restart within the last minute                                                                 |
| `web-api-proxy`      | **fail** `/api/health` asked inside `tic-campus-web` does not come back from the api — the nginx hop neither healthcheck covers                                                                                                                                                |
| `db-reachable`       | **fail** the `db` half of `/api/readyz`, asked inside `tic-campus-api`, is not ok — the stack is up and cannot serve anything that needs data, which no healthcheck notices                                                                                                    |
| `schema-current`     | **fail** the database has fewer migrations applied than this build carries — `make deploy` rolled and `make migrate` was skipped or failed, so the new routes run against an old schema                                                                                        |
| `auth-reachable`     | **fail** `tic-campus-api` cannot read tic-auth's key set through tic-proxy — the stack is up and nobody can sign in. It asserts a `kid` and **never** a 200: the `Host` header fails soft, and without it nginx's default server answers 200 with a body that is not a key set |

Left to tic-platform, because a stack checks only what it deploys: `/opt/tic-campus`'s git
drift, `tic-campus-edge` membership, and the origin through tic-proxy (which `make smoke`
also asks).
