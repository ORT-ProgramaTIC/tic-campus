import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { programUnit } from "../db/schema/program-unit.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The subject's program: ordered units, each a title and Markdown (F15).
 *
 * **It lives in the library, not on the offering.** Every offering of the
 * subject shows these units, in this order, and the same units group the
 * offering's articles (F13) — so a unit is typed once and a fix to it reaches
 * every year at once.
 *
 * F15 also lets an offering reorder or hide units *for itself*. That is not
 * here: it is a home-configuration control, `offerings/home.ts`, applied on top
 * of this read by `homeContent` — so the library screen keeps the library's
 * order.
 */

export interface Unit {
  id: string;
  title: string;
  contents: string;
  position: number;
}

export async function readProgram(db: Db, subjectId: number): Promise<Unit[]> {
  return db
    .select({
      id: programUnit.id,
      title: programUnit.title,
      contents: programUnit.contents,
      position: programUnit.position,
    })
    .from(programUnit)
    .where(eq(programUnit.subjectId, subjectId))
    .orderBy(programUnit.position);
}

export interface UnitInput {
  /** Absent for a new unit. */
  id?: string;
  title: string;
  contents: string;
}

/**
 * Write the whole list in one call: array order is `position`, a unit with an
 * `id` is updated, one without is created.
 *
 * **It never deletes.** A teacher who loaded the program, and saves it after a
 * colleague added a unit, would otherwise wipe that unit — and with it, by
 * foreign key, every article filed under it. Unlike an article, a unit has no
 * version history to recover from, so the lost update would be silent and
 * final. Removing one is `deleteUnit`, which says no when it is in use.
 */
export async function writeProgram(
  db: Db,
  subjectId: number,
  units: UnitInput[],
): Promise<Unit[]> {
  const given = units.flatMap((unit) => (unit.id ? [unit.id] : []));
  if (given.length > 0) {
    // Ids are client-supplied: one belonging to another subject's program would
    // otherwise be reparented by the update below.
    const mine = await db
      .select({ id: programUnit.id })
      .from(programUnit)
      .where(
        and(
          eq(programUnit.subjectId, subjectId),
          inArray(programUnit.id, given),
        ),
      );
    if (mine.length !== new Set(given).size) {
      throw new ApiError(
        400,
        "unknown_unit",
        "Alguna de las unidades no es de esta materia. Recargá el programa.",
      );
    }
  }

  await Promise.all(
    units.map((unit, position) =>
      unit.id
        ? db
            .update(programUnit)
            .set({ title: unit.title, contents: unit.contents, position })
            .where(eq(programUnit.id, unit.id))
        : db.insert(programUnit).values({
            subjectId,
            title: unit.title,
            contents: unit.contents,
            position,
          }),
    ),
  );
  return readProgram(db, subjectId);
}

/**
 * Remove a unit, refusing while an offering still files articles under it.
 *
 * The check is what keeps a foreign-key violation from surfacing as a 500 on
 * something a teacher can actually fix — the same shape `admin-offerings.ts`
 * uses before activating.
 */
export async function deleteUnit(
  db: Db,
  subjectId: number,
  unitId: string,
): Promise<void> {
  const inUse = await db
    .select({ one: offeringArticle.id })
    .from(offeringArticle)
    .where(eq(offeringArticle.programUnitId, unitId))
    .limit(1);
  if (inUse.length > 0) {
    throw new ApiError(
      409,
      "unit_in_use",
      "Esa unidad tiene artículos de alguna materia adentro. Movelos a otra unidad antes de borrarla.",
    );
  }

  const removed = await db
    .delete(programUnit)
    .where(
      and(eq(programUnit.id, unitId), eq(programUnit.subjectId, subjectId)),
    )
    .returning({ id: programUnit.id });
  if (removed.length === 0) {
    throw new ApiError(404, "not_found", "No encontramos esa unidad.");
  }
}

/** Bodies are client-supplied; this is the whole of what is accepted. */
export function checkUnits(raw: unknown): UnitInput[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      400,
      "invalid_body",
      "Esperábamos una lista de unidades.",
    );
  }
  if (raw.length > 200) {
    throw new ApiError(400, "invalid_body", "Son demasiadas unidades.");
  }
  return raw.map((unit: unknown) => {
    if (typeof unit !== "object" || unit === null) {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada unidad tiene que ser un objeto.",
      );
    }
    const { id, title, contents } = unit as Record<string, unknown>;
    if (id !== undefined && !isUuid(id)) {
      throw new ApiError(
        400,
        "invalid_body",
        "El id de una unidad no es válido.",
      );
    }
    if (typeof title !== "string" || title.trim() === "") {
      throw new ApiError(
        400,
        "invalid_body",
        "Cada unidad necesita un título.",
      );
    }
    if (typeof contents !== "string") {
      throw new ApiError(
        400,
        "invalid_body",
        "El contenido de una unidad es texto.",
      );
    }
    return { ...(id === undefined ? {} : { id }), title, contents };
  });
}

export function isUuid(raw: unknown): raw is string {
  return (
    typeof raw === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)
  );
}
