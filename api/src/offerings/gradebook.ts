import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  offeringGroup,
  offeringScale,
  offeringScaleLevel,
  offeringTerm,
} from "../db/schema/gradebook.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { result } from "../db/schema/result.js";
import { ApiError } from "../middleware/errors.js";
import { isUuid } from "../library/program.js";

/**
 * What an offering names before it can mark anything (F39): its groups, its
 * terms and its scales.
 *
 * **One screen, one save.** `library/program.ts` is the template and the rules
 * are its rules — array order is `position`, a row with an `id` is updated and
 * one without is created, and **the save never deletes**. A teacher who loaded
 * the panel and saves it after a colleague added a term would otherwise wipe
 * it, and by foreign key every activity filed under it, with nothing to recover
 * from. Removing one is its own `delete*`, which says no while it is in use.
 *
 * Two things `writeProgram` does not have to do:
 *
 * - **the whole save is one transaction, and the updates run in order.**
 *   `offering_group.name` is unique per offering, so swapping two names is two
 *   UPDATEs and whichever lands first raises `23505`. `Promise.all` would make
 *   which one nondeterministic on top. The `409` below tells the teacher to
 *   save it in two steps, which is the honest answer — a rename through a
 *   temporary name would be campus inventing a name nobody typed.
 * - **a level whose number changed rewrites the results recorded against it.**
 *   A result stores the number, not the level, because that is what keeps F20's
 *   evaluator from branching per type (F38) — so moving `MB` from 8 to 9 has to
 *   move the marks with it, or it changes the display and not the mark.
 */

/* ── The presets (F19, F42) ──────────────────────────────────────────────── */

export interface PresetLevel {
  name: string;
  value: number;
}

export interface ScalePreset {
  name: string;
  levels: PresetLevel[];
}

/**
 * The school's usual scales, **in code and not in a settings table** (F42): a
 * table for two constants would be a screen, a migration and a cache for
 * something that changes once a decade.
 *
 * They are served alongside the gradebook read so a client can offer "seed from
 * this" and POST the result. Nothing here writes rows on a teacher's behalf —
 * what lands in `offering_scale` is the copy that offering owns and may rename,
 * and editing a preset later therefore reaches nobody. That is the point: a
 * mark already given does not move because head office changed a word.
 *
 * **The numbers are the school's decision, not this file's.** They are written
 * down here so they are read rather than re-argued: `B`/`MB`/`E` spans the
 * passing half of 1–10, and a two-step scale is the pass mark against 1.
 */
export const SCALE_PRESETS: ScalePreset[] = [
  {
    name: "B / MB / E",
    levels: [
      { name: "B", value: 7 },
      { name: "MB", value: 8.5 },
      { name: "E", value: 10 },
    ],
  },
  {
    name: "Aprobado / Desaprobado",
    levels: [
      { name: "Desaprobado", value: 1 },
      { name: "Aprobado", value: 7 },
    ],
  },
];

/* ── Reading ─────────────────────────────────────────────────────────────── */

export interface Named {
  id: string;
  name: string;
  position: number;
}

export interface Level extends Named {
  value: number;
}

export interface Scale extends Named {
  levels: Level[];
}

export interface Setup {
  groups: Named[];
  terms: Named[];
  scales: Scale[];
}

/** Three reads and a regroup. The levels come back in one query and are nested
 *  in memory rather than fetched per scale — a handful of rows either way, and
 *  a loop over scales would be a query per scale for nothing. */
