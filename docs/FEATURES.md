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

- [x] **Status:** built (slice 5)
- **Decision:** Published articles and offering homes are public. Login is needed only for
  marks, revision requests, notifications and anything editable. The old campus was
  effectively public for content, and campus.ort links to articles for people who aren't
  logged in.
  **Per-article restriction:** each article use has a visibility setting, either _public_
  (the default) or _enrolled students and staff only_. That covers exam statements and
  solutions. A per-offering switch was rejected because offerings are almost always
  public and an exception is almost always a single article.

  **Built 2026-09-20.** `offering_article.restricted` is a **boolean**, not a status column:
  F4 decides exactly two values and campus's schema holds no `pgEnum` anywhere. Two things
  settled by building it:
  - **An article nobody may read is absent, not forbidden.** Both public routes answer
    **404**, never 403 — a 403 confirms the article exists, which for an exam statement or a
    solution is most of what somebody fishing wanted to know.
  - **The rule is one function**, `mayRead` in `api/src/offerings/content.ts`, called by the
    home's article list _and_ by the article's own page, so the two cannot disagree about
    what a visitor may see. Staff read past both the publish date and `restricted`, which is
    why there is no preview mode to build.

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
  **The revision count arrived with F29 (slice 11)**, as one correlated subquery in
  `listMine`'s own statement rather than a query per offering, and gated on the per-row
  `teaches` expression: a teacher who is also enrolled in something would otherwise read the
  open-dispute queue on the card for the subject they _study_. Pending activities and
  progress are still F18's and still unpaid.
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

- [x] **Status:** built (slice 5)
- **Decision:** Teachers write Markdown in an in-app editor with live preview. There is a
  fixed component set, carried over by _function_ from the old `components/articles/`:
  callout (`ImportantBox`), code block, inline code, download, image button. Publishing
  takes no deploy. Markdown rather than a block editor because the format stays plain text:
  diffable, exportable, and readable in a SQL console.
  **Syntax: Markdown directives** (`:::callout`, `::download{file=...}`), parsed with
  `remark-directive` into the fixed allowlist, and an unknown directive renders as text.
  MDX-style tags were rejected because they look like arbitrary JSX, which invites
  teachers to try it.

  **Built 2026-09-20.** The api **stores and serves the Markdown source verbatim and parses
  nothing** — no `remark`, no `remark-directive`, no dependency. The allowlist and the
  component set are the renderer's, because the alternative is a server that owns how
  content looks (F44). `article_version.body` in, the same bytes out.

### F8 · Subject library, used by offerings

- [x] **Status:** built (slice 5)
- **Decision:** An article belongs to a **subject's library**, which persists across years.
  An offering _uses_ an article, and the use carries the per-offering facts: publish date,
  unit, due date, and grading metadata (F18). Next year's offering reuses the library
  instead of copying it, so a fix reaches every offering. This replaces today's `templateId`,
  which shared content across courses but not across years.
  **One published version:** publishing a library article updates it everywhere it is used,
  past years included. Pinning a version per offering was rejected: propagation is the
  reason the library exists.

  **Built 2026-09-20.** `campus.offering_article` is the use. Two things it settled:
  - **Publishing really is moving a pointer.** `publish` writes
    `article.published_version_id` and nothing else, so every offering using the article —
    past years included — serves the new text on the next request, with no per-offering row
    to update and no deploy.
  - **An offering may only use its own subject's articles.** Otherwise the library would
    have a second, invisible way to share content across subjects, which is the thing
    `templateId` did badly.

### F9 · Uploads

- [x] **Status:** built (slice 6)
- **Decision:** Images and files (PDFs, starter zips) are dragged into the editor. They are
  stored on a campus Docker volume and served by campus. This replaces assets hosted on
  Drive and GitHub.
  **Limit: 20 MB per file**, with no per-subject quota. Anything bigger (video) goes on
  YouTube and is embedded (F10). **Backed up with the database:** tic-platform's nightly
  backup also archives the campus uploads volume, because a lost volume means broken
  articles. That is a change to tic-platform's `bin/backup.sh`. Storing the files in
  Postgres was rejected because it bloats the shared database and every dump of it.

  **Built 2026-09-20.** `campus.upload` is the index and the bytes are at
  `<UPLOADS_DIR>/<id>` on `tic-campus-uploads`, an `external: true` volume created by hand,
  like tic-platform's `tic-db-data` — `docker compose down -v` must not be able to take
  teachers' files, and `make rollout` refuses to build without it. Four things settled:

  - **An upload is served to anybody holding its uuid, and F37's sentence is reopened
    here.** F37 said "serving a file checks the visibility of the articles that reference
    it", and nothing in the api can answer that question: the reference is
    `::download{file=<id>}` inside `article_version.body`, and the api parses no Markdown
    (F7, F44). The two ways out were a parser — reversing slice 5's most deliberate decision
    to make an upload route easier — or an `article_id` on the row, which records where a
    file was _uploaded_ rather than where it is _referenced_ and is wrong the first time a
    teacher copies a directive into a second article. Neither is worth it, because of what
    the check actually buys: it stops somebody **guessing** a 122-bit id, and nothing else.
    Anybody who may read a restricted article can forward the PDF itself. So an upload is
    subject-scoped, exactly as this table row says, and the id is the capability.
    **If an exam ever does leak this way**, the upgrade is `upload.article_id` plus `mayRead`
    over that article's uses — a column and a join, not a rewrite.
  - **What campus serves is never simply what was uploaded.** Files come back from the same
    origin the app runs on, so serving one inline with the media type its uploader claimed is
    stored XSS — an `.html`, or an `.svg`, which is a document that runs script, against a
    logged-in teacher's session. `serveAs` holds a small allowlist of things browsers render
    and cannot be scripted by (PNG, JPEG, GIF, WebP, AVIF, PDF): those are `inline` as
    themselves, and **everything else is `application/octet-stream` + `attachment`**, with
    `X-Content-Type-Options: nosniff` on both. Nothing is refused at upload time — F9 is for
    starter zips — and `image/svg+xml` is absent from that list on purpose, which is why it
    is an allowlist and not a denylist.
  - **The 20 MB is multer's and the 1 MB is `express.json`'s**, and they stay independent.
    Raising the JSON limit to fit a PDF would hand every JSON route a 20 MB buffer to be
    talked into allocating. The proxy is a third limit and the easiest to forget:
    `client_max_body_size 20m` in `docker/web/nginx.conf`, without which nginx answers its
    own HTML 413 at **1 MB** and the client never sees the error envelope it branches on.
  - **There is no `DELETE` and no garbage collection.** For the same reason there is no
    visibility check: nothing knows which articles reference a file, so a delete breaks
    articles silently, and unlike an article (F11) an upload has no version history to
    recover from. It waits for an editor that can show a teacher where a file is used.

  Also worth writing down: busboy decodes multipart filenames as **latin1** by default, so
  `Guía de TPs.pdf` is stored as `GuÃ­a de TPs.pdf` forever unless `defParamCharset: "utf8"`
  is set. Measured against multer 2.4.0.

### F10 · Embeds

- [x] **Status:** built (slice 19): the allowlist is `web/src/embeds.ts`. The renderer
      (F44) wires it
