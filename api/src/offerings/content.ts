import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article, articleVersion } from "../db/schema/article.js";
import {
  offeringGroup,
  offeringScale,
  offeringTerm,
} from "../db/schema/gradebook.js";
import { directoryOffering } from "../db/schema/directory.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { programUnit } from "../db/schema/program-unit.js";
import { result } from "../db/schema/result.js";
import { ApiError } from "../middleware/errors.js";
import { readProgram, type Unit } from "../library/program.js";
import {
  capabilitiesFor,
  NONE,
  type Actor,
  type Capabilities,
} from "./access.js";
import type { ValueType } from "./results.js";

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
  /** F18's grading metadata. All null together is a theory note; `valueType`
   *  not null is what makes this use an activity. */
  offeringGroupId: string | null;
  offeringTermId: string | null;
  valueType: ValueType | null;
  offeringScaleId: string | null;
  dueAt: Date | null;
  /** F24, and deliberately not `publishedAt` — see the note on the column. */
  resultsPublishedAt: Date | null;
}

/**
 * The offering starts using a library article, or changes how (F8, F18).
 *
 * Idempotent on `(home, article)`, like activation: a teacher who saves the
 * same panel twice has not made a mistake. The article must belong to the
 * offering's own subject — the library is the subject's, and using another
 * subject's article would be a second way to share content that F8's library
 * already covers.
 *
 * **It writes the whole row**, which is why the checks below are not optional
 * politeness. A client sending half a panel saves half a panel; `position` has
 * reset to 0 that way since slice 5, and that is recoverable by saving again.
 * Un-grading an activity that already has marks is not: the `result` rows would
 * outlive the thing they are results *of*, with no version history to restore
 * from (unlike F11). So that one case is refused, and the rest of the row keeps
 * behaving the way the rest of the row always has.
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

  await checkGrading(db, homeId, input);

  const [existing] = await db
    .select({ id: offeringArticle.id, valueType: offeringArticle.valueType })
    .from(offeringArticle)
    .where(
      and(
        eq(offeringArticle.offeringHomeId, homeId),
        eq(offeringArticle.articleId, articleId),
      ),
    )
    .limit(1);

  // Only when the type is going away or changing. Publishing marks, renaming a
  // group, moving a due date — all of those leave `valueType` alone and none of
  // them needs a teacher to delete anything first.
  if (
    existing &&
    existing.valueType !== null &&
    existing.valueType !== input.valueType
  ) {
    const [marked] = await db
      .select({ one: result.id })
      .from(result)
      .where(eq(result.offeringArticleId, existing.id))
      .limit(1);
    if (marked) {
      throw new ApiError(
        409,
        "results_exist",
        "Esa actividad ya tiene notas cargadas. Borralas antes de cambiarle el tipo de nota.",
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

/**
 * F18's metadata, checked against this offering's own rows (F39).
 *
 * **An activity is a `valueType`, a term and — for a scale — a scale**, and a
 * theory note is none of them. The invariant is here rather than in a `CHECK`
 * constraint for the reason the column's own note gives, and it is here rather
 * than in the route because it is a rule about the offering's rows and not
 * about the shape of a body.
 *
 * A group is optional on purpose: an activity in no bucket is one F20's formula
 * ignores, which is a thing a teacher may well mean.
 */
async function checkGrading(
  db: Db,
  homeId: string,
  input: UseInput,
): Promise<void> {
  if (input.valueType === null) {
    if (input.offeringTermId !== null || input.offeringScaleId !== null) {
      throw new ApiError(
        400,
        "invalid_body",
        "Sin tipo de nota no es una actividad, así que no lleva trimestre ni escala.",
      );
    }
    if (input.offeringGroupId !== null || input.resultsPublishedAt !== null) {
      throw new ApiError(
        400,
        "invalid_body",
        "Sin tipo de nota no es una actividad, así que no lleva grupo ni notas publicadas.",
      );
    }
    return;
  }
  if (input.offeringTermId === null) {
    throw new ApiError(
      400,
      "invalid_body",
      "Toda actividad va en un trimestre.",
    );
  }
  if ((input.valueType === "scale") !== (input.offeringScaleId !== null)) {
    throw new ApiError(
      400,
      "invalid_body",
      "Una actividad con escala lleva una escala, y las otras no.",
    );
  }

  await belongsHere(
    db,
    offeringTerm,
    homeId,
    input.offeringTermId,
    "trimestre",
  );
  await belongsHere(db, offeringGroup, homeId, input.offeringGroupId, "grupo");
  await belongsHere(db, offeringScale, homeId, input.offeringScaleId, "escala");
}

/** The same shape the `programUnitId` check above uses, three more times: an id
 *  from another offering would otherwise file this activity under somebody
 *  else's group. */
async function belongsHere(
  db: Db,
  table: typeof offeringGroup | typeof offeringTerm | typeof offeringScale,
  homeId: string,
  id: string | null,
  noun: string,
): Promise<void> {
  if (id === null) return;
  const [found] = await db
    .select({ one: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.offeringHomeId, homeId)))
    .limit(1);
  if (!found) {
    throw new ApiError(404, "not_found", `Ese ${noun} no es de esta materia.`);
  }
}

/**
 * `false` when it was not in use — the caller's own action was a no-op.
 *
 * **It refuses while the activity has marks.** This is a real `DELETE`, and
 * since slice 7 `result` points at the row: without the check the foreign key
 * turns a teacher's "quitar de la materia" into a 500 on something they can
 * actually fix. `deleteUnit`'s `unit_in_use` is the same shape, and the same
 * reasoning is why F36 made deactivating an offering an archive.
 */
export async function removeUse(
  db: Db,
  homeId: string,
  articleId: string,
): Promise<boolean> {
  const marked = await db
    .select({ one: result.id })
    .from(result)
    .innerJoin(
      offeringArticle,
      and(
        eq(offeringArticle.id, result.offeringArticleId),
        eq(offeringArticle.offeringHomeId, homeId),
        eq(offeringArticle.articleId, articleId),
      ),
    )
    .limit(1);
  if (marked.length > 0) {
    throw new ApiError(
      409,
      "activity_has_results",
      "Esa actividad tiene notas cargadas. Borralas antes de sacarla de la materia.",
    );
  }

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

/**
 * The home a caller may *manage*, or the refusal (F5, F34) — one query for the
 * 404 and one for the 403, shared by every staff route hung under
 * `/api/homes`.
 *
 * It lives here, beside `activeHome`, and not in `access.ts`: this module
 * already imports that one, so the edge stays one way. The inverse placement
 * would need `activeHome` and close the loop.
 *
 * It takes an `Actor` rather than a request, so the domain stays route-free and
 * each router keeps its own three-line `mustManage` — which is the house shape
 * (`library.ts`'s `mustEdit`) and also the only part that touches `req`.
 */
export async function manageableHome(
  db: Db,
  offeringId: number,
  actor: Actor,
): Promise<{ homeId: string; subjectId: number }> {
  const home = await activeHome(db, offeringId);
  // F34: an offering campus has not activated has no presence at all, so this
  // is a 404 and not an empty 200. Checking before mutating is also what keeps
  // a foreign-key violation from surfacing as a 500.
  if (!home) {
    throw new ApiError(404, "not_found", "Esa materia no está activada.");
  }
  const can = await capabilitiesFor(db, actor, offeringId, home.subjectId);
  if (!can.manageOffering) {
    throw new ApiError(403, "forbidden", "Esto lo hace quien da esta materia.");
  }
  return home;
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