export async function readSetup(db: Db, homeId: string): Promise<Setup> {
  const [groups, terms, scales, levels] = await Promise.all([
    db
      .select(NAMED(offeringGroup))
      .from(offeringGroup)
      .where(eq(offeringGroup.offeringHomeId, homeId))
      .orderBy(offeringGroup.position),
    db
      .select(NAMED(offeringTerm))
      .from(offeringTerm)
      .where(eq(offeringTerm.offeringHomeId, homeId))
      .orderBy(offeringTerm.position),
    db
      .select(NAMED(offeringScale))
      .from(offeringScale)
      .where(eq(offeringScale.offeringHomeId, homeId))
      .orderBy(offeringScale.position),
    db
      .select({
        id: offeringScaleLevel.id,
        name: offeringScaleLevel.name,
        position: offeringScaleLevel.position,
        value: offeringScaleLevel.value,
        scaleId: offeringScaleLevel.offeringScaleId,
      })
      .from(offeringScaleLevel)
      .innerJoin(
        offeringScale,
        and(
          eq(offeringScale.id, offeringScaleLevel.offeringScaleId),
          eq(offeringScale.offeringHomeId, homeId),
        ),
      )
      .orderBy(offeringScaleLevel.position),
  ]);

  return {
    groups,
    terms,
    scales: scales.map((scale) => ({
      ...scale,
      levels: levels
        .filter((level) => level.scaleId === scale.id)
        .map(({ scaleId: _scaleId, ...level }) => level),
    })),
  };
}

/** The three `Named` tables project identically; this is the projection, not an
 *  abstraction over them. */
function NAMED(
  table: typeof offeringGroup | typeof offeringTerm | typeof offeringScale,
) {
  return { id: table.id, name: table.name, position: table.position };
}

/* ── Writing ─────────────────────────────────────────────────────────────── */

export interface NamedInput {
  /** Absent for a new row. */
  id?: string;
  name: string;
}

export interface LevelInput extends NamedInput {
  value: number;
}

export interface ScaleInput extends NamedInput {
  levels: LevelInput[];
}

export interface SetupInput {
  groups: NamedInput[];
  terms: NamedInput[];
  scales: ScaleInput[];
}

export async function writeSetup(
  db: Db,
  homeId: string,
  input: SetupInput,
): Promise<Setup> {
  await mine(db, offeringGroup, homeId, input.groups, "unknown_group", "grupo");
  await mine(
    db,
    offeringTerm,
    homeId,
    input.terms,
    "unknown_term",
    "trimestre",
  );
  await mine(
    db,
    offeringScale,
    homeId,
    input.scales,
    "unknown_scale",
    "escala",
  );

  try {
    await db.transaction(async (tx) => {
      for (const [position, group] of input.groups.entries()) {
        await upsertNamed(tx, offeringGroup, homeId, group, position);
      }
      for (const [position, term] of input.terms.entries()) {
        await upsertNamed(tx, offeringTerm, homeId, term, position);
      }
      for (const [position, scale] of input.scales.entries()) {
        const scaleId = await upsertNamed(
          tx,
          offeringScale,
          homeId,
          scale,
          position,
        );
        await writeLevels(tx, scaleId, scale.levels);
      }
    });
  } catch (cause) {
    // 23505 is a unique violation, and the only unique index a save can reach
    // is `(offering_home_id, name)`. Caught here rather than in the error
    // middleware because this is the only place that knows the name collided
    // with a sibling rather than with anything else.
    if (isUniqueViolation(cause)) {
      throw new ApiError(
        409,
        "duplicate_name",
        "Ya hay algo con ese nombre en esta materia. Si estás intercambiando dos nombres, guardalo en dos pasos.",
      );
    }
    throw cause;
  }

  return readSetup(db, homeId);
}

/**
 * **Down the `cause` chain, not on the error itself.** drizzle-orm 0.45 wraps
 * whatever the driver threw in a `DrizzleQueryError` carrying the SQL and the
 * params, so `err.code` is `undefined` and a check for `"23505"` on the thrown
 * object silently never matches — the symptom is a 500 with the query in it
 * where a `409` was meant to be, which is how this was found.
 */
function isUniqueViolation(cause: unknown): boolean {
  for (let at = cause; at instanceof Error; at = at.cause) {
    if ((at as { code?: string }).code === "23505") return true;
  }
  return false;
}

/**
 * Ids are client-supplied: one belonging to another offering would otherwise be
 * reparented by the update below, which is how a teacher renames somebody
 * else's group by pasting the wrong panel. `writeProgram` guards the same way.
 */
async function mine(
  db: Db,
  table: typeof offeringGroup | typeof offeringTerm | typeof offeringScale,
  homeId: string,
  rows: NamedInput[],
  code: string,
  noun: string,
): Promise<void> {
  const given = rows.flatMap((row) => (row.id ? [row.id] : []));
  if (given.length === 0) return;
  const found = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.offeringHomeId, homeId), inArray(table.id, given)));
  if (found.length !== new Set(given).size) {
    throw new ApiError(
      400,
      code,
      `Alguna ${noun} no es de esta materia. Recargá el boletín.`,
    );
  }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

