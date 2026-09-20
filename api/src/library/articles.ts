import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article, articleVersion } from "../db/schema/article.js";
import { directoryUser } from "../db/schema/directory.js";
import { ApiError } from "../middleware/errors.js";
import { slugify } from "../offerings/slug.js";

/**
 * The subject's article library (F8): Markdown, a draft, and every version that
 * was ever published (F11).
 *
 * **Nothing here parses the Markdown.** `article_version.body` goes in and
 * comes out as the teacher typed it, directives and all. F7's allowlist —
 * `:::callout`, `::download{…}` and the rest — is the renderer's job, and
 * putting `remark` behind this api would make the server own how content looks
 * (F44).
 *
 * **Publishing is moving a pointer**, so it takes no deploy and reaches every
 * offering using the article at once, past years included (F8).
 */

export interface ArticleSummary {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  /** There is unpublished work: a draft that is not the published version. */
  hasUnpublishedDraft: boolean;
  createdAt: Date;
}

export interface VersionSummary {
  id: string;
  authorId: number;
  authorName: string | null;
  createdAt: Date;
}

export interface ArticleDetail extends ArticleSummary {
  draft: { id: string; body: string } | null;
  publishedVersionId: string | null;
  /** Newest first. The bodies are not here — `readVersion` fetches one. */
  versions: VersionSummary[];
}

/** Every live article of a subject. Archived ones are gone from the shelf. */
export async function listLibrary(
  db: Db,
  subjectId: number,
): Promise<ArticleSummary[]> {
  const rows = await db
    .select(SUMMARY)
    .from(article)
    .where(and(eq(article.subjectId, subjectId), isNull(article.archivedAt)))
    .orderBy(article.title);
  return rows.map(summarize);
}

/**
 * Create one, or bring an archived one back under the same slug.
 *
 * The unique index on `(subject_id, slug)` is **total**, so an archived article
 * keeps its slug forever — and archiving is the only way to undo a typo in a
 * slug that is set once (F32). Without the revival below, one mistake would
 * burn that URL for the life of the subject. A conflict with a *live* article
 * still updates nothing and comes back as a 409.
 */
export async function createArticle(
  db: Db,
  subjectId: number,
  slug: string,
  title: string,
): Promise<ArticleSummary> {
  const [row] = await db
    .insert(article)
    .values({ subjectId, slug, title })
    .onConflictDoUpdate({
      target: [article.subjectId, article.slug],
      set: { title, archivedAt: null },
      setWhere: isNotNull(article.archivedAt),
    })
    .returning(SUMMARY);

  if (!row) {
    throw new ApiError(
      409,
      "slug_taken",
      `Ya hay un artículo con la dirección "${slug}" en esta materia.`,
    );
  }
  return summarize(row);
}

/** The draft, the published pointer, and the history to restore from (F11). */
export async function readArticle(
  db: Db,
  subjectId: number,
  slug: string,
): Promise<ArticleDetail | null> {
  const found = await findLive(db, subjectId, slug);
  if (!found) return null;

  const [draft] = found.draftVersionId
    ? await db
        .select({ id: articleVersion.id, body: articleVersion.body })
        .from(articleVersion)
        .where(eq(articleVersion.id, found.draftVersionId))
        .limit(1)
    : [];

  // The author's name is a join against `directory."user"`, which is a separate
  // privilege from reading the version itself — see the note on the table.
  const versions = await db
    .select({
      id: articleVersion.id,
      authorId: articleVersion.authorId,
      authorName: sql<
        string | null
      >`${directoryUser.name} || ' ' || ${directoryUser.surname}`,
      createdAt: articleVersion.createdAt,
    })
    .from(articleVersion)
    .leftJoin(directoryUser, eq(directoryUser.id, articleVersion.authorId))
    .where(eq(articleVersion.articleId, found.id))
    .orderBy(desc(articleVersion.createdAt));

  return {
    ...summarize(found),
    draft: draft ?? null,
    publishedVersionId: found.publishedVersionId,
    versions,
  };
}

/** One body, for reading a revision or restoring it (F11). */
export async function readVersion(
  db: Db,
  subjectId: number,
  slug: string,
  versionId: string,
): Promise<{ id: string; body: string; createdAt: Date } | null> {
  const found = await findLive(db, subjectId, slug);
  if (!found) return null;
  const [version] = await db
    .select({
      id: articleVersion.id,
      body: articleVersion.body,
      createdAt: articleVersion.createdAt,
    })
    .from(articleVersion)
    // Scoped to the article, so a version id from another subject's article is
    // a 404 here rather than a way to read across the library.
    .where(
      and(
        eq(articleVersion.id, versionId),
        eq(articleVersion.articleId, found.id),
      ),
    )
    .limit(1);
  return version ?? null;
}

