import {
  boolean,
  integer,
  pgSchema,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * tic-auth's half of the database, declared so campus can reference it and read
 * it (F31, Group J). **Nothing here is ours**, nothing here is created by a
 * campus migration, and `drizzle.config.ts`'s `schemaFilter: ['campus']` is
 * what keeps `pnpm db:generate` from trying.
 *
 * **The file has two halves because a view cannot be a foreign-key target.**
 * That single fact is why the four roles exist:
 *
 * ```sql
 * GRANT SELECT     ON directory.subject TO campus_app;  -- reads
 * GRANT REFERENCES ON public.subject    TO campus;      -- migrations
 * ```
 *
 * `REFERENCES` is a distinct privilege and **does not imply `SELECT`**. The
 * runtime role holds nothing at all on the base tables below and its inserts
 * are still checked against them, because the referential check belongs to the
 * system rather than to the caller. So constraints name `public.*` and every
 * read names `directory.*`, and mixing the two up produces a permission error
 * blaming the wrong half.
 */

/* ── Foreign-key targets: `public.*`, referenced and never selected ────────── */

/**
 * Three of the four tables `tic-auth/tic_auth/settings_db.py`'s
 * `REFERENCEABLE_TABLES` grants `campus` `REFERENCES` on. `public.course` is on
 * that list and deliberately absent here: nothing campus owns points at a
 * course — an offering's courses are read from `directory.offering_course` —
 * and a declaration nothing points at reads as a dependency that does not
 * exist.
 *
 * Widening the list itself is a negotiation, not a change here — a table added
 * to it is a table tic-auth may then never drop, so it is argued in the open
 * (`tic-auth/docs/CONSISTENCY.md`). `public.subject` was the fourth, added in
 * tic-auth's `0016`.
 *
 * Only `id` is declared. A wider declaration would read like something campus
 * may select, and it may not: `has_table_privilege('campus_svc',
 * 'public."user"', 'SELECT')` is false.
 *
 * The ids are **`integer`**, because tic-auth's are (`0001`): its `user.id` is
 * what teacher-owned spreadsheets key on, so the whole directory stayed on
 * preserved integers rather than moving to uuids. Ours are uuids (F36) and the
 * two do not meet — Postgres refuses an int↔uuid foreign key outright, which is
 * the cheap way to find out you declared the wrong one.
 *
 * **`pgTable`, not `pgSchema('public')`**, which drizzle refuses outright:
 * *"You can't specify 'public' as schema name. Postgres is using public schema
 * by default."* So these read as unqualified tables, and what keeps
 * `pnpm db:generate` from emitting a `CREATE TABLE` for them is
 * `schemaFilter: ['campus']` — the foreign keys still resolve, because
 * drizzle-kit takes a constraint's target from the referenced column's own
 * table rather than from the set it is generating.
 */
export const directoryUserTable = pgTable("user", {
  id: integer("id").primaryKey(),
});

/** The abstract subject, which the library belongs to (F8). Distinct from
 *  `directorySubject` below, and the distinction is the whole reason both
 *  exist: this one is pointed at and never read, that one is read and never
 *  pointed at. */
export const directorySubjectTable = pgTable("subject", {
  id: integer("id").primaryKey(),
});

/** What `campus.offering_home` activates (F34). A concrete instance of a
 *  subject in a term, served to one or more courses — the thing a campus home,
 *  a gradebook and a public URL all belong to. */
export const directoryOfferingTable = pgTable("offering", {
  id: integer("id").primaryKey(),
});

/* ── Read surface: `directory.*`, selected and never referenced ────────────── */

const directory = pgSchema("directory");

/**
 * Declared in full, because the grant is table-wide: tic-auth's `0005` narrows
 * only the views carrying a `dni`, and campus is a full reader. A partial
 * declaration would imply a restriction that does not exist and would mislead
 * whoever next widens it.
 *
 * `marks` is upstream's own flag for whether the subject is graded. Nothing
 * reads it yet; it is declared because the view publishes it.
 */
export const directorySubject = directory
  .view("subject", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    specialty: text("specialty"),
    marks: boolean("marks").notNull(),
  })
  .existing();