async function upsertNamed(
  tx: Tx,
  table: typeof offeringGroup | typeof offeringTerm | typeof offeringScale,
  homeId: string,
  row: NamedInput,
  position: number,
): Promise<string> {
  if (row.id) {
    await tx
      .update(table)
      .set({ name: row.name, position })
      .where(eq(table.id, row.id));
    return row.id;
  }
  const [created] = await tx
    .insert(table)
    .values({ offeringHomeId: homeId, name: row.name, position })
    .returning({ id: table.id });
  return created!.id;
}

/**
 * A scale's levels, by the same rules — and **the number carries into the
 * results already recorded against the level**, because a result stores the
 * number rather than the level (F38). Only when it actually changed: the
 * `UPDATE` is free to skip, and a save that rewrote every result on every keypress
 * would be a lock on the gradebook for a no-op.
 */
async function writeLevels(
  tx: Tx,
  scaleId: string,
  levels: LevelInput[],
): Promise<void> {
  const existing = await tx
    .select({ id: offeringScaleLevel.id, value: offeringScaleLevel.value })
    .from(offeringScaleLevel)
    .where(eq(offeringScaleLevel.offeringScaleId, scaleId));

  for (const [position, level] of levels.entries()) {
    if (!level.id) {
      await tx.insert(offeringScaleLevel).values({
        offeringScaleId: scaleId,
        name: level.name,
        value: level.value,
        position,
      });
      continue;
    }
    const before = existing.find((row) => row.id === level.id);
    if (before === undefined) {
      throw new ApiError(
        400,
        "unknown_level",
        "Algún nivel no es de esa escala. Recargá el boletín.",
      );
    }
    await tx
      .update(offeringScaleLevel)
      .set({ name: level.name, value: level.value, position })
      .where(eq(offeringScaleLevel.id, level.id));
    if (before.value !== level.value) {
      await tx
        .update(result)
        .set({ value: level.value })
        .where(eq(result.scaleLevelId, level.id));
    }
  }
}

/* ── Deleting ────────────────────────────────────────────────────────────── */

/**
 * The three deletes, each refusing while something still points at it — the
 * check is what keeps a foreign-key violation from surfacing as a 500 on
 * something a teacher can actually fix (`deleteUnit` is the same shape).
 *
 * There is no fourth for a scale *level*: the save never deletes one, so a
 * level a result names cannot vanish, and a scale nothing uses can be deleted
 * whole and retyped. Once an activity uses the scale, a spare level stays in
 * the dropdown — see the note in `db/schema/gradebook.ts`.
 */
export async function deleteGroup(
  db: Db,
  homeId: string,
  groupId: string,
): Promise<void> {
  await refuseIfUsed(
    db,
    offeringArticle.offeringGroupId,
    groupId,
    "group_in_use",
    "Ese grupo tiene actividades adentro. Movelas a otro grupo antes de borrarlo.",
  );
  await removeNamed(db, offeringGroup, homeId, groupId, "grupo");
}

export async function deleteTerm(
  db: Db,
  homeId: string,
  termId: string,
): Promise<void> {
  await refuseIfUsed(
    db,
    offeringArticle.offeringTermId,
    termId,
    "term_in_use",
    "Ese trimestre tiene actividades adentro. Movelas a otro antes de borrarlo.",
  );
  await removeNamed(db, offeringTerm, homeId, termId, "trimestre");
}

export async function deleteScale(
  db: Db,
  homeId: string,
  scaleId: string,
): Promise<void> {
  await refuseIfUsed(
    db,
    offeringArticle.offeringScaleId,
    scaleId,
    "scale_in_use",
    "Esa escala se usa en alguna actividad. Cambiales la escala antes de borrarla.",
  );
  // Its levels go with it: nothing else can reference them, because a result
  // can only name a level of the scale its own activity carries.
  await db
    .delete(offeringScaleLevel)
    .where(eq(offeringScaleLevel.offeringScaleId, scaleId));
  await removeNamed(db, offeringScale, homeId, scaleId, "escala");
}

