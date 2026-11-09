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

| Item                                                        | Status   | Notes                                                       | Where                                                           |
| ----------------------------------------------------------- | -------- | ----------------------------------------------------------- | --------------------------------------------------------------- |
| F1 · What tic-campus is for                                 | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F2 · Explicit non-goals                                     | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F3 · Login, through tic-auth                                | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F4 · Anonymous read                                         | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F5 · Roles and permissions, derived from the directory      | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F6 · "Mis materias"                                         | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F7 · Articles are Markdown, stored in the database          | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F8 · Subject library, used by offerings                     | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F9 · Uploads                                                | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F10 · Embeds                                                | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F11 · Drafts and revision history                           | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F12 · Several teachers editing                              | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F13 · Units                                                 | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F14 · One configured home per offering                      | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F15 · Program                                               | done     | per-offering reorder and hide not built                     | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F16 · Calendar                                              | decided  | deferred until after launch                                 | below                                                           |
| F17 · No special page types                                 | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F18 · An activity is an article                             | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F19 · Value types                                           | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F20 · The mark formula                                      | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F21 · Terms and the final                                   | done     | term dates arrive with F16                                  | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F22 · Official term grade                                   | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F23 · Redos                                                 | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F24 · Publishing and what students see                      | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F25 · Due dates and grading                                 | decided  | deferred with F16                                           | below                                                           |
| F26 · Grid editor                                           | building | API built (slice 7); the grid screen is for the 2027 launch | below                                                           |
| F27 · CSV / XLSX import and export                          | done     | CSV only, no XLSX                                           | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F28 · Results API                                           | decided  | deferred until after launch                                 | below                                                           |
| F29 · Revision requests                                     | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F30 · In-app notifications                                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F31 · tic-platform compliance                               | built    | waits on D1                                                 | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F32 · Public URLs                                           | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F33 · Mobile-first student views                            | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F34 · An admin activates offerings                          | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F35 · Past years: public and read-only                      | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F36 · Keys and conventions                                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F37 · The tables                                            | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F38 · A result is a record of what a student did            | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F39 · Groups, terms and scales are rows                     | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F40 · Formulas are text, validated on save                  | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F41 · Campus keeps its own audit log                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F42 · Admin-level values live in code, not a settings table | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F43 · A brand redesign, not today's identity                | open     |                                                             | below                                                           |
| F44 · The interface is built by hand                        | done     |                                                             | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F45 · Presentation schedule                                 | done     | in use for 2026 Proyecto                                    | [`docs/features/M1-the-rebuild.md`](features/M1-the-rebuild.md) |
| F46 · The Proyecto grade table                              | building |                                                             | below                                                           |
| F47 · Notas: the staff tab                                  | building |                                                             | below                                                           |
| F48 · Notas: search                                         | building |                                                             | below                                                           |
| F49 · Track colours                                         | building |                                                             | below                                                           |
| F50 · Nota: the student tab                                 | building |                                                             | below                                                           |

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

## Group M — Proyecto grades

The marks a Proyecto teacher gives at the end of a rotation: one per student, typed rather
than computed, shown to the student only when the teacher says so. **It ships for 2026
Proyecto**, ahead of the 2027 launch, which makes it the Launch row's second exception
after F45. Two tabs: **Notas** for staff (F47) and **Nota** for students (F50).

### F46 · The Proyecto grade table

- [ ] **Status:** building
- **Decision, in short:** `campus.project_grade`: one typed grade per student per rotation (10–6, PIA,
  DICIEMBRE), keyed by student and offering home. Hidden until the teacher flips `visible`, per
  student. Append-only like `official_grade`; a clear deletes the pair's history.
- **Prior art:** F22's `official_grade` (a typed grade per student per term) and F18/F19's
  scale activity (a named scale, published per activity). Both are close, and neither fits.