/**
 * Save the draft, refusing one written against a version somebody has since
 * replaced (F12).
 *
 * Last write wins — saving again against the current `baseVersionId` goes
 * through — but not silently: the refusal names who moved it. `baseVersionId`
 * is `null` for an article that has never had a draft.
 */
export async function saveDraft(
  db: Db,
  subjectId: number,
  slug: string,
  authorId: number,
  body: string,
  baseVersionId: string | null,
): Promise<{ id: string; body: string }> {
  const found = await findLive(db, subjectId, slug);
  if (!found) throw notFound();

  if (found.draftVersionId !== baseVersionId) {
    throw new ApiError(
      409,
      "stale_draft",
      `${await whoMovedIt(db, found.draftVersionId)} guardó una versión mientras editabas. Abrí el artículo de nuevo y volvé a guardar para pisar ese cambio.`,
    );
  }

  const [version] = await db
    .insert(articleVersion)
    .values({ articleId: found.id, body, authorId })
    .returning({ id: articleVersion.id, body: articleVersion.body });
  await db
    .update(article)
    .set({ draftVersionId: version!.id })
    .where(eq(article.id, found.id));
  return version!;
}

/**
 * Publish the draft: move `publishedVersionId` onto it (F8, F11).
 *
 * The draft pointer stays where it is. An article whose draft *is* its
 * published version has no unsaved work, which is what `hasUnpublishedDraft`
 * reports, and the version rows are the history either way.
 */
export async function publishArticle(
  db: Db,
  subjectId: number,
  slug: string,
): Promise<{ publishedVersionId: string }> {
  const found = await findLive(db, subjectId, slug);
  if (!found) throw notFound();
  if (!found.draftVersionId) {
    throw new ApiError(
      409,
      "nothing_to_publish",
      "Este artículo todavía no tiene borrador para publicar.",
    );
  }
  await db
    .update(article)
    .set({ publishedVersionId: found.draftVersionId })
    .where(eq(article.id, found.id));
  return { publishedVersionId: found.draftVersionId };
}

/**
 * Retire an article (F36). The versions stay, and so does the slug — see
 * `createArticle`, which is how it comes back.
 *
 * Offerings using it keep their `offering_article` rows; the public reads join
 * through `article` and filter `archivedAt`, so it stops being served without
 * a teacher losing where they had filed it.
 */
export async function archiveArticle(
  db: Db,
  subjectId: number,
  slug: string,
): Promise<void> {
  const archived = await db
    .update(article)
    .set({ archivedAt: sql`now()` })
    .where(
      and(
        eq(article.subjectId, subjectId),
        eq(article.slug, slug),
        isNull(article.archivedAt),
      ),
    )
    .returning({ id: article.id });
  if (archived.length === 0) throw notFound();
}

/** A slug lands in a public URL, so it is checked rather than repaired. */
export function checkSlug(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 80) {
    throw new ApiError(
      400,
      "invalid_slug",
      "La dirección del artículo no puede estar vacía ni pasar de 80 caracteres.",
    );
  }
  const normalized = slugify(raw);
  // Rejected, never silently normalized: two titles that normalize the same
  // would collide into a 409 nobody could explain from what they typed.
  if (normalized !== raw) {
    throw new ApiError(
      400,
      "invalid_slug",
      `La dirección solo puede tener minúsculas, números y guiones. Probá con "${normalized}".`,
    );
  }
  return raw;
}

const SUMMARY = {
  id: article.id,
  slug: article.slug,
  title: article.title,
  publishedVersionId: article.publishedVersionId,
  draftVersionId: article.draftVersionId,
  createdAt: article.createdAt,
};

type SummaryRow = {
  [K in keyof typeof SUMMARY]: K extends "createdAt"
    ? Date
    : K extends "id" | "slug" | "title"
      ? string
      : string | null;
};

function summarize(row: SummaryRow): ArticleSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    published: row.publishedVersionId !== null,
    hasUnpublishedDraft:
      row.draftVersionId !== null &&
      row.draftVersionId !== row.publishedVersionId,
    createdAt: row.createdAt,
  };
}

async function findLive(db: Db, subjectId: number, slug: string) {
  const [row] = await db
    .select(SUMMARY)
    .from(article)
    .where(
      and(
        eq(article.subjectId, subjectId),
        eq(article.slug, slug),
        isNull(article.archivedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function whoMovedIt(db: Db, versionId: string | null): Promise<string> {
  if (!versionId) return "Alguien";
  const [author] = await db
    .select({
      name: sql<
        string | null
      >`${directoryUser.name} || ' ' || ${directoryUser.surname}`,
    })
    .from(articleVersion)
    .leftJoin(directoryUser, eq(directoryUser.id, articleVersion.authorId))
    .where(eq(articleVersion.id, versionId))
    .limit(1);
  return author?.name ?? "Alguien";
}

function notFound(): ApiError {
  return new ApiError(404, "not_found", "No encontramos ese artículo.");
}
