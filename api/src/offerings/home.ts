import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { offeringHome, type HomeLink } from "../db/schema/offering-home.js";
import { programUnit } from "../db/schema/program-unit.js";
import { isUuid, type Unit } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";

/**
 * How an offering's home is put together (F14), and the offering's own order
 * and hiding of the library's units (F15's per-offering half).
 *
 * A leaf, like `REDO_POLICIES` in `gradebook.ts`: `content.ts` reads through
 * here, and nothing here imports `content.ts` back.
 *
 * **Sections are presentation, not access.** A section switched off still
 * ships its data — an article stays readable at its URL and a student's marks
 * at `/results/mine`. Hiding content is `restricted` and `publishedAt` (F4),
 * which is one rule in `mayRead` and should stay one.
 *
 * **Timetable and calendar are not sections.** They are campus-wide views, not
 * a teacher's choice for one offering, so the domain holds only what a home
 * renders and they arrive with their own readers.
 */
export const SECTIONS = ["program", "articles", "links", "marks"] as const;
export type Section = (typeof SECTIONS)[number];

/** What an offering nobody configured shows — `sections` null reads as this. */
export const DEFAULT_SECTIONS: readonly Section[] = SECTIONS;

export interface HomeConfig {
  sections: Section[];
  links: HomeLink[];
  unitOrder: string[];
  hiddenUnits: string[];
}

/** A program unit as one offering shows it. `hidden` is only ever true for
 *  staff — everyone else never receives the unit. */
export interface HomeUnit extends Unit {
  hidden: boolean;
}

/**
 * The library's units in this offering's order, hidden ones dropped for
 * students and flagged for staff (F15).
 *
 * `unitId` stays a `program_unit.id` whatever an offering does, so a unit not
 * in `unitOrder` — added to the library after the offering was arranged — goes
 * after the listed ones in the library's own order, and an id left behind by a
 * deleted unit matches nothing.
 */
export function arrangeUnits(
  program: Unit[],
  unitOrder: string[],
  hiddenUnits: string[],
  staff: boolean,
): HomeUnit[] {
  const rank = new Map(unitOrder.map((id, at) => [id, at]));
  const hidden = new Set(hiddenUnits);
  // Unlisted units share the last rank, and `sort` is stable, so they keep the
  // library's order behind the listed ones.
  const at = (unit: Unit) => rank.get(unit.id) ?? unitOrder.length;
  return program
    .map((unit) => ({ ...unit, hidden: hidden.has(unit.id) }))
    .filter((unit) => staff || !unit.hidden)
    .sort((a, b) => at(a) - at(b));
}

/** The body of `PUT /api/homes/:offeringId/home`, whole. */
export function checkHome(raw: unknown): HomeConfig {
  if (typeof raw !== "object" || raw === null) {
    throw invalid("Esperábamos un objeto.");
  }
  const body = raw as Record<string, unknown>;

  if (!Array.isArray(body.sections)) {
    throw invalid("`sections` es una lista.");
  }
  for (const section of body.sections) {
    if (!(SECTIONS as readonly unknown[]).includes(section)) {
      throw invalid(`\`sections\` lleva solo ${SECTIONS.join(", ")}.`);
    }
  }
  if (new Set(body.sections).size !== body.sections.length) {
    throw invalid("Una sección va una sola vez.");
  }

  if (!Array.isArray(body.links) || body.links.length > 50) {
    throw invalid("`links` es una lista de hasta 50 enlaces.");
  }
  const links = body.links.map((link: unknown): HomeLink => {
    const { title, url } = (link ?? {}) as Record<string, unknown>;
    if (
      typeof title !== "string" ||
      title.trim() === "" ||
      title.length > 200
    ) {
      throw invalid("Cada enlace necesita un título de hasta 200 letras.");
    }
    // A trust boundary, not tidiness: this becomes an `href` on every
    // student's screen, and `javascript:` there is stored XSS against the
    // whole class. Only a URL that parses on its own, over http or https.
    if (typeof url !== "string" || url.length > 2000 || !isWebUrl(url)) {
      throw invalid("Cada enlace es una dirección http:// o https://.");
    }
    return { title: title.trim(), url };
  });

  return {
    sections: body.sections as Section[],
    links,
    unitOrder: unitIdsFrom(body.unitOrder, "unitOrder"),
    hiddenUnits: unitIdsFrom(body.hiddenUnits, "hiddenUnits"),
  };
}

/**
 * Save the whole configuration. The unit ids come from the body, so they are
 * checked against *this* subject's program, the way `writeProgram` checks its
 * own — an id from another subject would otherwise sit in the array forever
 * doing nothing, which is harmless but is also a client bug worth hearing
 * about.
 */
export async function writeHome(
  db: Db,
  homeId: string,
  subjectId: number,
  config: HomeConfig,
): Promise<HomeConfig> {
  const given = [...new Set([...config.unitOrder, ...config.hiddenUnits])];
  if (given.length > 0) {
    const mine = await db
      .select({ id: programUnit.id })
      .from(programUnit)
      .where(
        and(
          eq(programUnit.subjectId, subjectId),
          inArray(programUnit.id, given),
        ),
      );
    if (mine.length !== given.length) {
      throw new ApiError(
        400,
        "unknown_unit",
        "Alguna de las unidades no es de esta materia. Recargá el programa.",
      );
    }
  }
  await db.update(offeringHome).set(config).where(eq(offeringHome.id, homeId));
  return config;
}

function unitIdsFrom(raw: unknown, field: string): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 200 || !raw.every(isUuid)) {
    throw invalid(`\`${field}\` es una lista de hasta 200 unidades.`);
  }
  // Postgres hands uuids back lowercase; so does this, or a client that sent
  // one in capitals would not find it in the payload it reads back.
  return [...new Set(raw.map((id) => id.toLowerCase()))];
}

function isWebUrl(raw: string): boolean {
  try {
    const { protocol } = new URL(raw);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

function invalid(message: string): ApiError {
  return new ApiError(400, "invalid_body", message);
}