- **Decision:** **A table of its own, `campus.project_grade`**: related to the gradebook's
  grades, not the same thing (decided 2026-11-05). "Project" here means the subject
  Proyecto. The row is keyed by student and offering, never by a tic-registry project.
  A student is graded alone, whichever team they are on.

  - **Why not `official_grade`:** it hangs off a term, and its `value` is `numeric` 1–10
    checked by `checkMark`. PIA and DICIEMBRE aren't numbers, Proyecto homes have no
    terms, and loosening either one reaches the formula machinery (F20, F21) that 2027
    depends on.
  - **Why not a scale activity:** its visibility is `results_published_at` per
    **activity**, so it's shown to the whole class or to nobody. This needs visibility
    **per student**.
  - **One grade per student per rotation** (decided 2026-11-05). Rotation is the
    offering (F45), so the row hangs off `offering_home`, like `presentation` does.
  - **Values:** `10`, `9`, `8`, `7`, `6`, `pia`, `diciembre`. Text checked in the api, no
    enum (F18's rule). PIA and DICIEMBRE are **labels only** for now: no rule, no date,
    no formula reads them (decided 2026-11-05). A blank is an absent row (F38).
  - **`visible` is a boolean, default `false`.** Typing a grade is never publishing it.
    It's per row because it's per student. This is the draft state F22 declined for
    term grades, and the reasoning doesn't carry over: a Proyecto grade gets typed during
    the presentations, while the teacher is still deciding, not when a boletín is due.
  - **Append-only** (F41), the shape `official_grade` has had since slice 17: a change
    inserts a row, the current grade is the pair's newest by `recorded_at` then `id`, and
    flipping `visible` alone is a change too, so the history answers "who showed this,
    and when". Clearing deletes the pair's whole history, for `result`'s reason.

  ```
  project_grade
    id               uuid pk default random
    offering_home_id uuid not null → offering_home
    student_id       int  not null → public."user"
    value            text not null
    visible          boolean not null default false
    recorded_by      int  not null → public."user"
    recorded_at      timestamptz not null default now()
    index (offering_home_id, student_id, recorded_at desc)
  ```

  Migration `0017_the_project_grades.sql`.

### F47 · Notas: the staff tab

- [ ] **Status:** building
- **Decision, in short:** Notas, a staff-only course tab: the offering's roster with course, project and
  track, where only the grade and its visibility are editable. Sortable, saves each change at
  once, bulk show/hide over the visible rows, asks before a clear, read-only in a locked year.
- **Decision:** A course tab, `/:year/:subject/:offering/notas`, beside Presentaciones and
  Cronograma in the local nav. Staff only: the offering's teachers and admins
  (`capabilitiesFor` gives admins `ALL`). Anyone else is redirected to the student page,
  the way Cronograma's loader does. It draws `<Rotations />` beside its title, so each
  tab keeps its own rotation.

  **The roster** is `roster`'s rule (F38): the offering's enrolled, plus anyone who has
  left but still holds a `project_grade` here, flagged. **Only the grade and its
  visibility are editable** (decided 2026-11-05). Campus owns no people (the Roster row
  above), so who is on the list is tic-registry's business.

  | Column   | Kind              | Source                                                                                 |
  | -------- | ----------------- | -------------------------------------------------------------------------------------- |
  | Apellido | fixed, sortable   | `directory.user.surname`                                                               |
  | Nombre   | fixed, sortable   | `directory.user.name`                                                                  |
  | Curso    | fixed, sortable   | the enrolment's course, shown as its last two characters (`4A`), `rotationName`'s rule |
  | Proyecto | fixed, sortable   | `directory.project_member` for this offering → `directory.project.name`                |
  | Rol      | fixed, sortable   | that member row's `track`, as a chip (F49)                                             |
  | Nota     | editable (select) | F46                                                                                    |
  | Visible  | editable (eye)    | F46                                                                                    |
  - **Sorting:** one active column, ascending then descending on click (`aria-sort`),
    `localeCompare(…, "es")`. Default is Apellido, Nombre ascending. **Blanks sort last
    in both directions.**
  - **No project:** Proyecto and Rol are blank (decided 2026-11-05). A grade may still be
    owed.
  - **Two projects in one rotation** (tic-registry allows it): both are listed,
    comma-separated, each with its own Rol chip. The row sorts by the first, alphabetically
    (decided 2026-11-05).
  - **Nota colours:** 10 is green, 6 is yellow, and 9 to 7 step between them. PIA is
    orange, DICIEMBRE red, blank neutral. They're tokens in `index.css`, and each pair is
    **measured** against AA (4.5:1) the way tic-registry measured its tags, not
    eyeballed.
  - **Visible:** an eye (`Eye` / `EyeOff`). Disabled while there's no grade, since there's
    nothing to show.
  - **Bulk:** "Mostrar todas" / "Ocultar todas" (decided 2026-11-05) act on **the rows the
    search currently shows** that have a grade, and the button says how many ("Mostrar
    12"). Showing one team's grades is the case for that.
  - **Saving:** each change saves at once, optimistically, and rolls back with an inline
    error on failure, the way presentation state does. One route for both:
    `PUT /api/homes/:oferta/project-grades` with `entries: [{ studentId, value, visible }]`.
    That's F22's cell shape: entries nobody sent are untouched, and `value: null` clears.
    A bulk flip is one request and one transaction.
  - **Clearing asks first** ("¿Borrar la nota de Ana Gómez?"), and it's the only edit
    that does (decided 2026-11-05). A clear deletes the pair's whole history (F46), so
    it's the one change on the tab that can't be undone.
  - **Past years are read-only** (F35): the `PUT` takes `assertUnlocked`, the
    gradebook's lock, so a closed year is `409 locked` and an admin's unlock is the way
    through. The `GET` carries `locked`, and the tab renders without controls.
  - **Mobile:** the table scrolls inside its card, with Apellido sticky.

### F48 · Notas: search

- [ ] **Status:** building
- **Decision, in short:** Notas gets tic-registry's search: Buscar por Estudiante or Proyecto, with its
  accent- and order-insensitive matcher ported with its tests, filtered in the browser.
- **Prior art:** tic-registry's Proyectos screen: a "Buscar por" select (Nombre proyecto /
  Nombre integrante) beside a text input, and `fold` plus a word-wise matcher in
  `web/src/lib/text.ts`.
- **Decision:** The same thing on Notas (decided 2026-11-05): **Buscar por** Estudiante /
  Proyecto, and the input. Estudiante matches name and surname, Proyecto matches any of
  the row's projects. The matcher is **ported with its tests**: accents and ñ fold, case
  folds, and every word must appear in any order, so `munoz ana` finds "Ana Muñoz". It
  filters in the browser, since a rotation is about 60 rows and the payload is already
  the whole roster.

### F49 · Track colours

- [ ] **Status:** building
- **Decision, in short:** tic-registry's track colours and tag tokens, ported as is, so a Rol chip matches
  the discipline's colour on tic-registry's timetable.
- **Prior art:** tic-registry's `subjectColor` (`web/src/lib/timetableColors.ts`), keyed by
  track label because track labels are the seminar subject names. Its colours are
  measured against AA, and IOT is flipped to ink.
- **Decision:** Ported as is, together with the `--color-tag-*` and
  `--color-subject-frontend` tokens campus doesn't have yet, so a student's Rol chip
  wears the colour their discipline has on tic-registry's timetable. Fullstack has no
  entry there and takes the hashed fallback, same as there. `trackLabel` already copies
  the labels; the colour keys off its output.

### F50 · Nota: the student tab

- [ ] **Status:** building
- **Decision, in short:** Nota, the student's tab: their own grade, large, with their project and Rol chip.
  Hidden and ungraded both read "Pendiente Devolución". No rotation select, no notification;
  staff are redirected to Notas.
- **Decision:** A course tab, `/:year/:subject/:offering/nota`, for students enrolled in
  the offering (`seeOwnMarks`). Decided 2026-11-05.

  - **Students get a tab bar:** Presentaciones · Nota, the same row staff have.
    Until now a student had one page and no row.
  - **No rotation select.** A student is graded only in their own rotation, so the other
    one's Nota would always be empty. The tab bar's Nota link always points at the
    student's own offering, even while they browse the other rotation's Presentaciones,
    and the local nav's per-tab memory (F47) does the rest.
  - **What it shows:** the grade, large. Underneath, their project(s) and Rol chip (F49)
    as context. Nothing else, since there's no comment field (F46).
  - **Colours differ from the staff table:** every number 10–6 is **green**. Only
    **PIA** (orange) and **DICIEMBRE** (red) are coloured differently. The staff table's
    green-to-yellow scale (F47) helps a teacher scan a class; on a student's own page,
    the only distinction that matters is passed or not.
  - **Hidden and ungraded read the same: "Pendiente Devolución".** The api answers `null`
    for both (`GET /api/homes/:oferta/project-grades/mine`, visible only), so the page
    can't tell them apart either, and the eye can't leak.
  - **Past years:** a student still sees their own visible grade, read-only (F35).
  - **No notification** when a grade becomes visible. F30's bell is 2027 machinery that
    nothing in the 2026 build uses yet. That's a separate item if anyone asks for it.
  - **Who else:** staff opening `/nota` are redirected to Notas. A signed-in user who
    isn't enrolled gets the student page, the way Cronograma's loader handles non-staff.