/**
 * The person, and everything the view publishes about them — **`dni` included**.
 *
 * MEV declares five columns here because `mev_app` holds a *column* grant and
 * `select *` fails for it. Campus is not narrowed: tic-auth's `0005` computes
 * the narrowed set from `reads_dni=False`, and `mev_app` is the only member.
 * Copying MEV's declaration would be campus declaring somebody else's
 * restriction, and the next person to need a `dni` would read it as a refusal.
 *
 * `is_active` is deactivation, not deletion: a departed teacher stays
 * referenceable because rows still point at them.
 */
export const directoryUser = directory
  .view("user", {
    id: integer("id").notNull(),
    dni: text("dni"),
    email: text("email").notNull(),
    name: text("name"),
    surname: text("surname"),
    isActive: boolean("is_active").notNull(),
  })
  .existing();

/**
 * A course — `NR5A`, and the specialty it belongs to. Campus reads it for one
 * thing: the names that make an offering's slug when the offering has no name
 * of its own (F32).
 *
 * `year` and `is_current` are flattened here by tic-auth from
 * `academic_year`, which is not published. **Currency is derived and not
 * stored**, so the filter is literally `where is_current` and campus must not
 * compute its own from a clock (`tic-auth/docs/CONSISTENCY.md`).
 */
export const directoryCourse = directory
  .view("course", {
    id: integer("id").notNull(),
    name: text("name").notNull(),
    specialty: text("specialty").notNull(),
    academicYearId: integer("academic_year_id").notNull(),
    year: integer("year").notNull(),
    isCurrent: boolean("is_current").notNull(),
  })
  .existing();

/**
 * The offering: a subject, taught in a term, to one or more courses.
 *
 * **`name` is nullable and display-only.** It exists to tell two offerings of
 * one subject apart — "Frontend" split into 1 and 2 — and
 * `tic-auth/tic_auth/models/directory.py:89-91` is explicit that `subject.name`
 * alone is what gets matched against elsewhere. So it may steer a slug and it
 * may not carry meaning.
 *
 * `kind` (`mandatory` | `optional`) and `term_kind` (`first` | `second` |
 * `full`) are Postgres enums, read as text because campus branches on neither.
 * `term_kind` is what the old campus called `Offering.semester`.
 */
export const directoryOffering = directory
  .view("offering", {
    id: integer("id").notNull(),
    subjectId: integer("subject_id").notNull(),
    termId: integer("term_id").notNull(),
    name: text("name"),
    kind: text("kind").notNull(),
    termKind: text("term_kind").notNull(),
    academicYearId: integer("academic_year_id").notNull(),
    year: integer("year").notNull(),
    isCurrent: boolean("is_current").notNull(),
  })
  .existing();

/**
 * Which courses an offering is served to — and **the only source of that fact**.
 *
 * `SELECT DISTINCT course_id, offering_id FROM directory.enrollment` looks like
 * the same question and is not: it reports only the pairs that already have a
 * student in them, so an offering nobody is enrolled in yet has no courses at
 * all (tic-auth's `0010`).
 */
export const directoryOfferingCourse = directory
  .view("offering_course", {
    id: integer("id").notNull(),
    offeringId: integer("offering_id").notNull(),
    courseId: integer("course_id").notNull(),
  })
  .existing();

/**
 * Who teaches an offering (F5). Offering-level and never per-block: the
 * per-block table is `time_slot_teacher`, which **overrides** this one rather
 * than adding to it, and a consumer that unions the two shows people in rooms
 * they are not in (`tic-auth/docs/CONSISTENCY.md`). Campus reads neither
 * timetable table yet; the timetable is a campus-wide view rather than a home
 * section (F14, slice 13), and that resolution belongs to it.
 *
 * Teacher-*of-subject* (F5's library permission) has no relation of its own: it
 * is a row here joined through `offering.subject_id`, on any offering of that
 * subject, in any year.
 */