- **Built:** `embedSrc(url)` returns a src **rebuilt** from validated ids (never the
  teacher's URL) or `null`; `embedAttrs` is what goes on the `<iframe>`. The directive syntax
  is the renderer's to choose. YouTube goes to `youtube-nocookie.com`.
- **Decision:** Allowlisted iframes: YouTube, Google Slides, CodePen. The allowlist lives in
  code, not config. The old "presentaciones" articles were mostly this.

  **Judged 2026-09-20, with F9, and deliberately left unbuilt.** It is pure render-side:
  no schema, no route, no infra, and with the api serving Markdown verbatim (F7) there is
  no api surface for it at all. The allowlist belongs to the renderer a person writes
  (F44), beside `:::callout` and `::download`. Putting it in the api now would be code
  nothing calls, in the layer that deliberately does not own how content looks.

### F11 · Drafts and revision history

- [x] **Status:** built (slice 5)
- **Decision:** An article has a draft and a published version. Every publish keeps a
  revision, and any revision can be restored as the new draft.

  **Built 2026-09-20.** **There is no restore endpoint**, and that is the whole of it:
  restoring is `GET …/versions/:id` followed by `PUT …/draft` with that body. A verb of its
  own would name something the client already has two calls for. The revision list comes
  back inline from the article read, because without it there is nothing to restore _from_.

### F12 · Several teachers editing

- [x] **Status:** built (slice 5)
- **Decision:** Any teacher of the subject can edit (F5). Last write wins, but saving a
  draft based on a stale version warns and shows who changed it. No realtime co-editing,
  which would cost a CRDT and a websocket for a case that is rare in practice.
  `saveDraft` (`library/articles.ts`) refuses a stale `baseVersionId` with `409 stale_draft`
  and names who moved the draft.

### F13 · Units

- [x] **Status:** built (slice 5)
- **Decision:** An offering groups the articles it uses into ordered units, and those units
  are the **program's units** (F15). The home's article section (F14) renders them in that
  order.

---

## Group D — Homes

**Built 2026-09-20.** `offering_article.program_unit_id` points at the **library's** unit
directly. See F15 for why there is no per-offering copy of the units yet.

### F14 · One configured home per offering

- [x] **Status:** built (slice 13), timetable and calendar moved out — see below
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

  **Built 2026-09-21 (slice 13), with the list above amended.**

  - **Timetable and calendar are not home sections.** They are campus-wide, not a
    teacher's choice for one offering: a student's timetable spans every offering they
    are in, and the calendar is the school's plus each offering's (F16). They arrive
    with their own readers as campus views, and F14's domain is the four sections a
    home actually renders: `program`, `articles`, `links`, `marks`. A section a teacher
    could switch on that renders nothing is the empty home F34 argues against. The
    domain is the api's (F18) — `SECTIONS` in `api/src/offerings/home.ts`.
  - **Everything is four columns on `offering_home`**: `sections text[]`, `links
jsonb`, `unit_order uuid[]`, `hidden_units uuid[]`, written whole by `PUT
/api/homes/:offeringId/home` through `manageableHome`. F35's lock (slice 14) does **not** cover it — marks only. No
    table, because nothing points at any of them.
  - **`sections` null is "never configured"** and reads as all four, in that order, so
    an offering nobody touched picks up a section added later.
  - **Sections are presentation, not access.** A section switched off still ships its
    data — articles stay readable at their URLs, marks at `/results/mine`. Hiding
    content is F4's `publishedAt` and `restricted`, one rule in `mayRead`.
  - **A link is `http:` or `https:` and nothing else**, checked in the api: it is
    rendered as an `href` for every student, and `javascript:` in it would be stored
    XSS against the class. Up to 50, titled, whole list. Removing one is saving
    without it — a link has no history, so there is no `archived_at` (F36). A lost
    update between two teachers saving at once is accepted: nothing points at a link,
    and it is retyped in seconds, unlike F15's units.
  - **The payload** is `homeContent`'s one read behind `GET
/api/offerings/:year/:subject/:offering`, now `{ sections, links, program, articles
}` beside `can`, the same shape for an anonymous caller. **An article whose `unitId`
    is not in `program`** — filed under a unit this offering hides — renders
    ungrouped, the same as a `null` one. That is the GUI's rule (F44).

### F15 · Program

- [x] **Status:** built (slice 5), except per-offering reorder and hide
- **Decision:** **Structured:** an ordered list of units, each with a title and Markdown
  contents. The same units group the offering's articles (F13), so they are typed once.
  **The program lives in the subject library** and is reused every year, like articles
  (F8). An offering starts from it and can reorder or hide units for itself, so a fix to
  the library program reaches every year's offerings.

  **Built 2026-09-20, with one half deliberately deferred.** The library program is built:
  `program_unit` has its reader and writer, and every offering of the subject shows those
  units, in that order, with articles filed under them (F13).

  **An offering reordering or hiding units for itself is deferred to F14**, and this is a
  change of plan worth stating rather than discovering. It needs an `offering_unit` table —
  the offering's own row per unit, carrying `position`, `hidden` and a title override — and
  that is a _home configuration_ control, which is exactly what F14's screen is. Building it
  now would also have cost the thing it was supposed to protect: a unit's id would be
  `program_unit.id` when untouched and `offering_unit.id` once overridden, so every client
  would branch on which kind it got, for a control no screen offers yet.

  **Deferring it does not weaken the propagation F15 exists for — it strengthens it.** With
  no per-offering copy, a unit renamed or rewritten in the library reaches every year's
  offerings immediately, and so does a unit _added_ to the library after an offering was
  activated. A copy made at activation, which is what F34 literally described, would have
  missed both.

  When F14 lands, the migration is one `INSERT … SELECT` over the distinct
  `(offering_home, program_unit)` pairs already in use, plus an `offering_unit_id` on
  `offering_article`.

  **Rejected while building:** materialising `offering_unit` rows lazily — on the first
  override or the first article filed under a unit — which keeps propagation but pays the
  discriminated-id cost above for a feature with no screen. Worth revisiting _with_ F14, not
  before it.

  **Reopened 2026-09-21 (slice 13): the deferred half is built, and not as
  `offering_unit`.** The per-offering order and hiding are two arrays of
  `program_unit.id` on `offering_home` (`unit_order`, `hidden_units`), applied on top of
  `readProgram` by `homeContent` — the way `revision_request` names a mark by its pair
  rather than by `result.id`. That removes the discriminated id this item rejected:
  `unitId` is a `program_unit.id` forever. Propagation is kept whole: a unit added to
  the library later is simply not in the array, and goes after the listed ones in the
  library's order; a deleted unit's id matches nothing. Hidden units are omitted for
  students and flagged `hidden: true` for staff. So **the `INSERT … SELECT` above never
  happens**, and `offering_article` gets no `offering_unit_id`.

  **No title override.** The library rename reaching every offering is this item's
  headline property, an override stops it for one offering, and nothing asks for it.

  **Also settled:** the whole-list `PUT` that writes the program **never deletes**. A teacher
  who loads the program and saves it after a colleague has added a unit would otherwise wipe
  that unit, and by foreign key every article filed under it — silently, and with no version
  history to recover from, unlike an article (F11). Removing a unit is its own `DELETE`,
  which refuses with a `409` while any offering still files articles under it.

### F16 · Calendar

- [ ] **Status:** deferred until after launch
- **Decision:** Upcoming activity due dates (from F18) plus teacher-added events (exams,
  field trips).
  **School-wide events (holidays, school events) belong to the directory**, not campus.
  They are proposed to tic-auth as a directory item with its own `directory.*` view and an
  editing screen in BurocraTIC, and campus shows them on every offering's calendar. Campus
  would otherwise be the one app holding school-wide data that the others (MEV, tic-host)
  could also use.
  **Dependency:** until that view exists, calendars show only offering events.
  **Amended 2026-09-21 (slice 13):** the calendar is a campus-wide view, not one of an
  offering home's sections (F14).
  **Deferred 2026-09-21, after slice 15:** not built for launch. When it is un-deferred it
  becomes the only reader of `offering_article.due_at` (F25), and F21's optional term dates
  arrive with it. Still to settle then: the read shape (campus-wide, per offering, or both),
  the teacher-event table (not in F37), and Buenos Aires time for all-day events.

### F17 · No special page types

- [x] **Status:** decided
- **Decision:** TIC básico/avanzado, Proyecto and Hardware are ordinary offerings (OPTIONAL
  ones where they are today) with ordinary homes. The old `[year]/Proyecto/[level]` and
  per-subject `index.astro` special cases are not rebuilt.

---

## Group E — Activities and grading

### F18 · An activity is an article

- [x] **Status:** built (slice 7)
- **Decision:** A gradeable activity is an article whose **offering use** carries grading
  metadata. The library holds only content, so the same TP can be graded in one offering
  and practice-only in another. The metadata is: **group** (a teacher-named bucket such as
  `tps`, `clase` or `evals`), **term** (F21), **value type** (F19) and **due date**. A theory note is an article without it. That makes
  creating an activity and writing its statement one act, and the article can show the
  student's own result and due date. This replaces the `Contenidos` sheet, which joined the
  two by id convention.

  **Built 2026-09-20.** Six nullable columns on `offering_article`:
  `offering_group_id`, `offering_term_id`, `value_type`, `offering_scale_id`,
  `due_at` and F24's `results_published_at`. Three things settled by building it:

  - **An activity is a use with a `value_type`**, and that one `is not null` is
    the whole of "is this graded" — there is no second flag and no separate
    table. A term travels with it (F21), a scale is required exactly when the
    type is `scale`, and a group is optional, because an activity in no bucket
    is one F20's formula ignores and that is a thing a teacher may mean.
  - **`value_type` is `text` checked in the api — no `pgEnum`, no `CHECK`.**
    Campus's schema holds neither, the api is the only writer, and every other
    value rule already lives there (`checkSlug`, `checkUnits`). That argument is
    deliberately _not_ extended to F39's unique names: a value domain is one a
    single writer can enforce alone, and uniqueness across two concurrent
    writers is not.
  - **The use `PUT` refuses to un-grade an activity that has marks**
    (`409 results_exist`), and so does removing it from the offering
    (`409 activity_has_results`). The row is written whole — a client sending
    half a panel saves half a panel, which is how `position` has reset to 0
    since slice 5 — and that is recoverable by saving again. Stranding `result`
    rows on something that is no longer an activity is not, and unlike an
    article (F11) there is no version history to bring them back.

### F19 · Value types

- [x] **Status:** built (slice 7)
- **Decision:** Three types:
  - **Numeric**, 1–10 with decimals (today's TP marks).
  - **Done / not done** (today's class activities).
  - **Named ordered scale**, mapped to numbers for formulas. Campus ships **global presets**
    for the school's usual scales (B / MB / E, Aprobado / Desaprobado), and a teacher can
    also define a **custom scale** on their offering.

  Pass/fail is not a type of its own: it is a two-step scale.

  **Built 2026-09-20.** The three are the strings `numeric`, `done` and `scale`.
  `SCALE_PRESETS` in `api/src/offerings/gradebook.ts` is the first of F42's
  constants, and **the number each preset level maps to is written down there**
  rather than left to whichever screen seeds from it: `B` 7, `MB` 8.5, `E` 10,
  and `Desaprobado` 1 / `Aprobado` 7. It is a school decision, and a slice that
  re-picked those numbers would be re-deciding it by accident. A preset is
  copied into the offering's own `offering_scale` when a teacher seeds from it,
  so editing a preset later reaches nobody — which is the point: a mark already
  given does not move because somebody changed a word in the api.

### F20 · The mark formula

- [x] **Status:** built (slice 8)
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

  **Deferred to its own slice, 2026-09-20 (slice 7).** The parser, the evaluator,
  the save-time validator and the live preview are one piece of work, and none of
  it was reachable until groups, terms, activities and results were rows. Nothing
  was given up by waiting: F40 already says computed marks are never stored, so
  there is no cache this slice could have invalidated. Two things that slice
  inherits: **F39's name-versus-id obligation** below, and the fact that
  `offering_term.formula` and `offering_home.final_formula` do not exist yet —
  they arrive with the feature that reads them, the way F18's columns just did.
  Also worth knowing before writing the evaluator: **a blank is an absent
  `result` row and nothing else** (F38), so there is exactly one shape to skip.

  **Built 2026-09-20 (slice 8).** `api/src/offerings/formula.ts` is a tokenizer and a
  recursive-descent parser, `api/src/offerings/marks.ts` is what feeds it rows. Seven
  functions as decided, `+ - * /`, unary minus, parentheses and the six comparisons, which
  exist for `if` and deliberately do not chain. Five things settled by building it:

  - **A name is a call only when a parenthesis follows it**, so there are no reserved words
    and a teacher may name a group `min`. One rule instead of two, and no escape hatch to
    document.
  - **A group name may be quoted**, `avg("Trabajos Prácticos")`, because a name is free text
    up to 80 characters and a bare identifier cannot hold a space. An unquoted name allows
    Unicode letters, so `avg(física)` needs no quotes. This is what made F39's answer
    possible without a key column — see there.
  - **`avg`, `min`, `max` and `drop_lowest` pool every argument** into one list of numbers, a
    group contributing its marks and a number itself. That is one rule rather than two, and
    it is what lets the **final formula use the same evaluator** (F21): `avg(tps)` and
    `avg("1er", "2do")` are the same function. A `null` argument is dropped, which is this
    item's blank rule applied one level up — a term nobody has marked does not drag the final
    down, the way an unmarked TP does not drag a term down. Spelling it `(a+b+c)/3` instead
    deliberately gives _sin nota_, because plain arithmetic propagates it.
  - **Three outcomes, never `NaN` and never `Infinity`**: a number, `null` for _sin nota_, or
    an error string the teacher reads in the cell. Division by zero is an **error and not a
    `null`** — a null reads as "todavía no hay nota" and would hide a formula somebody has to
    go fix. A formula that no longer parses is a cell with a message rather than a failed
    request, so the grid still renders around the term that broke.
  - **Every number the evaluator produces is rounded to ten decimals.** Not cosmetic:
    `0.7*7 + 0.3*10` is `7.899999999999999` in binary floating point, which prints as that on
    a boletín and loses an `if(x >= 7.9, …)` a teacher wrote. Marks are 1–10 with two
    decimals, so ten decimals is far below anything real.

  `done_ratio` is the one function that takes a group and not a pooled list, because its
  denominator is the group's `done` **activities** — which is why the evaluator reads the
  activity list and not only the `result` rows, and why `listActivities` is now exported. It
  is therefore unusable in the final formula, where a name is a term's own mark and there is
  no activity list behind it; the error says so.

### F21 · Terms and the final

- [x] **Status:** built (slice 7), except the dates; the formula is slice 8's
- **Decision:** Every activity belongs to a term. The formula (F20) runs per term, and the
  final is a second formula over the term results. **Terms are defined per offering**: the
  teacher names them (and optionally dates them). That gives up comparing marks across
  offerings in exchange for fitting subjects that aren't split into trimestres (semester
  OPTIONAL offerings, Proyecto).

  **Built 2026-09-20.** `offering_term` is a name and a position per offering,
  and every activity carries one — `value_type` and `offering_term_id` are null
  together or set together (F18). **It has no `starts_on`/`ends_on` and no
  `formula`**: the optional dates have no reader until F16's calendar and the
  formula is F40's, and a column arrives with the feature that reads it. The
  final, being a second formula over the term results, is all F20's.

  **The formula arrived 2026-09-20 (slice 8); the dates did not**, and they still have no
  reader. The final is built as decided — a second formula, whose names are the **terms**
  rather than the groups, each resolving to the mark just computed for it. Two things fell
  out of building it. A term with **no formula still contributes its name** to the final's
  scope, as _sin nota_: skipping it made the final read `«3er trimestre» ya no existe` for
  a teacher who wrote the final before the last term's formula, which is a refusal where a
  partial mark was the honest answer. And `offering_home.final_formula` is written by the
  **gradebook's own `PUT`** rather than a route of its own, because the save that renames a
  term has to be able to fix it in the same body (F39).

### F22 · Official term grade

- [x] **Status:** built (slice 9)
- **Decision:** Alongside the computed mark, the teacher enters an **official grade** per
  term: a value, an observation and a suggestion. Students see both. This replaces the
  `Notas Fijas` sheet and its `Nota - Observación - Sugerencia` string parsing.

  **Built 2026-09-20.** `campus.official_grade` is `(student, offering_term, value,
observation, suggestion)` plus `recorded_by`/`recorded_at`, ~~unique on the first two~~
  **one row per time a cell was graded since slice 17 (F41)**.
  `PUT /api/homes/:oferta/official-grades` writes it; the grid reads it in
  `GET …/gradebook` as `officialGrades` and the student reads their own in
  `GET …/results/mine` as `official`. Four things settled by building it:

  - **An official grade is visible the moment it exists**, and there is no third publish
    date. F24's question asked again, and F24's answer does not fit: `resultsVisible` keys
    off `offering_article.results_published_at`, which is _per activity_, and a term has no
    such column. The alternatives were a publish date on the term or none, and none wins on
    what actually happens: a teacher types the boletín grade **when the boletín is due**, so
    a draft state would be a flag nobody flips, standing between a student and a grade that
    is already decided. `resultsVisible` remains the rule for _results_ and deliberately
    does not grow a third meaning — the two reads are now two rules because they answer two
    questions, not because anybody forgot to unify them.
    The day a teacher does want to hold one back, it is a nullable `published_at` on this
    table and one clause in `myOfficialGrades`, and nothing else moves.
  - **A third key on `/results/mine`, not a fourth route.** Slice 8 already made that
    payload `{ results, computed }`; the boletín reads both numbers or neither, so a
    separate `GET` would be a second round trip that can disagree with the first.
  - **The save is `PUT …/results`'s shape and not `PUT …/gradebook`'s.** Groups, terms and
    scales are whole lists that never delete (F15's rule) because a stale panel would
    otherwise wipe a colleague's row. This is a _cell_: entries nobody sent are untouched
    and `value: null` clears one, which also takes the observation and the suggestion with
    it — `value` is `NOT NULL` and a blank is an absent row (F38), so an observation cannot
    outlive its grade. An entry with no `value` at all is a `400` rather than a silent
    no-op. `checkMark` is reused rather than restated, so the 1–10 with two decimals cannot
    drift from the gradebook's.
  - **`recorded_by`/`recorded_at` are copied from `result`, and ~~this is not F41~~ this
    is F41 since slice 17.** ~~The write is an upsert, so they answer _who holds this
    grade now_, not _who set it to 4_.~~ The write is a plain insert, the current grade is
    the pair's newest row, and each row answers _who set this, and when_.

  **Enrolment is F38's rule and is now shared rather than restated.** `writableStudents`
  moved to taking the home alone and reads both `result` and `official_grade`: a departed
  student who carries either stays writable and stays in the grid, flagged. `roster` reads
  the same two, so what a teacher can write and what the grid shows them cannot disagree.

### F23 · Redos

- [x] **Status:** built (slice 10)
- **Decision:** A redo is an activity that **covers N others**, and its result replaces
  theirs. The policy (replace / max / average) is set per offering. One redo covering
  several TPs is the case the old `Recuperatorio` sheet existed for.

  **Built 2026-09-20.** `campus.redo_covers` is `(redo, covered)`, both `offering_article`,
  and `offering_home.redo_policy` is the offering's choice. **No new route:** the coverage
  rides `PUT /api/homes/:oferta/articles/:articleId` beside the group and the term, and the
  policy rides `PUT …/gradebook` beside `final_formula`. Seven things settled by building
  it:

  - **A redo is an activity and nothing else marks it as one.** What makes it a redo is
    rows in `redo_covers`; "covers nothing" and "is not a redo" are the same fact, so a
    flag on `offering_article` would be a second thing to keep true. The cheap reading is
    also the useful one — a redo carries a term, a group, a due date and a publish date,
    and is graded and published through the routes that already exist.
  - **Resolution happens in front of the evaluator, never inside it.** `resolveRedos` in
    `marks.ts` rewrites one student's map of _what was recorded_ into _what counts_, and
    `groupValue` is untouched: it still reads one result per activity and still knows
    nothing about redos. `marks.ts` and `formula.ts` stay pure and query nothing — the
    coverage arrives as data on `Activity.covers`, the way the activities and the results
    already do. The rejected alternative was teaching `groupValue` to look through a redo,
    which is the one function F20 deliberately kept dumb.
  - **A redo never counts on its own.** It is skipped when the buckets are built, so
    `avg(tps)` over three TPs plus a redo covering one of them is still three numbers, and
    a done redo does not add one to `done_ratio`'s denominator. The alternative — counting
    it _and_ letting it replace — makes the recuperatorio a fourth TP for the students who
    never needed one.
  - **The default policy is `max`, not `replace`.** A default is what an offering gets when
    nobody decided, and "a redo can only help" is the answer that is wrong in the student's
    favour; `replace` remains a policy, and a teacher who wants a redo to be able to lower
    a mark says so per offering. It is a column on `offering_home` and not one of F42's
    constants because it is a _teacher's_ call, not an admin's.
  - **Blanks cut two ways here too** (F20's question, asked of a redo), and the answer is
    one rule: **only present values participate.** An unmarked redo leaves the original
    standing — a blank is an absent row (F38), so a recuperatorio nobody sat has not
    happened, and it is neither a zero nor a reason to blank the TP. A redo over a blank
    original replaces it, which is what a recuperatorio is _for_: the student who missed
    the TP is exactly who sits it. `max` and `average` over one present value are that
    value, which is why the three policies cannot disagree on a blank.
  - **Publishing did not ask a fourth time.** `resultsVisible` is not consulted by any of
    this and did not grow a fourth meaning: resolution walks _the activity list the caller
    may see_, and `publishedOnly` already filtered it. So an unpublished redo cannot reach
    the student's number, an unpublished covered activity is absent for them exactly as it
    is today, and `computeBothViews` remains one evaluator called twice with two lists.
    That is the same shape F24's answer has had since slice 8, arrived at by adding
    nothing.
  - **A redo may not cover a redo, or itself**, refused where the use is saved. With no
    chains there is no cycle to detect and no order to compute, so resolution is one pass
    in `position` order — and two redos over the same TP fold left, which under `replace`
    means the later one on the page wins.

  Two smaller things, both refusals: a redo grades the **same way** as what it covers (same
  `value_type`, same scale), or a `numeric` 1 would land on a `done` activity and read as
  _hecho_; and `removeUse` drops the coverage rows on **both** sides of the use it deletes,
  or the foreign key turns "quitar de la materia" into a 500.

  **`writableStudents` and `roster` needed nothing** (F38, slice 9): a redo's results are
  `result` rows on one of the home's activities, so both already see them. The third writer
  slice 9 predicted turned out not to be a writer at all.

### F24 · Publishing and what students see

- [x] **Status:** built (slice 7); the computed mark is slice 8's
- **Decision:** Results are hidden until the teacher publishes the activity for the class,
  which replaces the per-row `Visible` column. Students see their published results, the
  feedback text on each, and their live computed mark.
  **The student's computed mark uses published activities only**, otherwise it would
  leak unpublished results. The teacher's preview (F20) shows both views side by side.

  **Built 2026-09-20**, minus the live computed mark, which is F20's.
  `GET /api/homes/:oferta/results/mine` is the student's half. Two things
  settled by building it:

  - **Publishing the statement and publishing the marks are two dates.**
    `results_published_at` is a column of its own and not
    `offering_article.published_at`, which decides when the _article_ appears
    (F4). A teacher posts the TP statement on Monday and marks it on Friday, so
    one flag cannot serve both. A `timestamptz` rather than a boolean, like
    everything else here: F36 keeps _when_, and F30's "a result was published"
    needs an instant to fire on.
  - **The rule is one function, `resultsVisible`, and it is deliberately not
    `mayRead`.** Two differences, both load-bearing. Staff here is
    `manageOffering` alone — `editLibrary` is teaching _any_ offering of the
    subject in any year, which is the right gate for fixing a typo in an article
    and the wrong one for reading a class's marks. And the article's own
    visibility is **not** consulted: a teacher who unpublishes a statement in
    October has not asked to take back the marks they published in September,
    and a student watching them vanish could not tell that from a mistake.

  **F22 asked this a third time and got a different answer (slice 9).** An official grade
  is visible the moment it exists — a term carries no `results_published_at` and cannot,
  and `resultsVisible` did not grow a third meaning. See F22.

  **F23 asked a fourth time and needed nothing (slice 10).** A redo is an activity, so it
  has its own `results_published_at` — and the two dates together need no rule, because
  redo resolution walks _the activity list this view may see_ and `publishedOnly` has
  already filtered it. An unpublished redo cannot reach a student's number; an unpublished
  covered activity is absent for them exactly as it is today. Filtering the **list** and
  not the results is load-bearing a third time. See F23.

  **The computed mark arrived 2026-09-20 (slice 8)**, and `resultsVisible` got its first
  caller — it had none until now, since `myResults` carried the same rule in its `where`.
  The teacher's grid returns **both numbers per student per term**, `all` and `published`,
  from one evaluator called twice with different **activity lists**. Filtering the activity
  list and not merely the results is the load-bearing half: an unpublished activity left in
  would sit in `done_ratio`'s denominator (F20) and tell the student it is there, which is
  the same leak this item forbids, arriving by arithmetic instead of by a row.

### F25 · Due dates and grading

- [x] **Status:** decided
- **Decision:** **Display only**: calendar and "vence en N días". ~~and the 48 h
  notification (F30).~~ **The 48 h notification was dropped from F30 (slice 15).** Without
  submissions (F2), campus has no way of knowing when something was turned in, so a late
  flag would be a guess entered by hand.

  **`due_at` exists since slice 7** (F18), on the offering's use of the article.
  Nothing reads it yet; F16's calendar is what it is for.

---

## Group F — Gradebook (staff)

### F26 · Grid editor

- [x] **Status:** decided
- **Decision:** A spreadsheet-like grid of students × activities per offering, with keyboard
  navigation, paste from the clipboard and a bulk "mark all done". It replaces the Sheets
  UX that teachers are used to. Only teachers of the offering and admins can open it (F5).

  **The api half is built (slice 7)**: `GET /api/homes/:oferta/gradebook` is the
  whole grid in one read — groups, terms, scales, the presets, the activities,
  the roster and the marks — and `PUT …/results` saves every touched cell in one
  call. The screen is a person's (F44); what this slice owes it is a shape.

### F27 · CSV / XLSX import and export

- [x] **Status:** built (slice 16), CSV only
- **Decision:** Export an offering's gradebook, and import one back to bulk-set results.
  Import shows a diff before applying and matches students by directory id or DNI. It is the
  escape hatch for teachers who still want to work in a spreadsheet.

  **Built 2026-09-21 (slice 16).** `GET /api/homes/:oferta/gradebook/export` and `POST
…/gradebook/import[?dryRun=true]`, in `api/src/offerings/gradebook-csv.ts`. **CSV only**:
  XLSX waits until a teacher asks, and no dependency was added. Decided with the user
  before the slice: the diff is a dry run of the same call and nothing is stored between
  the two; an empty cell leaves the mark alone, so an import never clears (a clear deletes
  history, F38/F41); the export has activity marks and official grades of the enrolled, and
  no computed marks (F20); the id wins over the DNI, and names are ignored. Settled by
  building it:

  - **The file is what es-AR Excel opens on a double click**: UTF-8 with a BOM, `;`,
    decimal comma, CRLF. The import also takes `,` (the header line decides), a decimal
    point, no BOM, and Latin-1 when the bytes are not UTF-8. Done is `hecho`/`no hecho`, a
    scale level is its name, both case-insensitive. A DNI may carry Excel's dots.
  - **Headers are matched on the brackets.** An activity is `Title [slug]`, so a renamed
    title still imports. An official grade is `1er trimestre [nota oficial]`: the tag has a
    space, so it can never be a slug, and the term is named by its name (unique, F39). A
    renamed term makes an old file's column `unknown_column`, which says to export again.
  - **The diff is the write set.** A cell that already says what the file says is counted
    in `unchanged` and never written, because `result` is append-only (F41) and a re-save
    would be a history row saying somebody re-marked the class. A changed mark keeps its
    `feedback`, and a changed grade keeps its observation and suggestion. None of those are in
    the file.
  - **All or nothing.** Every problem is listed (`unknown_student`, `not_writable`,
    `duplicate_student`, `no_student_key`, `unknown_column`, `duplicate_column`,
    `bad_value`, `bad_file`), and applying with any of them present is a `400
import_invalid` that carries the same diff next to the error. A clean file goes through
    `saveResults` and `saveOfficialGrades` in **one transaction**. Their `db` is now
    `Db | Tx`, which is still one write path each and not a third. `writableStudents`
    became one `UNION` for it, since a transaction is one client and pg refuses concurrent
    queries on one.
  - **The body is the raw file**, `Content-Type: text/csv`, on its own `express.raw` at
    1 MB. One file and no fields is not worth multipart, and anything else is a `415`. A
    client sets the header by hand, because browsers label a `.csv` however the OS does.
  - **A text cell that starts like a formula** (`= + - @`) is exported with a `'`. Names and
    titles are ignored on import, so the round trip never sees the prefix.
  - The dry run and the export are reads and pass F35's lock; applying is `mustWrite`.
  - **This is the first payload that carries a DNI**, read on its own and not through
    `roster`.

### F28 · Results API

- [ ] **Status:** deferred until after launch
- **Decision:** A public API for results, for scripts and future integrations, is wanted but
  **not built for launch**. No sibling pushes today: neither MEV nor tic-host has a caller
  waiting. When it is built, the defaults are: tic-auth client credentials with a scope such
  as `campus:results:write`, results landing as **drafts** a teacher publishes (F24),
  and activities named by their opaque campus id.
- **Settled (slice 18, re-deferred 2026-09-21):** still no caller. A generic scripted import
  is F27's job over a teacher session, so nothing was built. When it is:
  - **Recorded by:** the client acts _for_ a teacher named in the request, who must pass
    `manageOffering`. `recorded_by` stays a real `directory.user` (F41): no nullable column,
    no service user. Do not rebuild `SERVICE_USER`.
  - **Reach:** exactly the named teacher's offerings. No per-client table.
  - **Scope:** results **and** official grades, as two scopes (`campus:results:write`,
    `campus:grades:write`), through the single writers `saveResults` and
    `saveOfficialGrades`, under F35's lock. Check that tic-auth declares both scopes.
  - **Drafts:** probably free. Visibility is `offering_article.results_published_at` (F24), so
    "drafts" means the machine cannot publish. Confirm there is no per-result state to add.
  - **Tokens:** a client-credentials token's `sub` is the client id (a string) and it has no
    `roles`. Give it its own verifier entry point and middleware, not a branch in the person
    path, and refuse a token on the wrong path in both directions.
- **To settle (when un-deferred):** The first real caller, and its payload (DNI or user id
  for students).

---

## Group G — Revisions and notifications

### F29 · Revision requests

- [x] **Status:** built (slice 11)
- **Prior art:** the old `RevisionRequest` model (reason, bonus tasks, comment, reviewed).
- **Decision:** A student asks for a re-check of a specific **result**, and the request
  ~~references that result row, not an activity id string.~~ **names it by
  `(offering_article_id, student_id)`, which is that row's own natural key.** The teacher
  answers from an inbox and ~~can change the mark from the request itself.~~ **answers, and
  changes the mark with the call that already exists for it.** Rules:
  - A student can only ask about a **published** result, one they can already see (F24).
  - **One open request per result.** A new one is allowed only after the previous one is
    answered.
  - The request carries a reason and, optionally, **bonus tasks** (extra work the student
    offers), kept from the old model. The teacher's answer is a comment.
  - No request window: a request can be made any time before the year locks (F35).

  **Built 2026-09-20 (slice 11), and amended on the two sentences struck above.** Five
  things settled by building it:

  - **It names the mark by its natural key, not by `result.id`.** A request is always about
    a mark that _exists_ — it is never filed against an unmarked activity, and "estaba sin
    hacer" is a teacher's non-passing mark for work not handed in rather than an absent row
    — so both keys were populatable and this was a choice. Three things decided it. The body
    is keyed this way regardless, because a student may only ever read their **own** result
    and so cannot name a partner's row id, and filing is a group flow (below). The inbox
    reads home → activities → requests, one join shorter than reaching `offering_article`
    through `result`, and the same direction `result_article_student_idx` is ordered for.
    And `result` rows are **deleted** when a teacher empties a cell (F38), so a `result_id`
    would be a foreign key onto something a teacher can remove: no foreign key in this
    schema sets `onDelete`, so an emptied cell inside a bulk save would be a 500 on "borrar
    la nota", and a clear-then-retype would silently mint a new id and orphan the
    conversation. That last one is rare and is not a revision flow — it is why this is a
    footnote and not the case. `db.test.mjs` asserts the property directly: the mark goes,
    the conversation stays.
  - **Group filing is kept, and it is why `requested_by` is a column.** The old dialog let a
    student file for themselves _and_ the partners they worked with, and that survives: one
    `POST` writes one row per student. F29 assumed one filer per result and now does not.
    Two consequences, both deliberate. `GET …/results/mine` grew a **`classmates`** key,
    because nothing in campus had ever told a student who is in their class — `roster` had
    exactly one caller and it was teacher-only — and a partner picker cannot be built
    without one. That is a real widening: every enrolled student now learns the class list
    with ids, which is what the old campus shipped, and it carries names and nobody else's
    marks. And a junk request filed _for_ a classmate blocks their own until a teacher
    answers it; the old campus has the identical hole, and what makes it tolerable is that
    `requested_by` is on both reads, so a teacher can see who filed it and clear it in
    seconds. Rendering the row without the filer would let one student publish words under
    another's name to the person who grades them.
  - **Answering writes no mark.** F29's own sentence says the teacher can change it from the
    request itself; F38 says `saveResults` is the one write path for a `result`, and a second
    one here would be a second place branching on `value_type`. So the screen makes two
    calls — `PUT …/results` and `POST …/revisions/:id/answer` — and they are independently
    meaningful in either order. The rejected alternative was an optional entry on the answer
    body delegating to `saveResults`; it is a ten-line upgrade the day somebody wants it
    atomic.
  - **"One open request per result" is Postgres's, and it is this schema's first partial
    index.** F18's split: a value domain is one writer's, uniqueness across concurrent
    writers is not, and two tabs are two writers. `answered_at IS NULL` is the whole of
    "open" — no `resolved` boolean, which would be a second thing to keep true, the argument
    `redo_covers` makes against an `is_redo` flag. `offering_home`'s "total, never partial"
    does **not** apply: that index is total because it is an `ON CONFLICT` target, and a
    partial index is a perfectly good target as long as its predicate travels with it. So
    the write is one `INSERT … ON CONFLICT (…) WHERE answered_at IS NULL DO NOTHING
RETURNING`, and the rows that come back are the ones that landed — the difference is
    exactly the set that already had one open, with no pre-`SELECT` for two tabs to both
    pass. Answering therefore unblocks the next request, which is what partial buys.
  - **There is deliberately no cross-offering inbox.** F5 scopes a teacher to the revisions
    of the offering they teach, and F6 asks for the number across offerings as a **count**.
    So `GET /api/homes/:oferta/revisions` is the list and one correlated subquery on
    `listMine` is the count, and no read here fans out over "everything I teach" —
    `listMine` remains the only thing that does. The count is gated on the per-row `teaches`
    expression and not on the caller's roles, or a teacher who also studies something would
    read the queue on the card for the subject they _study_.

  **What a redo means here needed nothing** (F23, asked again). A redo is an
  `offering_article` with its own `value_type` and its own `results_published_at`, so "any
  published graded activity of this home" already covers it and a redo's own mark is
  disputable exactly like any other. A student may file separately about a TP and about the
  recuperatorio that covers it: those are two activities and so two results, which is what
  the rule has said all along.

  **What is still not built:** ~~F30's "a revision was answered" fires here and is F30's, a
  table and a bell of its own.~~ **Built with F30 (slice 15)**, without touching this file:
  the bell derives it from `answered_at`, for both the `student_id` and the `requested_by`. "Before the year locks" is F35's since slice 14: filing and
  answering both 409 once it has.

### F30 · In-app notifications

- [x] **Status:** built (slice 15)
- **Decision:** A bell with unread items. Three triggers: a result was published, a revision
  was answered, ~~an activity is due within 48 h~~ **a new article was published, when its
  teacher asks for the class to be told**. No email: the VM has no outbound SMTP story, and
  students check campus anyway.

  **Built 2026-09-21 (slice 15), with the triggers amended.** The 48 h trigger was dropped
  and replaced with "new article", which a teacher turns on per use with
  `offering_article.notify`. It is **off by default**, because a TP statement is news and a
  theory note filed under unit 3 mostly is not. Settled by building it:

  - **Derived on read, and no trigger writes a row.** Each kind is a fact another table
    already holds, together with its instant: `results_published_at` (F24), `answered_at`
    (F29), and `published_at` on a use with `notify`. `GET /api/notifications` is three
    `SELECT`s over those tables. This makes two things free that would otherwise have needed a job
    runner on a box with one replica and none. A publish dated for Friday shows up on the bell on
    Friday. A student who changes course stops getting the old course's items as soon as the
    directory says so. The rejected alternative wrote rows from `saveResults`, `useArticle`
    and `answerRequest`, fanned out over the roster at write time. It needs a scheduler for a
    dated publish, and it goes stale when enrolment moves.
  - **The only state is a receipt**, `campus.notification_read (user, kind, target,
read_at)`, and not F37's reserved `notification`, since a row here means "read". An item
    is unread **unless a receipt for it is at or after its instant**. A re-answered request or
    a publish moved later is news again, and no code handles either case.
  - **Recipients are whoever is enrolled now**: an `exists` on `directory.enrollment`, which is
    `seeOwnMarks`'s question, so the bell never offers a link that would 403. A published
    result goes to the students who have a mark on it. An answer goes to the request's
    `student_id` and to its `requested_by`, so with group filing the filer hears about each
    partner's answer. An article goes to the enrolled class. Nothing about it is per role, so
    staff with no enrolments get an empty bell rather than a refusal.
  - **No year and no lock (F35).** A mark published in a locked year is still the student's to
    see. What keeps last year off the bell is a **30-day window** on the item's instant. The
    read is capped at 50 items, and `unread` counts the whole window. `markRead` sweeps the
    caller's receipts older than the window. None of them can hide anything still on the
    bell, because everything inside the window happened after they were written.
  - **The count rides on the list, not on `/api/offerings/mine`**, which is year-scoped and
    per offering. The bell is global and makes one call.
  - `POST /api/notifications/read` takes `{ items: [{ kind, target }] }`. "Mark all" means the
    client sends every item it holds, since "all as of when" has no other honest answer.
    Nothing checks that the items belong to the caller, because a receipt only ever
    changes the caller's own bell.

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
  client has to interpret before it can tell the person their action worked.

  **Amended 2026-09-20 (slice 5), on both deferred points.**
  - **Deactivation is now `archived_at`** (F36), as this item said it would become. The
    condition it named has been met: `offering_article` hangs off the home, and F37 hangs
    `result` and — since slice 11 — `revision_request` off that, so a `DELETE` behind an
    idempotent admin button would take a teacher's work with it, and a cascade would
    eventually take students' marks. Re-activating clears the flag and keeps everything.
  - **"Activation creates the home with the subject library's program" is satisfied by
    writing nothing.** An activated offering shows the library's program (F15) because the
    read derives it from `program_unit`, not because activation copied it. Same outcome for
    zero rows, and strictly better: a unit added to the library _after_ an offering was
    activated reaches it too, which a copy would have missed. Default **sections** remain
    F14's, and remain unbuilt.

### F35 · Past years: public and read-only

- [x] **Status:** built (slice 14), for marks — see below
- **Decision:** When a school year ends, its offerings **stay public at their year's URLs**
  and students keep seeing their own marks. The **gradebook locks**: no results, official
  grades or revision requests. Only an admin can unlock an offering. The article content
  still follows the library (F8), so fixes reach past years too.
  **The lock is automatic on a configured date**, 31 December by default. An admin can
  move that date or unlock a single offering for a late grade fix.

  **Built 2026-09-21 (slice 14), for marks only.**

  - **Locked is computed, not stored**: from 00:00 in Buenos Aires on the day after
    `YEAR_LOCK` (F42, `12-31` by default) of the offering's directory year. A year closes
    without anybody writing a row. It is a date and not `is_current`, because the
    directory rolls the year when the office does, which may be March.
  - **What it refuses, `409 locked`**: `PUT …/results`, `PUT …/official-grades`, `PUT
…/gradebook` and its three `DELETE`s, and both halves of a revision (a student's
    `POST …/revisions`, the teacher's answer). The gradebook setup is on the list
    because formulas and terms decide the computed mark, so editing them after the lock
    rewrites marks just as surely. A `409` and not a `403`: nobody lacks a permission.
  - **What it leaves alone**: every read, the formula preview (it saves nothing), the
    home's configuration and its article uses, and the library (F8). "Read-only" is
    about the marks: a past year's home stays the teacher's.
  - **The unlock is a flag, not a date.** `offering_home.unlocked_at`, set and cleared by
    an admin with `POST` / `DELETE /api/admin/offerings/:offeringId/unlock`, both
    idempotent like activation. The date is global and moves in `.env`, so what an admin
    decides per offering is only "this one, now".
  - **The grid and `/results/mine` carry `locked`**, so a screen goes read-only before
    anybody types into a save that would 409.
  - Checked in the routes (`mustWrite` in `routes/gradebook.ts`, `assertUnlocked` in
    `offerings/content.ts`), not in `manageableHome`: that one gate also serves the
    reads and the home, which the lock does not touch.

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

  | Table               | Holds                                                                                                                                                                                                                                                                                                                                                                                                            | Key references                                                                  |
  | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
  | `article`           | library article: subject, slug, title, `published_version_id`, `draft_version_id`, `archived_at` (F7, F8, F11)                                                                                                                                                                                                                                                                                                   | → `public.subject`                                                              |
  | `article_version`   | one saved body: Markdown source, author, created_at (F11)                                                                                                                                                                                                                                                                                                                                                        | → `article`, `public."user"`                                                    |
  | `program_unit`      | the subject's program: title, Markdown contents, position (F15)                                                                                                                                                                                                                                                                                                                                                  | → `public.subject`                                                              |
  | `offering_home`     | **built (slice 4)**, `final_formula` **slice 8**, `redo_policy` **slice 10**, the home configuration **slice 13**, `unlocked_at` **slice 14** — activation, `archived_at` (F36), the offering's final formula (F21, F40), what a redo does to what it covers (F23), and F14's `sections`, `links`, `unit_order` and `hidden_units` (F14, F15), and F35's per-offering unlock; the slug fallback arrives with F32 | → `public.offering`                                                             |
  | `offering_unit`     | **not built** — the offering's order and hiding of units are arrays of `program_unit.id` on `offering_home` (slice 13), so no per-offering copy exists; see F15                                                                                                                                                                                                                                                  | —                                                                               |
  | `offering_article`  | **built (slice 5)**, grading fields **slice 7** — an offering's **use** of an article: unit, position, publish date, visibility (F4), F30's `notify` **slice 15**, and F18's group, term, value type, scale, due date and `results_published_at`. It files under `program_unit` for good — there is no `offering_unit_id` (F15, slice 13)                                                                        | → `offering_home`, `article`, `program_unit`, `offering_group`, `offering_term` |
  | `offering_group`    | **built (slice 7)** — a teacher-named bucket: name, position (F20, F39)                                                                                                                                                                                                                                                                                                                                          | → `offering_home`                                                               |
  | `offering_term`     | **built (slice 7)**, `formula` **slice 8** — a term of this offering: name, position, mark formula as source text; the optional dates arrive with F16 (F21, F39, F40)                                                                                                                                                                                                                                            | → `offering_home`                                                               |
  | `offering_scale`    | **built (slice 7)** — a named ordered scale, plus `offering_scale_level` (name, number, position) (F19, F39)                                                                                                                                                                                                                                                                                                     | → `offering_home`                                                               |
  | `redo_covers`       | **built (slice 10)** — which uses a redo covers; a redo _is_ an activity, so there is no flag (F23)                                                                                                                                                                                                                                                                                                              | → `offering_article` ×2                                                         |
  | `result`            | **built (slice 7)**, append-only **slice 12** — one student's result for one activity, one row per time it was marked; the newest row is the mark (F38, F41)                                                                                                                                                                                                                                                     | → `public."user"`, `offering_article`                                           |
  | `official_grade`    | hand-entered term grade: value, observation, suggestion (F22)                                                                                                                                                                                                                                                                                                                                                    | → `public."user"`, `offering_term`                                              |
  | `revision_request`  | **built (slice 11)** — a student disputes a mark: reason, bonus tasks, who filed it, the teacher's answer, `answered_at` (F29). It names the mark by `(offering_article_id, student_id)` and **not** by `result.id`, because a result row is deleted when a cell is emptied — see F29                                                                                                                            | → `offering_article`, `public."user"` ×3                                        |
  | `notification_read` | **built (slice 15)** — F30's receipts, and F30's only state: user, kind, target, `read_at`. The items themselves are derived on read, so there is no `notification` table (F30)                                                                                                                                                                                                                                  | → `public."user"`                                                               |
  | `upload`            | id, subject, uploader, filename, media type, size, sha256 (F9)                                                                                                                                                                                                                                                                                                                                                   | → `public.subject`, `public."user"`                                             |
  | `audit_event`       | **not built** — marks keep their own history in `result` (slice 12); publishes, activations and locks are unaudited until something asks (F41)                                                                                                                                                                                                                                                                   | → `public."user"`                                                               |
  | `session`           | one signed-in person: mapped claims, refresh token, `claims_at`, hard cap, CSRF token (F3)                                                                                                                                                                                                                                                                                                                       | → `public."user"`                                                               |
  | `login_flow`        | the `state` and PKCE verifier between `/api/auth/login` and its callback, 600 s (F3)                                                                                                                                                                                                                                                                                                                             | —                                                                               |

  The bytes of an upload live on the volume at a path derived from the id; the row is the
  index, which is what makes listing, quotas and garbage collection possible. ~~Serving a
  file checks the visibility of the articles that reference it.~~ **Reopened 2026-09-20
  (slice 6): it cannot be built and should not be.** The api parses no Markdown (F7, F44),
  so it cannot know which articles reference an upload, and the check would only have
  stopped somebody guessing a uuid. An upload is subject-scoped and served to anybody
  holding its id — F9 has the full reasoning and the upgrade path.

### F38 · A result is a record of what a student did

- [x] **Status:** built (slice 7)
- **Decision:** `result` is `(student_id, offering_article_id, value, scale_level,
feedback, recorded_by, recorded_at)`, ~~unique on the first two~~ **one row per time a
  mark was set, the newest being the mark (slice 12)**. **It carries no course**:
  a result records that this person did this activity and got this, and a student who later
  changes course does not change that fact. The absence is a feature, not a gap — there is
  no composite key to maintain and no history to rewrite when a roster does.
  The API checks `directory.enrollment` when a result is _created_; a later unenrollment
  leaves the result standing, and the gradebook shows it as a student no longer in the
  offering rather than hiding it.
  **One numeric `value` column** is what the formula aggregates: done = 1, not done = 0, a
  scale level = its mapped number. `scale_level` keeps what the teacher actually picked, for
  display. A single aggregatable column is what keeps the evaluator from branching per type.

  **Built 2026-09-20.** Four things settled by building it:

  - **There is no blank result.** `value` is `NOT NULL` and clearing a cell
    deletes the row, because F20's "blank" already means _a missing row_ — a
    nullable value would be a second spelling of the same thing for the
    evaluator to branch on. So `value: null` in a save is the **only** way to
    empty a cell, said out loud: `{ "done": false }` is _not done_ and
    `{ "value": 1 }` is a one, and a falsy check would have deleted both.
  - ~~**The unique index is declared `(offering_article_id, student_id)`**, the
    other way round from the sentence above. The uniqueness is the same either
    way, and this is the order every read goes in — from a home's activities to
    their rows, never from a student — so one index does both jobs.~~ **The
    index is `(offering_article_id, student_id, recorded_at DESC)` and is not
    unique** — see slice 12 below. The column order and its reason stand.
  - **The enrolment check really is create-only, and that has two halves.** The
    writable set is _enrolled now, plus whoever already carries a row here_, so
    a teacher can still fix the mark of somebody who transferred out in April.
    And the grid lists that person, flagged `enrolled: false`, rather than
    hiding them — hiding one would hide the mark that still needs fixing.
  - **A scale level's number is copied in at write time**, which is what makes
    the one aggregatable column true. The consequence is that moving `MB` from 8
    to 9 has to move the marks given on it, so `writeSetup` rewrites them in the
    same transaction. Without that the display would change and the mark would
    not.

  **Amended 2026-09-21 (slice 12), on the two sentences struck above.** `result`
  is no longer unique on `(offering_article_id, student_id)`: a changed mark is
  a new row, and the current mark is the pair's newest by `recorded_at`, then
  `id`. F41 has the reason. Three things did not move:

  - **The blank rule is unchanged.** No rows is blank, still one shape for the
    evaluator to skip. A clear deletes **every** row of the pair, history
    included, because a cleared mark is a withdrawn one — wrong student, wrong
    activity — and not a grade that changed. A tombstone would have cost the
    nullable `value` this item refused, a filter in every other read, and an
    activity that could never leave an offering once marked.
  - **The scale remap is still an `UPDATE`**, and it rewrites superseded rows
    too. It is not a mark: the student still got `MB`, and a row per mark would
    say whoever edited the scale re-marked the class. `scale_level_id` is the
    truth and `value` is what that level is worth _now_.
  - **Only the two readers of a value changed.** The grid and `/results/mine`
    read through one `DISTINCT ON` subquery; every other read of `result` asks
    whether a row exists, where the extra rows do not matter. No payload moved.

### F39 · Groups, terms and scales are rows

- [x] **Status:** built (slice 7)
- **Decision:** `offering_group` (F20), `offering_term` (F21) and `offering_scale` +
  `offering_scale_level` (F19) are tables per offering, each with a name and a position, and
  an activity references them by id. Renaming a group then touches neither the activities nor
  the formula. Scales can also be seeded from global presets, which live in code rather than
  in a settings table.

  **Built 2026-09-20, and amended on the sentence above.** ~~Renaming a group
  then touches neither the activities nor the formula.~~ **It touches the
  activities not, and the formula is not yet decided.** An activity does
  reference a group by id, so renaming one moves nothing there. But F20's
  formula spells `avg(tps)` — by _name_ — and there is no immutable key column
  to spell instead. Slice 7 did not add one (nothing reads a formula yet, and a
  column for a reader that does not exist is the thing F21's dates were left out
  for), so **F20's slice has to settle it**, either with a `key` column
  backfilled from these names in one statement, or with a rename that rewrites
  the offering's formula text. It is written down here so that slice decides it
  rather than discovering it.

  **Settled 2026-09-20 (slice 8): a formula names the group, and a rename that would
  orphan one is refused.** Neither way out written down above was taken, because of a third
  fact neither accounted for: **a group's name is free text up to 80 characters**, so
  `Trabajos Prácticos` is legal and is not spellable as a bare identifier _either way_. A
  `key` column does not remove that problem, it adds a second name — and after one rename
  the formula says `trabajos_practicos` while the screen says something else, which is
  exactly the drift that makes a wrong number hard to see. So the parser learned to quote a
  name instead (F20), and `writeSetup` re-validates every formula of the offering against
  the names it just wrote, inside the transaction and by re-reading rather than trusting the
  payload.

  The cost is a `409 group_renamed_in_use`, and it is cheap to avoid because **the names and
  the formulas travel in one body**: one save renames the group and fixes the formula
  together. It is the answer `duplicate_name` already gives, and the one the deletes give —
  `deleteGroup` and `deleteTerm` now also refuse a row a formula names, under the codes they
  already use, because "something still points at this" is the same fact and a client
  branches on it the same way.

  So the sentence struck through above can be restated whole: **renaming a group touches the
  activities not, and the formula only in the same save.**

  Two more things settled by building it:

  - **`name` is unique per offering, and that is the database's job.** Two
    concurrent saves cannot both check-then-insert, which is exactly why this is
    not the same question as F18's `value_type`. The cost is that swapping two
    names is two `UPDATE`s and the first raises — answered with a `409
duplicate_name` telling the teacher to save it in two steps, rather than a
    rename through a temporary name campus invented.
  - **The whole-list save never deletes**, F15's rule and for F15's reason, and
    that extends down to a scale's **levels**: a level a result points at cannot
    vanish under it. So levels are add-and-rename-only for now. A scale nothing
    uses can be deleted whole and retyped; once an activity uses it, a spare
    level stays in the dropdown. A per-level `DELETE` is the obvious fix the day
    that annoys somebody, with the same `409` the other three deletes use.

### F40 · Formulas are text, validated on save

- [x] **Status:** built (slice 8)
- **Decision:** `offering_term.formula` and `offering_home.final_formula` hold the source
  text. Saving parses it and rejects unknown functions or groups; the evaluator re-parses on
  read, which costs microseconds. No compiled AST column, because a cache of a parse is a
  second thing that can disagree with the text.
  **Computed marks are never stored** (F20): they are derived on read from published results
  (F24). Nothing to invalidate when a result, a formula or a publish changes.

  **Built 2026-09-20 (slice 8)**, both columns, in `0006_the_formula_text` — two nullable
  `text`s and no backfill. Held as decided, including the parts that were tempting:

  - **No compiled AST column, and no computed mark anywhere.** A `db.test.mjs` subtest asserts
    that `campus` has no column whose name contains `mark`, so the temptation fails a test
    rather than a review.
  - **The validation runs inside the save's transaction and re-reads**, rather than checking
    the payload. The whole-list save never deletes, so a term the body left out keeps its
    formula and a group the body left out keeps its name — only the database knows the state
    a rename actually produced. A refusal rolls the whole save back.
  - **A formula is `undefined` to leave alone and `null` to clear**, F15's no-delete-by-
    omission rule extended to a column: a client that does not know about formulas must not
    wipe one by saving the panel it does know about. An empty string is stored as `null`,
    because `""` would be a third state that parses as an error forever.
  - Parsing happens once per formula per request and is evaluated N times. That is a local
    variable, not the cache this item refuses: nothing outlives the request, so nothing can
    disagree with the text it came from.

### F41 · Campus keeps its own audit log

- [x] **Status:** built (slice 12, marks; slice 17, official grades)
- **Decision:** An append-only `campus.audit_event` records who changed a result or an
  official grade, who published an activity, and who activated, locked or unlocked an
  offering. Grades get contested, so _"who set this to 4, and when"_ has to be answerable;
  article history (F11) already answers it for content. Append-only **by grant**, the way
  tic-auth's own audit table is: `campus_svc` gets `SELECT, INSERT` and nothing else.
  Writing to tic-auth's `public.audit_event` is not an option — campus holds no privilege
  on it.

  **Built 2026-09-21 (slice 12), for marks, by deleting a unique index.** The
  answer was not a table. `recorded_by` and `recorded_at` were always the right
  columns; they lied only because the write was an upsert, so they said _who
  holds this mark now_ and the previous marker went with the previous mark.
  `result` is now append-only — a change inserts, the current mark is the pair's
  newest row — and per row the two columns answer exactly _who set this value,
  and when_. The 4 a student disputes under F29 is still there, with whoever set
  it, after the teacher changes it to a 7.

  **The rejected alternative was a sibling `audit_event` table** written by
  `saveResults` in the same transaction. It is a second write that a future
  writer can forget, and a second copy of the mark free to drift from the first.
  "There is only one write path, so there is only one place to remember" is the
  argument that usually saves that design, and here it cuts the other way: with
  one writer, a parallel log that writer maintains by hand buys nothing. Nor is
  it append-only **by grant**: a clear still deletes the pair's rows (F38), so
  `campus_app` keeps `DELETE` on `result`.

  **Publishes, activations and locks are left unaudited, on purpose,** until
  something asks. They are not rows in `result`, and if they are wanted they
  get a small event table of their own — two mechanisms because there are two
  shapes: a mark is high-volume and per cell and its history _is_ the data; an
  activation is a rare admin act, where a generic event row is the honest fit.
  ~~**`official_grade` is not covered either**: it still upserts, with the hole
  slice 9 describes below, and the same index change would close it.~~ **Closed
  in slice 17**, below. This is the item's fifth appearance, and its last for
  marks.

  **Built 2026-09-21 (slice 17), for official grades, the same way, and made
  readable.** Migration `0014_the_grade_history` drops the unique
  `official_grade_term_student_idx` and recreates it on `(offering_term_id,
student_id, recorded_at DESC)`; `saveOfficialGrades` inserts, and it has to,
  since `ON CONFLICT` needs a unique index to target. `readOfficialGrades` and
  `myOfficialGrades` read the pair's newest row through a `DISTINCT ON`
  subquery, `currentResults`' shape; no payload moved. `checkGrades` now
  deduplicates a cell sent twice, last one winning, as `checkEntries` does.
  **A text-only edit is a new row too**: the row is the whole record — value,
  observation and suggestion — so changing the observation of a 4 is somebody
  setting the boletín's words, and that is worth the row. A clear still deletes
  every row of the pair (F38). F27's import compares against the current row,
  so an unchanged cell still mints nothing.

  **The history is readable, by staff.** Until now "who set this to 4" was
  answerable in SQL only. `GET /api/homes/:oferta/results/:activityId/:studentId/history`
  and `GET …/official-grades/:termId/:studentId/history` answer `{ history }`,
  newest first, gated on `manageOffering` like the grid and open on a locked
  year because they are reads. The order is the current row's own
  (`recorded_at DESC, id DESC`), so `history[0]` is always the cell the grid
  shows. Each row carries `recordedByName`/`recordedBySurname`, joined the way
  F29's inbox joins its filer, because nothing else on the boletín names a
  teacher and an id is not an answer. A foreign activity or term is an empty
  list rather than a 404: the join is the scoping, and it leaks nothing.
  Students get no history — they read the current value, and F29 is where they
  argue with it.

  **Slice 11 widened it a fourth time and still did not build it.** F29's whole reason for
  existing is the question _"who set this to 4, and when"_ — and answering a request is
  followed by a mark change through `saveResults`, whose upsert overwrites `recorded_by`
  with the teacher who resolved the dispute. So the one flow where the previous marker is
  the thing actually being asked about is the flow that destroys it. `revision_request`
  keeps its own `requested_by`/`requested_at` and `answered_by`/`answered_at`, which records
  the _conversation_ and deliberately not the mark's history; the mark's history is this
  item, and there are now three tables wanting it.

  **Slice 9 widened it and still did not build it.** `official_grade` carries the same
  inline `recorded_by`/`recorded_at` as `result`, for the same consistency and with the
  same hole: an upsert overwrites the marker along with the grade. Two tables now need this
  item rather than one.

  **Slice 7 made this concrete and did not build it.** A result is written by an
  upsert, so `recorded_by` and `recorded_at` answer _who holds this mark now_,
  not _who set it to 4_ — the previous marker is overwritten along with the
  previous mark. That is the exact question this item exists for, and until
  `audit_event` is built, nothing in campus can answer it.

### F42 · Admin-level values live in code, not a settings table

- [x] **Status:** built (slices 7 and 14)
- **Decision:** The year-lock date (F35) and the global scale presets (F19) are constants in
  the api, overridable by environment where the box needs it. A settings table for two
  values would be a screen, a migration and a cache for something that changes once a year.

  **Built 2026-09-20, the scales half.** `SCALE_PRESETS` is a constant in
  `api/src/offerings/gradebook.ts`, served inside the gradebook read so a client
  can offer "arrancá con ésta" — it is **not a resource** and there is
  deliberately no `GET /api/scale-presets`.

  **Built 2026-09-21 (slice 14), the lock half.** `YEAR_LOCK` (`MM-DD`, default
  `12-31`) is read once by `loadConfig` and refused at boot if the date does not
  exist — `02-29` included, or a leap-year setting would lock on 1 March three
  years in four.

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
