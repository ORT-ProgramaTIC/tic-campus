# tic-campus — feature list

The living checklist for the new tic-campus, ORT's course site: subject pages, articles,
activities and marks. Nothing here is a commitment to build. An item resolved as
**dropped** counts as completed, not as a failure. Each item records the _reasoning_ behind
its decision, so a later session doesn't re-argue a settled question.

tic-campus is one repository: a Node/TypeScript API and a React frontend in one pnpm
workspace (`api/` + `web/`), specified by this document. It replaces the old campus
(Astro on GitHub Pages, Express on Vercel, Google Sheets as the datastore). **It is a
rebuild, not a port**: nothing from the old repos is carried over as code.

Decisions already locked in before this list existed (recorded here so they aren't
re-argued per item):

| Question          | Answer                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is        | Per-offering course sites: articles, activities, a gradebook, marks for students                                                                                                                  |
| Surface           | **Standalone** at `tic-campus.ort.edu.ar`. No campus.ort.edu.ar embed, no shadow DOM, no `loadFromLink.html`. campus.ort at most links here                                                       |
| Web               | React 19 + Vite + Tailwind 4 + TanStack Query + React Router. A static SPA served by `tic-campus-web` (nginx), the same stack as BurocraTIC, MEV and tic-host                                     |
| API               | Express 5 + Drizzle + pg + jose + pino, SQL migrations checked in. **Mirrors MEV.** No Prisma                                                                                                     |
| Identity          | **tic-auth**, as a confidential backend client (`tic-auth/docs/CLIENTS.md`). Campus mints no tokens. The campus.ort PHPSESSID relay is gone, and login is whatever tic-auth offers (Google or AD) |
| Roster            | **Read live from the `directory.*` views.** Campus owns no users, courses, subjects, offerings, enrollments, time slots or teacher assignments                                                    |
| Datastore         | The `campus` schema in the shared `tic-db`. **No Google Sheets anywhere**                                                                                                                         |
| Hosting           | Co-tenant stack at `/opt/tic-campus` (M14), `tic-campus-edge` + `tic-db` (api only)                                                                                                               |
| Launch            | **School year 2027.** The old campus finishes 2026 untouched. No data migration, no marks import, no article conversion                                                                           |
| Document language | This document is in English. **All user-facing copy is in Spanish (rioplatense)**                                                                                                                 |
| Sequencing        | Items are grouped by area, not by delivery phase. Sequencing lives in each item's **Status**                                                                                                      |

---

## Item format

```markdown
### F<n> · <title>

- [ ] **Status:** open | decided | deferred | building | done | dropped
- **Prior art:** ... (only where a sibling or the old campus already answered this)
- **To settle:** the actual open question(s)
- **Decision:** _(filled in when made, with the reasoning — not just the answer)_
```

---

## Group A — Ground rules

### F1 · What tic-campus is for

- [x] **Status:** decided
- **Decision:** A place where each offering (a subject taught to some courses in some year)
  publishes its content and where students see how they are doing. In priority order:
  1. **Content.** Teachers publish articles (theory notes, activities, TPs) without a
     deploy, without git and without a developer.
  2. **Marks.** Students see their published results, feedback and running mark, and
     teachers keep the gradebook in the same place the activities live.
  3. **One place per offering.** Each offering has a home that links its content, calendar,
     timetable and marks.

### F2 · Explicit non-goals

- [x] **Status:** decided
- **Decision:** Each of these has a better owner or was not worth carrying over:
  - **Directory admin** (students, offerings, time slots, avanzados). This is tic-directory's
    `/admin/` (BurocraTIC), M11(c).
  - **Listados, grillas, grillas-estudiantes.** These are reports over directory data, so
    they belong to tic-directory.
  - **Impersonation / view-as-student.** Also tic-directory's. Campus does not mint
    identities.
  - **The campus.ort embed.** Its reason to exist was the PHPSESSID relay, and login no
    longer goes through campus.ort. The embed brought shadow DOM, CSS-variable mirroring and
    a script loader that re-executes `<script>` tags, all of which is dropped.
  - **Student submissions** (uploads or repo links per activity). Not for launch.
  - **Email.** Notifications are in-app only (F30).
  - **Hand-written per-subject pages.** Homes are configured, not coded (F14).
  - **Search, dark mode and print stylesheets.** Not for launch. Nothing in the design stops
    adding them later.
  - **Carrying over 2025/2026 content or marks.** Teachers re-author for 2027, and the old
    site stays up until the 2026 year ends.

