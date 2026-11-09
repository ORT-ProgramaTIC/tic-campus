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

| Question          | Answer                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| What it is        | Per-offering course sites: articles, activities, a gradebook, marks for students                                                                                                                                                |
| Surface           | **Standalone** at `tic-campus.ort.edu.ar`. No campus.ort.edu.ar embed, no shadow DOM, no `loadFromLink.html`. campus.ort at most links here                                                                                     |
| Web               | React 19 + Vite + Tailwind 4 + TanStack Query + React Router. A static SPA served by `tic-campus-web` (nginx), the same stack as BurocraTIC, MEV and tic-host                                                                   |
| API               | Express 5 + Drizzle + pg + jose + pino, SQL migrations checked in. **Mirrors MEV.** No Prisma                                                                                                                                   |
| Identity          | **tic-auth**, as a confidential backend client (`tic-auth/docs/CLIENTS.md`). Campus mints no tokens. The campus.ort PHPSESSID relay is gone, and login is whatever tic-auth offers (Google or AD)                               |
| Roster            | **Read live from the `directory.*` views.** Campus owns no users, courses, subjects, offerings, enrollments, time slots or teacher assignments                                                                                  |
| Datastore         | The `campus` schema in the shared `tic-db`. **No Google Sheets anywhere**                                                                                                                                                       |
| Hosting           | Co-tenant stack at `/opt/tic-campus` (M14), `tic-campus-edge` + `tic-db` (api only)                                                                                                                                             |
| Launch            | **School year 2027**, except F45 and Group M (F46–F50), which ship ahead for 2026 Proyecto: its presentations and its grades. The old campus finishes 2026 untouched. No data migration, no marks import, no article conversion |
| Document language | This document is in English. **All user-facing copy is in Spanish (rioplatense)**                                                                                                                                               |
| Sequencing        | Items are grouped by area, not by delivery phase. Sequencing lives in each item's **Status**                                                                                                                                    |

## How this file works

This file follows the family's record rules, `../../tic-platform/RECORD-CONVENTIONS.md`
(adopted 2026-11-08), whose reference implementation is `tic-host`. In short:

- An **index of every item**, then the full text of the open ones. Closed items move verbatim
  to `docs/features/M<n>-*.md`, and the index row says which. A citation like
  `FEATURES.md F22` resolves through the index. IDs are never reused.
- **Status** is one of `open`, `decided`, `building` (text below), `built`, `done`, `dropped`,
  `deprecated` (text archived). `built` means verified locally while a `DEPLOY-DAY.md` entry
  is still open. **Notes** carries the rest: deferrals, what a closed item left unbuilt, and
  the entries it waits on (`waits on D1`). **The index wins** over an archived Status line,
  which records what the item was when it moved.
- A `decided` or `building` item leads with `- **Decision, in short:**`. A later slice that
  revisits a closed item is a new item whose title says `amends F<n>`, never a reopening.
