import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article, articleVersion } from "../db/schema/article.js";
import { directoryOffering } from "../db/schema/directory.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { programUnit } from "../db/schema/program-unit.js";
import { ApiError } from "../middleware/errors.js";
import { readProgram, type Unit } from "../library/program.js";
import { NONE, type Capabilities } from "./access.js";

/**
 * What is *in* an offering's home, and who may read it (F4, F8, F13).
 *
 * The body always comes from `article.published_version_id`, never from the
 * draft: one published version, shared by every offering using the article, is
 * what makes a fix reach all of them (F8). An offering decides *whether* and
 * *when* it shows that article, not *which* version of it.
 *
 * **Markdown goes out as it came in.** Nothing here parses it (F7, F44).
 */

/** One article as it appears on a home. `body` only on the article's own page. */
export interface HomeArticle {
  slug: string;
  title: string;
  unitId: string | null;
  position: number;
  publishedAt: Date | null;
  restricted: boolean;
  /** False when only staff can see it here — unpublished, or restricted. */
  public: boolean;
}

export interface HomeContent {
  program: Unit[];
  articles: HomeArticle[];
}

/**
 * The one rule, so the list and the article page can never disagree.
 *
 * Staff read their own offering before the class that needs it: a use with no
 * `publishedAt`, or one dated forward, is theirs to see and nobody else's. F4's
 * `restricted` is the other half — an exam statement or a solution, for the
 * enrolled and the staff.
 */
export function mayRead(
  use: { publishedAt: Date | null; restricted: boolean; published: boolean },
  can: Capabilities,
  now = new Date(),
): boolean {
  const staff = can.manageOffering || can.editLibrary;
  if (staff) return true;
  if (!use.published) return false;
  if (use.publishedAt === null || use.publishedAt > now) return false;
  return !use.restricted || can.seeOwnMarks;
}

/** The home's program and the articles this caller may see on it. */
export async function homeContent(
  db: Db,
  offeringId: number,
  subjectId: number,
  can: Capabilities,
): Promise<HomeContent> {
  const [program, uses] = await Promise.all([
    readProgram(db, subjectId),
    db
      .select(USE)
      .from(offeringArticle)
      .innerJoin(
        offeringHome,
        and(
          eq(offeringHome.id, offeringArticle.offeringHomeId),
          eq(offeringHome.offeringId, offeringId),
          isNull(offeringHome.archivedAt),
        ),
      )
      // An archived library article stops being served everywhere at once,
      // without any offering losing where it had filed it.
      .innerJoin(
        article,
        and(
          eq(article.id, offeringArticle.articleId),
          isNull(article.archivedAt),
        ),
      )
      .orderBy(offeringArticle.position),
  ]);

  const articles = uses
    .filter((use) => mayRead(use, can))
    .map((use): HomeArticle => ({
      slug: use.slug,
      title: use.title,
      unitId: use.programUnitId,
      position: use.position,
      publishedAt: use.publishedAt,
      restricted: use.restricted,
      public: mayRead(use, NONE),
    }));
  return { program, articles };
}

export interface ReadableArticle extends HomeArticle {
  body: string;
}

/** One article of one offering, by its URL's last segment (F32). */
export async function readableArticle(
  db: Db,
  offeringId: number,
  slug: string,
  can: Capabilities,
): Promise<ReadableArticle | null> {
  const [use] = await db
    .select({ ...USE, body: articleVersion.body })
    .from(offeringArticle)
    .innerJoin(
      offeringHome,
      and(
        eq(offeringHome.id, offeringArticle.offeringHomeId),
        eq(offeringHome.offeringId, offeringId),
        isNull(offeringHome.archivedAt),
      ),
    )
    .innerJoin(
      article,
      and(
        eq(article.id, offeringArticle.articleId),
        eq(article.slug, slug),
        isNull(article.archivedAt),
      ),
    )
    // The published version, not the draft (F8). Staff previewing their own
    // unpublished work still read what everyone else will read.
    .leftJoin(articleVersion, eq(articleVersion.id, article.publishedVersionId))
    .limit(1);

  // A use this caller may not read is *absent*, not forbidden: a 403 would
  // confirm the article exists, which for a solution is most of the answer.
  if (!use || use.body === null || !mayRead(use, can)) return null;

  return {
    slug: use.slug,
    title: use.title,
    unitId: use.programUnitId,
    position: use.position,
    publishedAt: use.publishedAt,
    restricted: use.restricted,
    public: mayRead(use, NONE),
    body: use.body,
  };
}

export interface UseInput {
  programUnitId: string | null;
  position: number;
  publishedAt: Date | null;
  restricted: boolean;
}

/**
 * The offering starts using a library article, or changes how (F8).
 *
 * Idempotent on `(home, article)`, like activation: a teacher who saves the
 * same panel twice has not made a mistake. The article must belong to the
 * offering's own subject — the library is the subject's, and using another
 * subject's article would be a second way to share content that F8's library
 * already covers.
 */
export async function useArticle(
  db: Db,
  homeId: string,
  subjectId: number,
  articleId: string,
  input: UseInput,
): Promise<void> {
  const [found] = await db
    .select({ one: article.id })
    .from(article)
    .where(
      and(
        eq(article.id, articleId),
        eq(article.subjectId, subjectId),
        isNull(article.archivedAt),
      ),
    )
    .limit(1);
  if (!found) {
    throw new ApiError(
      404,
      "not_found",
      "Ese artículo no está en la biblioteca de esta materia.",
    );
  }

  if (input.programUnitId !== null) {
    const [unit] = await db
      .select({ one: programUnit.id })
      .from(programUnit)
      .where(
        and(
          eq(programUnit.id, input.programUnitId),
          eq(programUnit.subjectId, subjectId),
        ),
      )
      .limit(1);
    if (!unit) {
      throw new ApiError(
        404,
        "not_found",
        "Esa unidad no es del programa de esta materia.",
      );
    }
  }

  await db
    .insert(offeringArticle)
    .values({ offeringHomeId: homeId, articleId, ...input })
    .onConflictDoUpdate({
      target: [offeringArticle.offeringHomeId, offeringArticle.articleId],
      set: input,
    });
}

/** `false` when it was not in use — the caller's own action was a no-op. */
export async function removeUse(
  db: Db,
  homeId: string,
  articleId: string,
): Promise<boolean> {
  const removed = await db
    .delete(offeringArticle)
    .where(
      and(
        eq(offeringArticle.offeringHomeId, homeId),
        eq(offeringArticle.articleId, articleId),
      ),
    )
    .returning({ id: offeringArticle.id });
  return removed.length > 0;
}

/** The offering's home row and subject, or nothing if it has no presence. */
export async function activeHome(
  db: Db,
  offeringId: number,
): Promise<{ homeId: string; subjectId: number } | null> {
  const [home] = await db
    .select({ homeId: offeringHome.id, subjectId: directoryOffering.subjectId })
    .from(offeringHome)
    .innerJoin(
      directoryOffering,
      eq(directoryOffering.id, offeringHome.offeringId),
    )
    .where(
      and(
        eq(offeringHome.offeringId, offeringId),
        isNull(offeringHome.archivedAt),
      ),
    )
    .limit(1);
  return home ?? null;
}

const USE = {
  slug: article.slug,
  title: article.title,
  programUnitId: offeringArticle.programUnitId,
  position: offeringArticle.position,
  publishedAt: offeringArticle.publishedAt,
  restricted: offeringArticle.restricted,
  published: sql<boolean>`${article.publishedVersionId} is not null`,
};
