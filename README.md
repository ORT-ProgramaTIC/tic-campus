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

**Once per box, before the first deploy**, the volume that holds every uploaded file (F9):

```sh
docker volume create tic-campus-uploads
```

It is `external: true` in compose and created by hand for the same reason tic-platform's
`tic-db-data` is: these are teachers' files, the only copy outside the nightly backup, and
`docker compose down -v` must not be able to take them. `make deploy` refuses before
building if it is missing, and tic-platform's `bin/backup.sh` archives it beside the
database dump — a lost volume is not a lost cache, it is broken articles the database still
points at.

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

#### Los archivos, sin salir de la máquina

The upload routes need a session but not tic-auth: the four-step login is unchanged, so a
row inserted straight into `campus.session` — `id = sha256(cookie value)`, fresh
`claims_at`, any `csrf` — drives them with two headers. Off production the cookie is
`tic_campus_session_dev`, and `UPLOADS_DIR` can be any writable directory.

```sh
curl -s -H "Cookie: tic_campus_session_dev=$SECRET" -H "X-CSRF-Token: $CSRF" \
  -F 'file=@Guía de TPs.pdf;type=application/pdf' \
  http://127.0.0.1:3000/api/subjects/1/uploads            # 201 { id, sha256, … }
curl -si http://127.0.0.1:3000/api/uploads/$ID | head -5  # 200, sin cookie ninguna
```

Worth checking by hand after any change here: a file over 20 MB is `413 file_too_large` in
the envelope and not an HTML page; an `evil.html` comes back `application/octet-stream` +
`attachment`; and an accented filename survives the round trip — busboy decodes multipart
filenames as **latin1** unless told otherwise, which is why `defParamCharset: "utf8"` is set
where multer is built.

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

`api/scripts/harness-redos.mjs` is that whole setup written down — container, migrate, seed,
sessions, api — with slice 10's assertions on the end. `node scripts/harness-redos.mjs` from
inside `api/`, and it removes its container either way. **Copy it and replace the
assertions** rather than writing the scaffolding again: the four things that cost time are
in its preamble, and the sharpest is that the api must be spawned _after_ the migrate and
the seed, or its pool points at a database with no schema and the symptom is an
`ECONNREFUSED` that reads like a port problem.

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
POST   /api/subjects/:id/uploads                       staff     subir un archivo: multipart, campo «file» (F9)
GET    /api/subjects/:id/uploads                       staff     los archivos de la materia, del último al primero
GET    /api/uploads/:id                                público   los bytes (F9)
PUT    /api/homes/:oferta/articles/:articleId          staff     usarlo: unidad, orden, fecha, visibilidad, notas y qué recupera (F4, F8, F18, F23)
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

**Un archivo se sirve a quien tenga su id** (F9). `campus.upload` is the index and the
bytes are on the `tic-campus-uploads` volume, at `<UPLOADS_DIR>/<id>`. There is deliberately
no visibility check: the reference from an article to a file is `::download{file=<id>}`
inside the Markdown, the api parses no Markdown, and the check would only have stopped
somebody guessing a uuid — F9 and F37 carry that decision and its upgrade path. There is no
`DELETE` either, for the same reason: nothing knows which articles a delete would break.

**What campus serves is not what was uploaded.** `serveAs` allows PNG, JPEG, GIF, WebP,
AVIF and PDF `inline` as themselves; **everything else, `image/svg+xml` included, is
`application/octet-stream` + `attachment`**, always with `nosniff`. An SVG is a document
that runs script, and these files come from the origin the app runs on. Nothing is refused
at upload time — a starter zip is the point.

**Three size limits, and only one of them is in the api's own code.** multer caps a file at
20 MB and answers `413 file_too_large`; `express.json` stays at 1 MB, because raising it to
fit a PDF would hand every JSON route a 20 MB buffer; and `client_max_body_size 20m` in
`docker/web/nginx.conf` is the one that bites — without it nginx answers its own HTML 413 at
**1 MB**, before the request reaches the api, and the client never sees the error envelope.

**A slug is set once** (F32) and is rejected rather than repaired: `checkSlug` refuses
anything `slugify` would change, and says what to type instead. Silently normalizing would
make two different titles collide into a 409 naming a slug neither author wrote. There is no
rename, so there is no old slug to redirect from yet — when rename arrives it wants a
`previous_slug` column, not a table. Archiving keeps the slug (the unique index is total),
and re-creating it revives that row, so one typo does not burn a URL forever.

## Las notas

Everything above is content. The reason the old campus exists at all is marks, and this is
the floor under them: what an offering **names** (F39), which of its articles are
**activities** (F18), what a student **got** (F38), and — since slice 8 — the **formula that
turns those results into a mark** (F20, F40). Nothing was stale for having waited a slice,
because computed marks are never stored: they are derived on every read, from the rows the
read already has.