export const directoryTeacherOffering = directory
  .view("teacher_offering", {
    id: integer("id").notNull(),
    teacherId: integer("teacher_id").notNull(),
    offeringId: integer("offering_id").notNull(),
  })
  .existing();

/**
 * What a student is taking, keyed `(student_id, offering_id)`. It is a UNION of
 * the mandatory half (their course's offerings) and the optional half
 * (`student_offering`, which is never published), and `via` says which.
 *
 * **It is not "who is in this course" and it is not "is this person a
 * student".** Three questions, three relations, and tic-auth's `0006` measured
 * the cost of confusing them: on the 2026-09-02 snapshot, courses `NR5A`–`NR5E`
 * had no `offering_course` rows, so this view silently omitted 129 of 356
 * current students. A student in that state sees an empty "Mis materias", and
 * that is a directory row to add rather than a UNION to write here.
 */
export const directoryEnrollment = directory
  .view("enrollment", {
    studentId: integer("student_id").notNull(),
    courseId: integer("course_id").notNull(),
    offeringId: integer("offering_id").notNull(),
    via: text("via").notNull(),
  })
  .existing();

/**
 * An offering's weekly modules: which day, which block, which room — tic-registry's
 * `0010`. Read for one thing, F45's rule that a presentation block is one the
 * class actually meets in.
 *
 * **`slot` is the block number** (1–6), and campus calls it a block: in F45 a
 * *slot* is a presentation turn inside a block, and two meanings of one word in
 * one feature is how a payload gets built wrong. `day` is a Postgres enum,
 * `monday`…`friday`, read as text.
 *
 * The per-module teacher override (`time_slot_teacher`) is not declared:
 * nothing here asks who teaches a module.
 */
export const directoryOfferingTimeSlot = directory
  .view("offering_time_slot", {
    id: integer("id").notNull(),
    offeringId: integer("offering_id").notNull(),
    day: text("day").notNull(),
    slot: integer("slot").notNull(),
    classroom: text("classroom"),
  })
  .existing();

/**
 * A student project — and **the team, since there is no separate team entity**
 * (tic-registry `docs/SCHEMA.md`, "A project is its team"). Read for F45's
 * presentation schedule, which orders teams.
 *
 * Scoped to a term and not to an offering: the same students carry one project
 * across Proyecto and a seminar. Which offerings it runs in is
 * `project_offering`, which is **not published** — so campus finds an
 * offering's projects through `project_member.offering_id` below, and a project
 * nobody has joined yet is not in any offering campus can see.
 *
 * `name` is a free-text label and not unique; `slug` is the handle tic-host
 * builds container names from. Campus displays the first and keys on neither —
 * it keys on `id`, which is the only one that never changes.
 */
export const directoryProject = directory
  .view("project", {
    id: integer("id").notNull(),
    termId: integer("term_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    adGroupName: text("ad_group_name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    academicYearId: integer("academic_year_id").notNull(),
    year: integer("year").notNull(),
    isCurrent: boolean("is_current").notNull(),
  })
  .existing();

/**
 * Who is on a project, and **which of its offerings justifies them being
 * there** — `offering_id` is a leg of tic-registry's composite key, not a
 * convenience, and it is why "this offering's teams" is answerable at all.
 *
 * `track` is a discipline (Backend, UX/UI…), deliberately not called `role`.
 * Read as text, like `offering.kind`, because campus branches on none of it.
 */
export const directoryProjectMember = directory
  .view("project_member", {
    id: integer("id").notNull(),
    projectId: integer("project_id").notNull(),
    offeringId: integer("offering_id").notNull(),
    userId: integer("user_id").notNull(),
    courseId: integer("course_id").notNull(),
    track: text("track").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
  })
  .existing();