---

## Group B — Identity and access

### F3 · Login, through tic-auth

- [x] **Status:** built (slice 3)
- **Prior art:** `tic-auth/docs/CLIENTS.md`, with `MEV/api/src/auth/` as the TypeScript
  reference implementation.
- **Decision:** Campus is a confidential tic-auth client. The api does the code exchange,
  holds the tokens in its own session behind an HttpOnly cookie on
  `tic-campus.ort.edu.ar`, and refreshes on the user's behalf. The browser never holds a
  token. The provider (Google or AD) is tic-auth's business, and campus never branches on it.
  The URL-fragment JWT, `jwtSecureCode` rotation, the student token, `X-Student-Token` and
  the Safari ITP workarounds are all dropped: they existed only because of the embed and
  the cross-site Vercel backend.

  **Built 2026-09-19.** `api/src/auth/` is MEV's shape — `jwks.ts`, `verify.ts`,
  `token-client.ts`, `cookies.ts`, `session-store.ts`, `refresh.ts` — with four routes in
  `api/src/routes/auth.ts` and the CSRF check inside `middleware/session.ts`. Five things
  were settled by building it rather than by arguing them:

  - **The session is a table**, `campus.session` (F37), not Redis and not a sealed cookie.
    `CLIENTS.md` §4 allows any of the three. Redis would be a container to back up and
    monitor for one feature; a sealed cookie would need a fourth hand-placed key and would
    make the 60 s memo of a rotated refresh token mandatory rather than optional, since the
    request that never received its `Set-Cookie` otherwise presents a spent token. The
    stored id is `sha256(cookie value)`, so tic-platform's nightly dump carries no session
    anybody can present.
  - **`acr == "strong"` lives in the verifier**, not in a middleware, because campus judges
    a credential in exactly one place: it gates on being signed in and on nothing else.
    There is no role gate here and there should not be one — students, teachers and admins
    all use campus, and its content is public anyway (F4). `roles[]` is carried in the
    session for F5 to read.
  - **The single-flight is an in-process `Map`**, keyed by session id. tic-auth revokes the
    whole refresh family on a replay, so two requests on one stale session must make one
    `/token` call; one container means one process, and tic-host's `RefreshCoordinator`
    reaches the same conclusion for the same reason. A second replica moves the lock into
    `SELECT … FOR UPDATE` on the session row, which is a thing a table can do and a cookie
    cannot.
  - **Express 5 arrived with this slice**, which was the cheapest moment: two routes before
    it, six after.
  - **No dev-login stub**, deferred rather than dropped: nothing consumes a session yet, and
    `tools/mock_oidc.py` gives a laptop a real round trip. When one is added it is
    `CLIENTS.md` §8's — registered only when the client secret is unconfigured, 404 when it
    is, never both, `refresh_token = null`.

  The hostname is **`tic-campus.ort.edu.ar`** and was never really open: `tic-host`'s
  `config.toml` declares `[origins.tic-campus]` against it as the contract this compose has
  to meet, the DNS alias already resolves to the VM, and `campus.ort.edu.ar` is the old
  campus running until December 2026. So the redirect URI is
  `https://tic-campus.ort.edu.ar/api/auth/callback`.

### F4 · Anonymous read

- [x] **Status:** decided
- **Decision:** Published articles and offering homes are public. Login is needed only for
  marks, revision requests, notifications and anything editable. The old campus was
  effectively public for content, and campus.ort links to articles for people who aren't
  logged in.
  **Per-article restriction:** each article use has a visibility setting, either _public_
  (the default) or _enrolled students and staff only_. That covers exam statements and
  solutions. A per-offering switch was rejected because offerings are almost always
  public and an exception is almost always a single article.

### F5 · Roles and permissions, derived from the directory