```
GET    /api/homes/:oferta/gradebook                     staff     la grilla entera, de una (F26)
PUT    /api/homes/:oferta/gradebook                     staff     grupos, trimestres, escalas y la política de recuperatorios — nunca borra (F39, F23)
DELETE /api/homes/:oferta/gradebook/groups/:id          staff     409 si tiene actividades adentro
DELETE /api/homes/:oferta/gradebook/terms/:id           staff     idem
DELETE /api/homes/:oferta/gradebook/scales/:id          staff     idem; se lleva sus niveles
POST   /api/homes/:oferta/gradebook/preview             staff     una fórmula en borrador, sobre los estudiantes de verdad (F20)
PUT    /api/homes/:oferta/results                       staff     guardar cada celda tocada, en una llamada (F38)
PUT    /api/homes/:oferta/official-grades               staff     la nota del boletín que se escribe a mano (F22)
GET    /api/homes/:oferta/results/mine                  sesión    mis notas publicadas, mi nota calculada y mi nota del boletín (F24, F22)
```

**La fórmula.** `PUT …/gradebook` carries each term's `formula` and the offering's
`finalFormula` as **source text** (F40) — `0.7*avg(tps) + 0.3*10*done_ratio(clase)`, over the
offering's **group names**, quoted when a name has a space: `avg("Trabajos Prácticos")`. The
final is a second formula over the **term** names. `api/src/offerings/formula.ts` parses it by
hand, with no `eval` and no dependency, and gives one of three things per cell: a number,
`null` for _sin nota_, or an error a teacher can read — never `NaN`, and division by zero is
an error rather than a quiet blank.

Two refusals are worth knowing before you save anything. A formula names a group, so **a
rename that would orphan one is a `409`** (F39) — fix the name and the formula in the same
body, which is why they travel together. And `deleteGroup`/`deleteTerm` refuse a row a
formula names, under the same codes the in-use refusal already uses.

**Los recuperatorios.** Un recuperatorio **es una actividad** (F23): lo que lo hace
recuperatorio son las filas de `redo_covers`, que se escriben con `covers` en el mismo `PUT
…/articles/:articleId` que le pone grupo y trimestre. No cuenta por sí solo — actúa sobre
las notas que cubre y en ningún otro lado —, y qué les hace es la política de la oferta
(`redoPolicy` en `PUT …/gradebook`): `max` por defecto, más `replace` y `average`. Sin nota
cargada no pasa nada (una nota en blanco es una fila ausente, F38); sobre un original en
blanco, la reemplaza en las tres políticas. Se resuelve **antes** del evaluador, sobre la
lista de actividades que ese lector puede ver — que es por qué publicar un recuperatorio no
necesitó una regla nueva. Un recuperatorio no recupera a otro recuperatorio, ni a sí mismo,
y lleva el mismo tipo de nota que lo que cubre.

`GET …/gradebook` returns `computed` per student, **both views side by side** (F24): `all` is
what the teacher is looking at, `published` is what the student would see right now. One
evaluator, called twice with different **activity lists** — filtering the list and not just
the results is what keeps an unpublished activity out of `done_ratio`'s denominator, where it
would leak that it exists.

**Two routers, one prefix, one `guard`.** The gradebook hangs off `/api/homes` beside
`home-content.ts`, for the reason that prefix exists — its segments are ids, not a public
URL. What the two must not each have is their own `router.use(guard)`: a request for
anything here would walk the other router's guard first, match nothing, and read and renew
the session a second time on the way through. So the guard is on the mount, in `index.ts`.

**`staff` here is `manageOffering`, and only that.** `editLibrary` is teaching _any_
offering of the subject in _any_ year, which is the right gate for fixing a typo in an
article and the wrong one for reading a class's marks. The two gates already differed for
the library; this is the first place where the wider one is a refusal.

**Una actividad es un artículo con metadatos de nota** (F18), on the _use_ and not on the
library article — so the same TP is graded in one offering and practice-only in another.
`value_type` not null is the whole of "is this graded": a theory note is an article
without it. A term comes with it (F21), a scale exactly when the type is `scale`, and a
group is optional, because an activity in no bucket is one the formula ignores.

**No hay enums ni `CHECK` en `campus`, y eso no es descuido.** `value_type` is `text`
checked in the api, beside `checkSlug` and `checkUnits`, because a value domain is one a
single writer can enforce alone and the api is the only writer. The unique
`(offering_home_id, name)` indexes in `gradebook.ts` are the opposite case and are
therefore the database's: two concurrent saves cannot both check-then-insert. The cost is
one real edge — swapping two group names in one save raises on the first `UPDATE`, and the
answer is a `409` telling the teacher to save it in two steps rather than a rename through
a temporary name campus invented.

