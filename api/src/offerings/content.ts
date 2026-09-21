import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { YearLock } from "../config.js";
import type { Db } from "../db/client.js";
import { article, articleVersion } from "../db/schema/article.js";
import {
  offeringGroup,
  offeringScale,
  offeringTerm,
} from "../db/schema/gradebook.js";
import { directoryOffering } from "../db/schema/directory.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome, type HomeLink } from "../db/schema/offering-home.js";
import { programUnit } from "../db/schema/program-unit.js";
import { redoCovers } from "../db/schema/redo-covers.js";
import { result } from "../db/schema/result.js";
import { ApiError } from "../middleware/errors.js";
import { readProgram } from "../library/program.js";
import {
  capabilitiesFor,
  NONE,
  type Actor,
  type Capabilities,
} from "./access.js";
import {
  arrangeUnits,
  DEFAULT_SECTIONS,
  type HomeUnit,
  type Section,
} from "./home.js";
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

/**
 * Everything a home shows, in one read (F14), so the GUI never makes a second
 * round trip that disagrees with the first. Anonymous callers get the same
 * shape. An article whose `unitId` is not in `program` — filed under a unit
 * this offering hides — renders ungrouped, the same as a `null` one.
 */
export interface HomeContent {
  sections: Section[];
  links: HomeLink[];
  program: HomeUnit[];
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
  const [program, [home], uses] = await Promise.all([
    readProgram(db, subjectId),
    db
      .select({
        sections: offeringHome.sections,
        links: offeringHome.links,
        unitOrder: offeringHome.unitOrder,
        hiddenUnits: offeringHome.hiddenUnits,
      })
      .from(offeringHome)
      .where(
        and(
          eq(offeringHome.offeringId, offeringId),
          isNull(offeringHome.archivedAt),
        ),
      )
      .limit(1),
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
  return {
    sections: (home?.sections as Section[] | null) ?? [...DEFAULT_SECTIONS],
    links: home?.links ?? [],
    program: arrangeUnits(
      program,
      home?.unitOrder ?? [],
      home?.hiddenUnits ?? [],
      can.manageOffering || can.editLibrary,
    ),
    articles,
  };
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
  /**
   * F23: the activities this one **replaces**, by `offering_article.id`. Empty
   * is the normal case and is what makes a use not a redo.
   *
   * It rides the use rather than a route of its own because it is the same kind
   * of fact as the group and the term: one offering's decision about one
   * article, saved by the panel that already saves the rest. Which also means
   * it obeys this row's whole-row rule — a client that saves the panel without
   * `covers` clears the coverage, recoverable by saving it again, the way
   * `position` has been since slice 5.
   */
  covers: string[];
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

  await checkCovers(db, homeId, input, existing?.id);

  const { covers, ...row } = input;
  // One transaction, because the coverage is part of the row from the outside:
  // a save that wrote the activity and then failed to write what it replaces
  // would leave a redo that silently stopped replacing anything, and the marks
  // it fixes would go back down without anybody touching them.
  await db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(offeringArticle)
      .values({ offeringHomeId: homeId, articleId, ...row })
      .onConflictDoUpdate({
        target: [offeringArticle.offeringHomeId, offeringArticle.articleId],
        set: row,
      })
      .returning({ id: offeringArticle.id });
    // Whole-row, like everything else here: what the body sent is what this use
    // covers afterwards, and an empty list is a use that is no longer a redo.
    await tx.delete(redoCovers).where(eq(redoCovers.redoId, saved!.id));
    const wanted = [...new Set(covers)];
    if (wanted.length > 0) {
      await tx.insert(redoCovers).values(
        wanted.map((coveredId) => ({
          redoId: saved!.id,
          coveredId,
        })),
      );
    }
  });
}

/**
 * What a redo may cover (F23). The ids come from the body, so all four of these
 * are trust boundaries rather than tidiness:
 *
 * - **an activity of *this* home**, or a teacher of any offering makes their
 *   redo replace another offering's marks — the hole `saveResults` closes for
 *   the ids it is handed.
 * - **not itself**, which would be a mark replacing itself forever.
 * - **not another redo**, which is what keeps resolution a single pass with no
 *   cycle to detect (see the note on the table).
 * - **the same kind of mark**, same `valueType` and same scale. A `numeric`
 *   redo covering a `done` activity would land a 1 on it and read as *done* —
 *   a failed recuperatorio marking the TP as handed in.
 */
