import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { SessionClaims } from "../db/schema/session.js";
import {
  directoryEnrollment,
  directoryOffering,
  directoryTeacherOffering,
} from "../db/schema/directory.js";

/**
 * What a person may do with an offering, derived from the directory (F5).
 *
 * **Campus keeps no ACL tables.** A second editor list would be a second roster
 * to hold in step with the one tic-directory already maintains, and the roster
 * is exactly what the rebuild stopped owning. So every answer here is a row in
 * `directory.*` or a key in the token.
 *
 * There is no rank ladder and no `requireRole`. MEV has one because its gates
 * are role-shaped; campus's are resource-shaped — *teacher of this subject*,
 * *student of this offering* — and F3 settled that the session gate is being
 * signed in and nothing else. `acr === 'strong'` is asserted by `verify.ts` for
 * every session that exists, so there is no second credential gate either.
 */

/** The person a request is acting as. `roles` is tic-auth's list, kept whole. */
export interface Actor {
  userId: number;
  roles: readonly string[];
  isAdmin: boolean;
}

/**
 * **`admin`, never a prefix match.** `admin-hosting` is tic-hosting's operators
 * and grants nothing in the directory — tic-auth's `0008` says so where it
 * creates the role. A `startsWith('admin')` here would hand every VM operator
 * the gradebook.
 */
export function isAdmin(roles: readonly string[]): boolean {
  return roles.includes("admin");
}

export function actorFrom(userId: number, claims: SessionClaims): Actor {
  return { userId, roles: claims.roles, isAdmin: isAdmin(claims.roles) };
}

/**
 * F5's three verbs, and there is deliberately no fourth: everything else campus
 * serves is public (F4).
 *
 * **`seeOwnMarks` asks `directory.enrollment` and not `roles[]`**, which is the
 * opposite of what `listMine` does with the same table, and the difference is
 * the question. Listing is *what belongs on your home page*, where a teacher
 * enrolled in their own offering should see it as something they teach.
 * Authorizing is *does a row name this person*, and if one does, the results it
 * would let them read are their own. A role gate here would refuse somebody
 * their own marks on the strength of a claim in a token rather than a row in
 * the roster.
 */
export interface Capabilities {
  /** The subject's article library — any offering of that subject, any year. */
  editLibrary: boolean;
  /** This offering's gradebook, home, calendar and revisions. */
  manageOffering: boolean;
  /** Their own results for this offering. */
  seeOwnMarks: boolean;
}

const ALL: Capabilities = {
  editLibrary: true,
  manageOffering: true,
  seeOwnMarks: true,
};

/**
 * Up to three probes, each `.limit(1)`, and none of them `selectDistinct`:
 * limiting to one row makes duplicates free, and a teacher of four offerings of
 * one subject is four rows to the library question.
 *
 * ADMIN short-circuits without a query. It is a superset by rank, not by
 * synthetic rows — F41's audit log has to be able to say an admin did this, and
 * a granted row would make them look like a teacher.
 */
export async function capabilitiesFor(
  db: Db,
  actor: Actor,
  offeringId: number,
  subjectId: number,
): Promise<Capabilities> {
  if (actor.isAdmin) return ALL;

  const teachesOffering = await exists(
    db
      .select({ one: directoryTeacherOffering.id })
      .from(directoryTeacherOffering)
      .where(
        and(
          eq(directoryTeacherOffering.teacherId, actor.userId),
          eq(directoryTeacherOffering.offeringId, offeringId),
        ),
      )
      .limit(1),
  );

  // Teaching *this* offering is teaching its subject, so the join below only
  // has to run for somebody who does not.
  const teachesSubject =
    teachesOffering ||
    (await exists(
      db
        .select({ one: directoryTeacherOffering.id })
        .from(directoryTeacherOffering)
        .innerJoin(
          directoryOffering,
          eq(directoryOffering.id, directoryTeacherOffering.offeringId),
        )
        .where(
          and(
            eq(directoryTeacherOffering.teacherId, actor.userId),
            eq(directoryOffering.subjectId, subjectId),
          ),
        )
        .limit(1),
    ));

  const enrolled = await exists(
    db
      .select({ one: directoryEnrollment.studentId })
      .from(directoryEnrollment)
      .where(
        and(
          eq(directoryEnrollment.studentId, actor.userId),
          eq(directoryEnrollment.offeringId, offeringId),
        ),
      )
      .limit(1),
  );

  return {
    editLibrary: teachesSubject,
    manageOffering: teachesOffering,
    seeOwnMarks: enrolled,
  };
}

/** Nobody signed in is nobody: the public reads still need a shape to project. */
export const NONE: Capabilities = {
  editLibrary: false,
  manageOffering: false,
  seeOwnMarks: false,
};

async function exists(query: Promise<unknown[]>): Promise<boolean> {
  return (await query).length > 0;
}
