import {
  index,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directorySubjectTable, directoryUserTable } from "./directory.js";

/**
 * **Two tables in one file, because they reference each other.** `article`
 * points at the version it publishes and the version it is being drafted as;
 * `article_version` points back at the article it is a version of. Split across
 * two modules that is a circular import; here it is a forward reference, which
 * is what the `(): AnyPgColumn` annotation below spells. The generated SQL is
 * unaffected either way — drizzle-kit emits foreign keys as their own
 * `ALTER TABLE` statements after every `CREATE TABLE`.
 */

/**
 * A library article: Markdown belonging to a **subject**, not to a course and
 * not to a year (F8). An offering *uses* it, and next year's offering uses the
 * same row, which is what makes a fix reach every offering instead of the one
 * whose copy somebody remembered. It is also what `templateId` could not do:
 * that shared content across courses but not across years.
 *
 * `publishedVersionId` and `draftVersionId` are both nullable and both point at
 * `article_version` (F11): an article with a draft and no published version has
 * never been published, and one with a published version and no draft has no
 * unsaved work. Publishing is moving the pointer, so it takes no deploy and
 * reaches every offering at once.
 *
 * Retirement is `archivedAt` rather than a status column (F36), so *when*
 * something was retired survives.
 */
export const article = campus.table(
  "article",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: integer("subject_id")
      .notNull()
      .references(() => directorySubjectTable.id),
    /** Stable, and what a URL carries. Unique per subject, not globally: two
     *  subjects may both have a `condicionales`. */
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    publishedVersionId: uuid("published_version_id").references(
      (): AnyPgColumn => articleVersion.id,
    ),
    draftVersionId: uuid("draft_version_id").references(
      (): AnyPgColumn => articleVersion.id,
    ),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("article_subject_slug_idx").on(t.subjectId, t.slug)],
);

/**
 * One saved body. Every publish keeps one, and any of them can be restored as
 * the new draft (F11) — which is also the answer to *"who changed this, and
 * when"* for content, the question F41's audit log answers for grades.
 *
 * `authorId` points at `public."user"` and is **not** nullable: tic-auth never
 * deletes a user, it deactivates one, so the row this points at outlives the
 * person's account. Reading the author's name is a separate privilege and a
 * separate query, against `directory."user"`.
 */
export const articleVersion = campus.table(
  "article_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    articleId: uuid("article_id")
      .notNull()
      .references(() => article.id),
    /** Markdown source, directives and all (F7). Plain text on purpose:
     *  diffable, exportable, and readable in a SQL console. */
    body: text("body").notNull(),
    authorId: integer("author_id")
      .notNull()
      .references(() => directoryUserTable.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("article_version_article_created_idx").on(t.articleId, t.createdAt),
  ],
);