async function checkCovers(
  db: Db,
  homeId: string,
  input: UseInput,
  selfId: string | undefined,
): Promise<void> {
  const wanted = [...new Set(input.covers)];
  if (wanted.length === 0) return;
  if (selfId !== undefined && wanted.includes(selfId)) {
    throw new ApiError(
      400,
      "invalid_body",
      "Una actividad no puede ser el recuperatorio de sí misma.",
    );
  }

  const covered = await db
    .select({
      id: offeringArticle.id,
      valueType: offeringArticle.valueType,
      scaleId: offeringArticle.offeringScaleId,
    })
    .from(offeringArticle)
    .where(
      and(
        eq(offeringArticle.offeringHomeId, homeId),
        isNotNull(offeringArticle.valueType),
        inArray(offeringArticle.id, wanted),
      ),
    );
  if (covered.length !== wanted.length) {
    throw new ApiError(
      404,
      "not_found",
      "Alguna de las actividades que recupera no es de esta materia.",
    );
  }
  for (const one of covered) {
    if (
      one.valueType !== input.valueType ||
      one.scaleId !== input.offeringScaleId
    ) {
      throw new ApiError(
        400,
        "invalid_body",
        "Un recuperatorio lleva el mismo tipo de nota que lo que recupera.",
      );
    }
  }

  const [chained] = await db
    .select({ one: redoCovers.id })
    .from(redoCovers)
    .where(inArray(redoCovers.redoId, wanted))
    .limit(1);
  if (chained) {
    throw new ApiError(
      400,
      "invalid_body",
      "No se recupera un recuperatorio: poné las actividades originales en la lista.",
    );
  }
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
    if (input.covers.length > 0) {
      throw new ApiError(
        400,
        "invalid_body",
        "Sin tipo de nota no es una actividad, así que no recupera nada.",
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

  // **Both sides** (F23): the use may be a redo, and it may be something another
  // redo covers. Either row left behind is a foreign key that turns a teacher's
  // "quitar de la materia" into a 500. Dropped rather than refused — a use that
  // is gone covers nothing and is covered by nothing, and the marks it was
  // fixing are the ones the refusal above already protects.
  const mine = db
    .select({ id: offeringArticle.id })
    .from(offeringArticle)
    .where(
      and(
        eq(offeringArticle.offeringHomeId, homeId),
        eq(offeringArticle.articleId, articleId),
      ),
    );
  await db
    .delete(redoCovers)
    .where(
      or(inArray(redoCovers.redoId, mine), inArray(redoCovers.coveredId, mine)),
    );

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

/** An activated home, with what F35's lock is decided from. */
export interface ActiveHome {
  homeId: string;
  subjectId: number;
  /** The offering's school year, from the directory. */
  year: number;
  /** An admin reopened this offering past its year's lock (F35). */
  unlockedAt: Date | null;
}

/** The offering's home row and subject, or nothing if it has no presence. */
export async function activeHome(
  db: Db,
  offeringId: number,
): Promise<ActiveHome | null> {
  const [home] = await db
    .select({
      homeId: offeringHome.id,
      subjectId: directoryOffering.subjectId,
      year: directoryOffering.year,
      unlockedAt: offeringHome.unlockedAt,
    })
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
): Promise<ActiveHome> {
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

/**
 * Whether a year's marks are closed (F35): from 00:00 in Buenos Aires on the
 * day after `yearLock` of the offering's year, unless an admin reopened this
 * one offering.
 *
 * **From a date, not from `is_current`.** Which year is current is the
 * directory's word and flips when the office rolls the year — which may be
 * March, and a lock that waits for it leaves last year writable all summer.
 * The date is F42's constant and is the same for every offering of a year.
 */
export function isLocked(
  home: Pick<ActiveHome, "year" | "unlockedAt">,
  yearLock: YearLock,
  now: Date = new Date(),
): boolean {
  if (home.unlockedAt) return false;
  // ponytail: fixed UTC−3 — Argentina has had no DST since 2009. A zone
  // database is the upgrade if that ever changes.
  const closes = Date.UTC(home.year, yearLock.month - 1, yearLock.day + 1, 3);
  return now.getTime() >= closes;
}

/**
 * The lock as a refusal, for the writes that change a mark: results, official
 * grades, the gradebook's setup and both halves of a revision. **Marks only**
 * — the home, its articles and the library stay editable, and every read
 * stays open. A `409` and not a `403`: nobody lacks a permission, the year is
 * over, and an admin's unlock is the way through.
 */
export function assertUnlocked(
  home: Pick<ActiveHome, "year" | "unlockedAt">,
  yearLock: YearLock,
): void {
  if (isLocked(home, yearLock)) {
    throw new ApiError(
      409,
      "locked",
      "Este año ya cerró. Para corregir una nota, pedíselo a un admin.",
    );
  }
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