- Anything only the box can show (tic-auth, the directory's real data, the doctor, backups)
  gets a `DEPLOY-DAY.md` entry, and the item is `built` until it closes.
- `bin/check-docs.py` checks all of this, and runs in `pnpm test`.

## Index

Every item, in order.

| Item                                                          | Status   | Notes                                                       | Where                                                           |
| ------------------------------------------------------------- | -------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| F1 · What tic-campus is for                                   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F2 · Explicit non-goals                                       | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F3 · Login, through tic-auth                                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F4 · Anonymous read                                           | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F5 · Roles and permissions, derived from the directory        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F6 · "Mis materias"                                           | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F7 · Articles are Markdown, stored in the database            | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F8 · Subject library, used by offerings                       | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F9 · Uploads                                                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F10 · Embeds                                                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F11 · Drafts and revision history                             | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F12 · Several teachers editing                                | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F13 · Units                                                   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F14 · One configured home per offering                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F15 · Program                                                 | done     | per-offering reorder and hide not built                     | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F16 · Calendar                                                | decided  | deferred until after launch                                 | below                                                           |
| F17 · No special page types                                   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F18 · An activity is an article                               | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F19 · Value types                                             | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F20 · The mark formula                                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F21 · Terms and the final                                     | done     | term dates arrive with F16                                  | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F22 · Official term grade                                     | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F23 · Redos                                                   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F24 · Publishing and what students see                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F25 · Due dates and grading                                   | decided  | deferred with F16                                           | below                                                           |
| F26 · Grid editor                                             | building | API built (slice 7); the grid screen is for the 2027 launch | below                                                           |
| F27 · CSV / XLSX import and export                            | done     | CSV only, no XLSX                                           | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F28 · Results API                                             | decided  | deferred until after launch                                 | below                                                           |
| F29 · Revision requests                                       | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F30 · In-app notifications                                    | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F31 · tic-platform compliance                                 | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F32 · Public URLs                                             | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F33 · Mobile-first student views                              | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F34 · An admin activates offerings                            | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F35 · Past years: public and read-only                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F36 · Keys and conventions                                    | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F37 · The tables                                              | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F38 · A result is a record of what a student did              | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F39 · Groups, terms and scales are rows                       | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F40 · Formulas are text, validated on save                    | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F41 · Campus keeps its own audit log                          | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F42 · Admin-level values live in code, not a settings table   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F43 · A brand redesign, not today's identity                  | open     |                                                             | below                                                           |
| F44 · The interface is built by hand                          | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F45 · Presentation schedule                                   | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F46 · The Proyecto grade table                                | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F47 · Notas: the staff tab                                    | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F48 · Notas: search                                           | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F49 · Track colours                                           | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F50 · Nota: the student tab                                   | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F51 · URL segments come from the registry's slugs, amends F32 | decided  | waits on tic-registry F2                                    | below                                                           |

---

## Item format

```markdown
### F<n> · <title>

- [ ] **Status:** <status> (<date>)
- **Decision, in short:** at most ten lines, once anything is decided
- **Prior art:** ... (only where a sibling or the old campus already answered this)
- **To settle:** the actual open question(s)
- **Decision:** _(filled in when made, with the reasoning — not just the answer)_
```

---

## Group D — Homes

**Built 2026-09-20.** `offering_article.program_unit_id` points at the **library's** unit
directly. See F15 for why there is no per-offering copy of the units yet.

### F16 · Calendar

- [ ] **Status:** deferred until after launch
- **Decision, in short:** A campus-wide calendar of activity due dates (F18) and teacher-added events;
  school-wide events come from a directory view proposed to tic-auth. Deferred until after
  launch, when it becomes the only reader of `due_at` (F25).
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

## Group E — Activities and grading

### F25 · Due dates and grading

- [x] **Status:** decided
- **Decision, in short:** Due dates are display only: the calendar and "vence en N días". No 48 h
  notification and no late flag, since campus has no submissions. `due_at` exists since slice 7;
  nothing reads it until F16.
- **Decision:** **Display only**: calendar and "vence en N días". ~~and the 48 h
  notification (F30).~~ **The 48 h notification was dropped from F30 (slice 15).** Without
  submissions (F2), campus has no way of knowing when something was turned in, so a late
  flag would be a guess entered by hand.

  **`due_at` exists since slice 7** (F18), on the offering's use of the article.
  Nothing reads it yet; F16's calendar is what it is for.

## Group F — Gradebook (staff)

### F26 · Grid editor

- [x] **Status:** decided
- **Decision, in short:** A spreadsheet-like grid of students × activities per offering: keyboard
  navigation, paste from the clipboard, a bulk "mark all done". Teachers of the offering and
  admins only. The API (one read, one save) is built; the screen is still to build.
- **Decision:** A spreadsheet-like grid of students × activities per offering, with keyboard
  navigation, paste from the clipboard and a bulk "mark all done". It replaces the Sheets
  UX that teachers are used to. Only teachers of the offering and admins can open it (F5).

  **The api half is built (slice 7)**: `GET /api/homes/:oferta/gradebook` is the
  whole grid in one read — groups, terms, scales, the presets, the activities,
  the roster and the marks — and `PUT …/results` saves every touched cell in one
  call. The screen is a person's (F44); what this slice owes it is a shape.

### F28 · Results API

- [ ] **Status:** deferred until after launch
- **Decision, in short:** A results API for scripts, not built for launch: no caller yet. When it is, a
  tic-auth client acts for a named teacher (`manageOffering`), with `campus:results:write` and
  `campus:grades:write` scopes, through the single writers and F35's lock, and cannot publish.
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

## Group I — Structure and UX

### F51 · URL segments come from the registry's slugs, amends F32

- [ ] **Status:** decided (2026-11-08), unbuilt. Waits on `tic-registry` F2, which adds the
      stored slugs this reads.
- **Decision, in short:** URLs keep F32's segments, `/<year>/<subject>/<offering>/<article>`,
  but the subject segment becomes the registry's `subject.slug` and the offering segment the
  registry's course part (`/2026/prog2/5a5b/tp-sql`), instead of slugifying names on read.
  The registry freezes both while an activity's AD groups are on, so a shared link stops
  moving when someone fixes a name.
- **Why:** F32 derives both segments from names (`api/src/offerings/slug.ts`): a rename in the
  directory moves every URL, and an old link lands on "no encontrado". `tic-registry` F2
  (2026-11-08) gives offerings a stored slug built from subject, courses and year
  (`prog2-5a5b-26`), for tic-host's single-segment URLs. Campus has its own origin and can keep
  readable segments; it only needs the same parts (user, 2026-11-08: "can't we use more /
  segments rather than a single slug?").
- **Decision (user, 2026-11-08):**
  1. **Segments, not the registry's whole slug.** `/2026/prog2-5a5b-26/…` would repeat the year
     and the subject.
  2. **The subject segment is `directory.subject.slug`** (`tic-registry` F2 decision 4).
  3. **The offering segment is the registry's course part**, the courses joined, as in the
     middle of its offering slug. `offering.name` no longer wins over the courses.
  4. F32's other rules stand: year-scoped, an article slug set once with a redirect from an old
     one, and no redirect for a renamed offering.
- **To settle while building:** whether `directory.offering` publishes the course part on its
  own, so campus reads it rather than re-deriving it from the registry's rule; and whether links already shared in 2026 (Proyecto's tabs are in use) need a redirect from the old segments.

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