- [x] **Status:** built (slice 4)
- **Decision:** No campus-side ACL tables. Everything is read from `directory.*`:
  - **Teacher of a subject** (a `teacher_offering` row on any offering of that subject):
    edits that subject's article library (F8).
  - **Teacher of an offering**: the gradebook, home config, calendar and revisions of _that
    offering only_.
  - **Student**: marks and revisions for the offerings they are enrolled in
    (`directory.enrollment`).
  - **ADMIN**: everything.

  A separate editor list would be a second roster to keep in sync with the one tic-directory
  already maintains.

  **Built 2026-09-20.** `api/src/offerings/access.ts` is `capabilitiesFor(db, actor,
offeringId, subjectId)` → `{ editLibrary, manageOffering, seeOwnMarks }`, up to three
  `limit(1)` probes with ADMIN short-circuiting before any of them. Three things were
  settled by building it:

  - **No rank ladder and no `requireRole`.** MEV has `STUDENT < TEACHER < ADMIN` because
    its gates are role-shaped; campus's are resource-shaped, and the only role-shaped gate
    in the whole api is F34's activation, which is written out where it is used. `acr ==
strong` stays in `verify.ts`, so there is no second credential gate either.
  - **`admin` is a role key and never a prefix.** `admin-hosting` is tic-hosting's
    operators and grants nothing in the directory (tic-auth `0008`); a `startsWith` would
    hand every VM operator the gradebook.
  - **`seeOwnMarks` asks `directory.enrollment`, not `roles[]`** — the opposite of what F6's
    listing does with the same table, because they are opposite questions. Listing is _what
    belongs on your home page_; authorising is _does a row name this person_, and if one
    does, the results it guards are theirs. Teacher-of-subject has no relation of its own:
    it is `teacher_offering` joined through `offering.subject_id`, on any offering of that
    subject in any year.

  There is no `requireOfferingAccess` middleware yet. MEV's three-valued check exists
  because its paths carry a parent id it must gate on; campus's first route that refuses a
  _person_ for a _resource_ is the gradebook, and it can arrive with one.

### F6 · "Mis materias"

- [x] **Status:** built (slice 4)
- **Decision:** After login, `/` lists the user's offerings. Students get the offerings they
  are enrolled in, each with pending activities and progress. Teachers get the offerings they
  teach, with a count of open revision requests. Anonymous visitors get a year/subject picker.

  **Built 2026-09-20**, minus the counts — pending activities, progress and open revision
  requests are F18's and F29's, and each arrives with the feature that produces the number.
  `GET /api/offerings/mine` is one list with a `roles` array per entry rather than two
  lists, so the teacher who is also enrolled in something is one card and not a merge the
  client has to do.

  **Which half runs is decided by `roles[]`, not by what the tables return.** Staff carry
  enrolments — the 2026-09-02 snapshot has an `admin` holding one — so a teacher would
  otherwise see a subject of theirs listed as something they study. Reading
  `directory.user_role` for that fact would be a second source of something the token
  already states.

  **`year` defaults to `is_current` and never to a clock.** Which year is current is
  tic-auth's fact, flattened onto the views; a campus that computed its own would disagree
  with the directory every January.

  The trap the slice is really about: _is this person a student_ (`roles[]`), _what course
  are they in_ (`directory.student_course`, which campus does not read) and _what are they
  taking_ (`directory.enrollment`) are three questions with three relations. tic-auth's
  `0006` measured the cost of confusing them — 129 of 356 current students missing, because
  their courses had no `offering_course` rows. Campus shows those students an empty list,
  which is a directory row to add and not something to paper over here.

---

## Group C — Content

### F7 · Articles are Markdown, stored in the database

- [x] **Status:** decided
- **Decision:** Teachers write Markdown in an in-app editor with live preview. There is a
  fixed component set, carried over by _function_ from the old `components/articles/`:
  callout (`ImportantBox`), code block, inline code, download, image button. Publishing
  takes no deploy. Markdown rather than a block editor because the format stays plain text:
  diffable, exportable, and readable in a SQL console.
  **Syntax: Markdown directives** (`:::callout`, `::download{file=...}`), parsed with
  `remark-directive` into the fixed allowlist, and an unknown directive renders as text.
  MDX-style tags were rejected because they look like arbitrary JSX, which invites
  teachers to try it.

### F8 · Subject library, used by offerings

- [x] **Status:** decided
- **Decision:** An article belongs to a **subject's library**, which persists across years.
  An offering _uses_ an article, and the use carries the per-offering facts: publish date,
  unit, due date, and grading metadata (F18). Next year's offering reuses the library
  instead of copying it, so a fix reaches every offering. This replaces today's `templateId`,
  which shared content across courses but not across years.
  **One published version:** publishing a library article updates it everywhere it is used,
  past years included. Pinning a version per offering was rejected: propagation is the
  reason the library exists.

### F9 · Uploads

- [x] **Status:** decided
- **Decision:** Images and files (PDFs, starter zips) are dragged into the editor. They are
  stored on a campus Docker volume and served by campus. This replaces assets hosted on
  Drive and GitHub.
  **Limit: 20 MB per file**, with no per-subject quota. Anything bigger (video) goes on
  YouTube and is embedded (F10). **Backed up with the database:** tic-platform's nightly
  backup also archives the campus uploads volume, because a lost volume means broken
  articles. That is a change to tic-platform's `bin/backup.sh`. Storing the files in
  Postgres was rejected because it bloats the shared database and every dump of it.

### F10 · Embeds

- [x] **Status:** decided
- **Decision:** Allowlisted iframes: YouTube, Google Slides, CodePen. The allowlist lives in
  code, not config. The old "presentaciones" articles were mostly this.

### F11 · Drafts and revision history

- [x] **Status:** decided
- **Decision:** An article has a draft and a published version. Every publish keeps a
  revision, and any revision can be restored as the new draft.

### F12 · Several teachers editing

- [x] **Status:** decided
- **Decision:** Any teacher of the subject can edit (F5). Last write wins, but saving a
  draft based on a stale version warns and shows who changed it. No realtime co-editing,
  which would cost a CRDT and a websocket for a case that is rare in practice.

### F13 · Units

- [x] **Status:** decided
- **Decision:** An offering groups the articles it uses into ordered units, and those units
  are the **program's units** (F15). The home's article section (F14) renders them in that
  order.

---

## Group D — Homes

### F14 · One configured home per offering

- [x] **Status:** decided
- **Decision:** Every offering gets a home built from sections the teacher toggles and
  orders:
  - **Program**: see F15.
  - **Articles and activities**, by unit (F13).
  - **Links**: a small list (title + URL) for the group chat, slides, cheatsheets and so on.
    It replaces the `Links` sheet and the hard-coded "Grupo" / "Cheatsheets" buttons.
  - **My marks**: the logged-in student's results and running mark (F24).
  - **Timetable**: read from `directory.offering_time_slot`, honoring the rule that
    `time_slot_teacher` _overrides_ `teacher_offering` rather than adding to it
    (`tic-auth/docs/CONSISTENCY.md`).
  - **Calendar** (F16).

  Downloadable material is an article, or uploads inside one, so there is no separate
  "Material" list.

### F15 · Program

- [x] **Status:** decided
- **Decision:** **Structured:** an ordered list of units, each with a title and Markdown
  contents. The same units group the offering's articles (F13), so they are typed once.
  **The program lives in the subject library** and is reused every year, like articles
  (F8). An offering starts from it and can reorder or hide units for itself, so a fix to
  the library program reaches every year's offerings.

### F16 · Calendar

- [x] **Status:** decided
- **Decision:** Upcoming activity due dates (from F18) plus teacher-added events (exams,
  field trips).
  **School-wide events (holidays, school events) belong to the directory**, not campus.
  They are proposed to tic-auth as a directory item with its own `directory.*` view and an
  editing screen in BurocraTIC, and campus shows them on every offering's calendar. Campus
  would otherwise be the one app holding school-wide data that the others (MEV, tic-host)
  could also use.
  **Dependency:** until that view exists, calendars show only offering events.

### F17 · No special page types

- [x] **Status:** decided
- **Decision:** TIC básico/avanzado, Proyecto and Hardware are ordinary offerings (OPTIONAL
  ones where they are today) with ordinary homes. The old `[year]/Proyecto/[level]` and
  per-subject `index.astro` special cases are not rebuilt.

---

## Group E — Activities and grading

### F18 · An activity is an article

- [x] **Status:** decided
- **Decision:** A gradeable activity is an article whose **offering use** carries grading
  metadata. The library holds only content, so the same TP can be graded in one offering
  and practice-only in another. The metadata is: **group** (a teacher-named bucket such as
  `tps`, `clase` or `evals`), **term** (F21), **value type** (F19) and **due date**. A theory note is an article without it. That makes
  creating an activity and writing its statement one act, and the article can show the
  student's own result and due date. This replaces the `Contenidos` sheet, which joined the
  two by id convention.

### F19 · Value types

- [x] **Status:** decided
- **Decision:** Three types:
  - **Numeric**, 1–10 with decimals (today's TP marks).
  - **Done / not done** (today's class activities).
  - **Named ordered scale**, mapped to numbers for formulas. Campus ships **global presets**
    for the school's usual scales (B / MB / E, Aprobado / Desaprobado), and a teacher can
    also define a **custom scale** on their offering.

  Pass/fail is not a type of its own: it is a two-step scale.

### F20 · The mark formula

- [x] **Status:** decided
- **Decision:** Each offering has a formula over **named groups**, built from aggregate
  helpers: `avg`, `done_ratio`, `drop_lowest`, `min`, `max`, `round`, `if`. For example
  `0.7*avg(tps) + 0.3*10*done_ratio(clase)`. Formulas cannot reference individual
  activities, so renaming or adding an activity can never break one. A small safe
  expression parser evaluates it (no `eval`), and the editor shows a live preview computed
  for real students of the offering.
  This replaces `Materia`'s `Proporción TPS/Nota` and `Actividades Especiales`.
  **Blanks:** a missing numeric or scale result is **left out** of the aggregates, and a
  missing done/not-done counts as **not done**. The harsher option ("blank counts as 1
  after the due date") was rejected: it would make due dates matter for grading, and F25
  says they don't.

### F21 · Terms and the final

- [x] **Status:** decided
- **Decision:** Every activity belongs to a term. The formula (F20) runs per term, and the
  final is a second formula over the term results. **Terms are defined per offering**: the
  teacher names them (and optionally dates them). That gives up comparing marks across
  offerings in exchange for fitting subjects that aren't split into trimestres (semester
  OPTIONAL offerings, Proyecto).

### F22 · Official term grade

- [x] **Status:** decided
- **Decision:** Alongside the computed mark, the teacher enters an **official grade** per
  term: a value, an observation and a suggestion. Students see both. This replaces the
  `Notas Fijas` sheet and its `Nota - Observación - Sugerencia` string parsing.

### F23 · Redos

- [x] **Status:** decided
- **Decision:** A redo is an activity that **covers N others**, and its result replaces
  theirs. The policy (replace / max / average) is set per offering. One redo covering
  several TPs is the case the old `Recuperatorio` sheet existed for.

### F24 · Publishing and what students see

- [x] **Status:** decided
- **Decision:** Results are hidden until the teacher publishes the activity for the class,
  which replaces the per-row `Visible` column. Students see their published results, the
  feedback text on each, and their live computed mark.
  **The student's computed mark uses published activities only**, otherwise it would
  leak unpublished results. The teacher's preview (F20) shows both views side by side.

### F25 · Due dates and grading

- [x] **Status:** decided
- **Decision:** **Display only**: calendar, "vence en N días" and the 48 h notification
  (F30). Without submissions (F2), campus has no way of knowing when something was turned
  in, so a late flag would be a guess entered by hand.

---

## Group F — Gradebook (staff)

### F26 · Grid editor

- [x] **Status:** decided
- **Decision:** A spreadsheet-like grid of students × activities per offering, with keyboard
  navigation, paste from the clipboard and a bulk "mark all done". It replaces the Sheets
  UX that teachers are used to. Only teachers of the offering and admins can open it (F5).

### F27 · CSV / XLSX import and export

- [x] **Status:** decided
- **Decision:** Export an offering's gradebook, and import one back to bulk-set results.
  Import shows a diff before applying and matches students by directory id or DNI. It is the
  escape hatch for teachers who still want to work in a spreadsheet.

### F28 · Results API

- [ ] **Status:** deferred until after launch
- **Decision:** A public API for results, for scripts and future integrations, is wanted but
  **not built for launch**. No sibling pushes today: neither MEV nor tic-host has a caller
  waiting. When it is built, the defaults are: tic-auth client credentials with a scope such
  as `campus:results:write`, results landing as **drafts** a teacher publishes (F24),
  and activities named by their opaque campus id.
- **To settle (when un-deferred):** The first real caller, and what it needs.

---

## Group G — Revisions and notifications

### F29 · Revision requests

- [x] **Status:** decided
- **Prior art:** the old `RevisionRequest` model (reason, bonus tasks, comment, reviewed).
- **Decision:** A student asks for a re-check of a specific **result**, and the request
  references that result row, not an activity id string. The teacher answers from an inbox
  and can change the mark from the request itself. Rules:
  - A student can only ask about a **published** result, one they can already see (F24).
  - **One open request per result.** A new one is allowed only after the previous one is
    answered.
  - The request carries a reason and, optionally, **bonus tasks** (extra work the student
    offers), kept from the old model. The teacher's answer is a comment.
  - No request window: a request can be made any time before the year locks (F35).

### F30 · In-app notifications

- [x] **Status:** decided
- **Decision:** A bell with unread items. Three triggers: a result was published, a revision
  was answered, an activity is due within 48 h. No email: the VM has no outbound SMTP story,
  and students check campus anyway.

---

## Group H — Platform

### F31 · tic-platform compliance

- [x] **Status:** building
- **Prior art:** `tic-platform/README.md` (topology), `../DEPLOY-CONVENTIONS.md`,
  `bin/doctor.py` (already in this repo).
- **Decision:** Only `tic-campus-api` joins `tic-db`. **Four role names**, two groups and
  a LOGIN member of each, and they are not interchangeable:
  - **`campus`** — NOLOGIN, owns the schema. Created by tic-auth `0005`.
  - **`campus_app`** — NOLOGIN, holds the `directory.*` SELECT grants and the DML on
    `campus`, and deliberately no CREATE. Also `0005`.
  - **`campus_owner`** — LOGIN, `IN ROLE campus`. **Migrations only**, run from the host,
    and its password never enters a container.
  - **`campus_svc`** — LOGIN, `IN ROLE campus_app`. What the container connects as, its
    password mounted as a file so it stays out of `docker inspect`. Capped at 15
    connections by `tic-platform/bin/limits.sh`.

  The two LOGIN roles are created by hand at install time, which is the same split
  `MEV/docs/DEPLOY.md` uses for `mev_owner` / `mev_svc`. One role for both jobs would hand
  the serving process CREATE, and the grant matrix would stop meaning anything. The doctor contract is `schema_version: 2`. Backups are
  tic-platform's nightly dump, plus the uploads volume (F9). Deploy is `make deploy` from `/opt/tic-campus`.

---

## Group I — Structure and UX

### F32 · Public URLs

- [x] **Status:** decided
- **Decision:** `/<year>/<subject-slug>/<offering-slug>/<article-slug>`, for example
  `/2027/bases-de-datos/5to-informatica/tp-sql`. Links get shared in WhatsApp groups and on
  campus.ort, so they have to be readable. They are year-scoped because an offering is.
  An article slug is set once, and renaming it keeps a redirect from the old slug. The
  offering home is the URL without the last segment.
  **The offering slug is derived from the directory, never stored:** from
  `offering.name`, falling back to the offering's course names. A directory rename
  therefore changes the URL. That is accepted, because offerings are rarely renamed
  mid-year.
  **No redirect for renamed offerings.** Renames are rare, and an old link lands on a "no
  encontrado" page that links to the subject.

### F33 · Mobile-first student views

- [x] **Status:** decided
- **Decision:** Students read on phones, so the home, articles, "Mis materias", marks and
  revision requests are designed for phone width first. Staff screens (the gradebook grid,
  the editor, home configuration) are desktop-first and only need to be usable on a phone.

### F34 · An admin activates offerings

- [x] **Status:** built (slice 4)
- **Decision:** A directory offering has **no campus presence until an admin activates it**.
  Offerings the directory knows about but campus doesn't teach (never used, or not a TIC
  subject) stay invisible instead of showing up as empty homes. Activation creates the home
  with default sections and the subject library's program (F15). From then on, the teachers
  of the offering fill it in.
  **Always blank:** no copying from last year's offering. The library (F8, F15) is what
  carries across years, and a copy would be a second, weaker way of doing the same thing.

  **Built 2026-09-20.** `campus.offering_home` exists, and **the row's existence is the
  activation** — it carries no default sections yet, because F14's sections and links have
  no reader. Both operations are idempotent: an admin who clicks twice, or who activates
  what a colleague already did, has not made a mistake, and a 409 would be a state the
  client has to interpret before it can tell the person their action worked. Deactivation
  is a `DELETE` while there is nothing under a home to orphan; when F14 hangs sections on
  it, that becomes `archived_at` (F36).

### F35 · Past years: public and read-only

- [x] **Status:** decided
- **Decision:** When a school year ends, its offerings **stay public at their year's URLs**
  and students keep seeing their own marks. The **gradebook locks**: no results, official
  grades or revision requests. Only an admin can unlock an offering. The article content
  still follows the library (F8), so fixes reach past years too.
  **The lock is automatic on a configured date**, 31 December by default. An admin can
  move that date or unlock a single offering for a late grade fix.

---

## Group J — Data model

The `campus` schema, owned by the role `campus`, written by migrations run as that owner
and read at runtime by `campus_svc` through `campus_app` (F31). Reads of people, courses,
subjects and offerings go
to `directory.*`; foreign keys point at `public."user"`, `public.course`, `public.offering`
and `public.subject`, the four tables tic-auth's `REFERENCEABLE_TABLES` grants campus
`REFERENCES` on. `REFERENCES` does not imply `SELECT`: a constraint naming `public.*` and a
query naming `directory.*` are two different privileges, and mixing them up produces a
permission error blaming the wrong half (`MEV/api/src/db/schema/directory.ts` is the
worked example).

### F36 · Keys and conventions

- [x] **Status:** decided
- **Decision:** `uuid` primary keys with `defaultRandom()`, as in MEV: ids can be minted in
  tests and client-side, and they leak no counts. Directory ids stay `integer`, because they
  are tic-auth's. Timestamps are `timestamptz`. Retirement is `archived_at timestamptz`
  rather than a status column, so _when_ something was retired survives.

### F37 · The tables

- [x] **Status:** decided
- **Decision:** Thirteen tables, plus the four F39 names (`offering_group`,
  `offering_term`, `offering_scale`, `offering_scale_level`), plus the two the login needs
  (`session`, `login_flow`) — added 2026-09-19 with F3, and listed here rather than left
  implicit because the migrator derives `campus_app`'s grants from whatever is in the
  schema barrel, so a table nobody wrote down is still a table that exists.

  | Table              | Holds                                                                                                                                   | Key references                                                                   |
  | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
  | `article`          | library article: subject, slug, title, `published_version_id`, `draft_version_id`, `archived_at` (F7, F8, F11)                          | → `public.subject`                                                               |
  | `article_version`  | one saved body: Markdown source, author, created_at (F11)                                                                               | → `article`, `public."user"`                                                     |
  | `program_unit`     | the subject's program: title, Markdown contents, position (F15)                                                                         | → `public.subject`                                                               |
  | `offering_home`    | **built (slice 4)** — activation only so far; the section list, the links and the slug fallback arrive with F14 and F32 (F14, F34)      | → `public.offering`                                                              |
  | `offering_unit`    | the offering's copy of the program units: title, position, `hidden` (F13, F15)                                                          | → `offering_home`, `program_unit` (nullable)                                     |
  | `offering_article` | an offering's **use** of an article: unit, position, publish date, visibility (F4), and the grading fields when it is an activity (F18) | → `offering_home`, `article`, `offering_unit`, `offering_group`, `offering_term` |
  | `redo_covers`      | which uses a redo covers (F23)                                                                                                          | → `offering_article` ×2                                                          |
  | `result`           | one student's result for one activity (F38)                                                                                             | → `public."user"`, `offering_article`                                            |
  | `official_grade`   | hand-entered term grade: value, observation, suggestion (F22)                                                                           | → `public."user"`, `offering_term`                                               |
  | `revision_request` | reason, bonus tasks, teacher answer, resolved (F29)                                                                                     | → `result`, `public."user"`                                                      |
  | `notification`     | user, kind, target, `read_at` (F30)                                                                                                     | → `public."user"`                                                                |
  | `upload`           | id, subject, uploader, filename, media type, size, sha256 (F9)                                                                          | → `public.subject`, `public."user"`                                              |
  | `audit_event`      | append-only: actor, action, target, before/after (F41)                                                                                  | → `public."user"`                                                                |
  | `session`          | one signed-in person: mapped claims, refresh token, `claims_at`, hard cap, CSRF token (F3)                                              | → `public."user"`                                                                |
  | `login_flow`       | the `state` and PKCE verifier between `/api/auth/login` and its callback, 600 s (F3)                                                    | —                                                                                |

  The bytes of an upload live on the volume at a path derived from the id; the row is the
  index, which is what makes listing, quotas and garbage collection possible. Serving a file
  checks the visibility of the articles that reference it.

### F38 · A result is a record of what a student did

- [x] **Status:** decided
- **Decision:** `result` is `(student_id, offering_article_id, value, scale_level,
feedback, recorded_by, recorded_at)`, unique on the first two. **It carries no course**:
  a result records that this person did this activity and got this, and a student who later
  changes course does not change that fact. The absence is a feature, not a gap — there is
  no composite key to maintain and no history to rewrite when a roster does.
  The API checks `directory.enrollment` when a result is _created_; a later unenrollment
  leaves the result standing, and the gradebook shows it as a student no longer in the
  offering rather than hiding it.
  **One numeric `value` column** is what the formula aggregates: done = 1, not done = 0, a
  scale level = its mapped number. `scale_level` keeps what the teacher actually picked, for
  display. A single aggregatable column is what keeps the evaluator from branching per type.

### F39 · Groups, terms and scales are rows

- [x] **Status:** decided
- **Decision:** `offering_group` (F20), `offering_term` (F21) and `offering_scale` +
  `offering_scale_level` (F19) are tables per offering, each with a name and a position, and
  an activity references them by id. Renaming a group then touches neither the activities nor
  the formula. Scales can also be seeded from global presets, which live in code rather than
  in a settings table.

### F40 · Formulas are text, validated on save

- [x] **Status:** decided
- **Decision:** `offering_term.formula` and `offering_home.final_formula` hold the source
  text. Saving parses it and rejects unknown functions or groups; the evaluator re-parses on
  read, which costs microseconds. No compiled AST column, because a cache of a parse is a
  second thing that can disagree with the text.
  **Computed marks are never stored** (F20): they are derived on read from published results
  (F24). Nothing to invalidate when a result, a formula or a publish changes.

### F41 · Campus keeps its own audit log

- [x] **Status:** decided
- **Decision:** An append-only `campus.audit_event` records who changed a result or an
  official grade, who published an activity, and who activated, locked or unlocked an
  offering. Grades get contested, so _"who set this to 4, and when"_ has to be answerable;
  article history (F11) already answers it for content. Append-only **by grant**, the way
  tic-auth's own audit table is: `campus_svc` gets `SELECT, INSERT` and nothing else.
  Writing to tic-auth's `public.audit_event` is not an option — campus holds no privilege
  on it.

### F42 · Admin-level values live in code, not a settings table

- [x] **Status:** decided
- **Decision:** The year-lock date (F35) and the global scale presets (F19) are constants in
  the api, overridable by environment where the box needs it. A settings table for two
  values would be a screen, a migration and a cache for something that changes once a year.

---

## Group K — The interface

### F43 · A brand redesign, not today's identity

- [ ] **Status:** open
- **Prior art:** `../BRAND.md` — the tic family's rules, and the committed Frontify export
  `tic-host/web/src/brand/colors.oco` that is their source of truth, with
  `tic-host/web/src/app.css` as the reference implementation. That document names campus as
  **the one member running a separate visual identity today** (Lato + Special Elite, its own
  `sh-*` ramp, its own favicon) and deliberately does not retroactively repaint it: it
  shares only the tag colours. So the rebuild is the moment to decide, rather than a
  decision already made elsewhere.
- **To settle:**
  - Does 2027 campus adopt the family palette and type, keep its own and refresh it, or land
    somewhere between — family colours, campus type?
  - Does the redesign come before the first screens, or do the screens ship in something
    plain and get repainted once?
  - The favicon, the logo and the name treatment are part of this, not a follow-up.
- **Decision:** _(not made)_

### F44 · The interface is built by hand

- [x] **Status:** decided
- **Decision:** The GUI is designed and written **by a person**, not generated. That covers
  layout, components, styling, the React app's structure and the F43 redesign. Agents build
  the api, the schema, the migrations, the deploy and the plumbing, and stop at that
  boundary: they may wire a screen up to a route or fix a bug in one that exists, but they
  do not invent the interface.
  The reason is that the look is the part with taste in it, and F43 is still open — a
  generated UI would be a thing to throw away twice, once when the brand is decided and
  again when it turns out not to be what anyone wanted. It is also the part of the rebuild
  worth doing by hand for its own sake.