**Publicar el enunciado y publicar las notas son dos fechas** (F24). `published_at` decides
when the article appears; `results_published_at` decides when its marks do. A teacher posts
the TP statement on Monday and marks it on Friday. The rule is one function,
`resultsVisible`, and it deliberately does **not** consult the article's own visibility:
hiding a statement in October is not a request to take back September's marks, and a
student watching them vanish could not tell that from a mistake.

**Una celda vacía es una fila que no está.** `result.value` is `NOT NULL`, F20's "blank"
already means a missing row, and a nullable value would be a second spelling of it for the
evaluator to branch on. So `value: null` is the **only** way to clear a cell, and it is
said out loud: `{"done": false}` is _not done_ and `{"value": 1}` is a one, and the obvious
falsy check would have silently deleted both. An entry carrying none of `value`, `done` or
`scaleLevelId` is a `400`, so "feedback only" is an error rather than a lost mark.

**The whole-list `PUT` never deletes**, exactly like `PUT …/program` (F15) and for the same
reason. `PUT …/results` is the other kind and does not need the rule: entries nobody sent
are untouched, so there is no delete by omission to protect anyone from. What it does need
is the check that every activity id in the body belongs to _this_ home — the route gates
the offering in the path, and the ids come from the body.

**Un resultado no lleva curso** (F38). The roster is joined live, the way every other read
here does it, so a student who changes course in April does not change what they did in
March. Enrolment is checked when a result is **created** and never again: the writable set
is _enrolled now, plus whoever already carries a mark_, and the grid lists somebody who
left flagged rather than hiding them — hiding them would hide the mark that still needs
fixing. It reads `id`, `name` and `surname` and deliberately not `dni`; F27's import is
where matching on a DNI belongs.

**La otra nota del boletín** (F22). `official_grade` is the number a teacher **types**,
per student per term, with its `observación` and its `sugerencia` — the `Notas Fijas` sheet
and the `Nota - Observación - Sugerencia` string it was parsed out of. It rides in
`GET …/gradebook` beside the computed one and in `GET …/results/mine` as `official`, because
a boletín draws both numbers on one row and cannot do it in two round trips.

**Se ve apenas existe**, and there is no third publish date. F24's `results_published_at`
belongs to an `offering_article` and has nothing to say about a term, and the honest reading
of the alternative is that a teacher types the boletín grade _when the boletín is due_ — a
draft state here would be a flag nobody flips, standing between a student and a grade that
is already decided. `resultsVisible` stays the rule for **results** and does not grow a
third meaning. The save is `PUT …/results`'s shape and not `PUT …/gradebook`'s: touched
entries, `value: null` to clear, and clearing takes the two texts with it — an observation
has no home without its grade.

**One read, and one write, whatever the size.** `GET …/gradebook` answers with the setup,
the presets, the activities, the roster and the marks together, because the grid cannot
draw a column header without the groups and a second round trip is a second thing that can
disagree with the first. `PUT …/results` is one `insert … on conflict do update` for
everything set and one `delete` for everything cleared. This is campus's first read that is
N students × M activities, and `campus_svc` is capped at 15 connections against a pool of
10 — a loop here is where that number stops being a comment.

**`SCALE_PRESETS` viaja adentro de la lectura** and is **not a resource** (F42): there is no
`GET /api/scale-presets` and there should not be. A teacher seeds a scale from one and what
lands in `offering_scale` is the copy their offering owns, so editing a preset later reaches
nobody — a mark already given does not move because somebody changed a word in the api.
What a level is worth _can_ be changed, and then it moves the marks given on it, in the same
transaction: a result stores the number and not the level, which is what keeps the future
evaluator from branching per type.

**Three refusals worth knowing before you hit them**, all `409`, all for the same reason —
a foreign key would otherwise surface as a 500 on something a teacher can fix: a group,
term or scale still referenced by an activity; an activity with marks being un-graded
(`results_exist`); and an activity with marks being taken out of the offering
(`activity_has_results`). The last two are on `PUT`/`DELETE /api/homes/:oferta/articles/…`,
which is the article panel's route — that `PUT` writes the row **whole**, so a client
sending half a panel saves half a panel, and this is the one case where that is not
recoverable by saving again.

**The grants.** `campus_app`'s DML comes from `db/migrate.ts` walking the schema barrel, so
a table missing from `db/schema/index.ts` typechecks fine, migrates fine, and fails on its
first write in production. `api/test/db.test.mjs` is the only place that ever exercises
one: every call there goes through `campus_svc`, and a read proves nothing — the slice-7
subtests insert, update and delete against each of the five new tables for exactly that
reason.

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