async function refuseIfUsed(
  db: Db,
  column:
    | typeof offeringArticle.offeringGroupId
    | typeof offeringArticle.offeringTermId
    | typeof offeringArticle.offeringScaleId,
  id: string,
  code: string,
  message: string,
): Promise<void> {
  const used = await db
    .select({ one: offeringArticle.id })
    .from(offeringArticle)
    .where(eq(column, id))
    .limit(1);
  if (used.length > 0) throw new ApiError(409, code, message);
}

async function removeNamed(
  db: Db,
  table: typeof offeringGroup | typeof offeringTerm | typeof offeringScale,
  homeId: string,
  id: string,
  noun: string,
): Promise<void> {
  const removed = await db
    .delete(table)
    .where(and(eq(table.id, id), eq(table.offeringHomeId, homeId)))
    .returning({ id: table.id });
  if (removed.length === 0) {
    throw new ApiError(404, "not_found", `No encontramos esa ${noun}.`);
  }
}

/* ── What is accepted ────────────────────────────────────────────────────── */

/** Bodies are client-supplied; this is the whole of what is accepted. */
export function checkSetup(raw: unknown): SetupInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { groups, terms, scales } = raw as Record<string, unknown>;
  return {
    groups: checkNamed(groups, "grupos"),
    terms: checkNamed(terms, "trimestres"),
    scales: checkScales(scales),
  };
}

function checkNamed(raw: unknown, plural: string): NamedInput[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      400,
      "invalid_body",
      `Esperábamos una lista de ${plural}.`,
    );
  }
  if (raw.length > 100) {
    throw new ApiError(400, "invalid_body", `Son demasiados ${plural}.`);
  }
  return raw.map((row) => checkOne(row));
}

function checkOne(raw: unknown): NamedInput {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(
      400,
      "invalid_body",
      "Cada fila tiene que ser un objeto.",
    );
  }
  const { id, name } = raw as Record<string, unknown>;
  if (id !== undefined && !isUuid(id)) {
    throw new ApiError(400, "invalid_body", "Algún id no es válido.");
  }
  if (typeof name !== "string" || name.trim() === "" || name.length > 80) {
    throw new ApiError(
      400,
      "invalid_body",
      "Cada fila necesita un nombre de hasta 80 caracteres.",
    );
  }
  return { ...(id === undefined ? {} : { id }), name: name.trim() };
}

function checkScales(raw: unknown): ScaleInput[] {
  if (!Array.isArray(raw)) {
    throw new ApiError(
      400,
      "invalid_body",
      "Esperábamos una lista de escalas.",
    );
  }
  if (raw.length > 100) {
    throw new ApiError(400, "invalid_body", "Son demasiadas escalas.");
  }
  return raw.map((raw_scale) => {
    const named = checkOne(raw_scale);
    const { levels } = raw_scale as Record<string, unknown>;
    if (!Array.isArray(levels) || levels.length === 0) {
      throw new ApiError(
        400,
        "invalid_body",
        "Una escala necesita al menos un nivel.",
      );
    }
    if (levels.length > 20) {
      throw new ApiError(400, "invalid_body", "Son demasiados niveles.");
    }
    return {
      ...named,
      levels: levels.map((raw_level) => ({
        ...checkOne(raw_level),
        value: checkMark((raw_level as Record<string, unknown>).value),
      })),
    };
  });
}

/**
 * A mark: 1 to 10 with up to two decimals (F19). The same bound holds for a
 * scale level's number, because that number *is* the mark the level means —
 * a level worth 42 would put the whole formula off its own scale.
 *
 * `numeric(4, 2)` would round a third decimal silently, which is the kind of
 * thing that turns a 7.005 into an argument.
 */
export function checkMark(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    throw new ApiError(400, "invalid_body", "La nota tiene que ser un número.");
  }
  if (raw < 1 || raw > 10) {
    throw new ApiError(400, "invalid_body", "La nota va de 1 a 10.");
  }
  if (Math.round(raw * 100) !== raw * 100) {
    throw new ApiError(
      400,
      "invalid_body",
      "La nota lleva hasta dos decimales.",
    );
  }
  return raw;
}
