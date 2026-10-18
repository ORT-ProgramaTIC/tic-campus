/**
 * What the api answers, for the routes the web calls — written by hand from
 * `api/src`, not imported from it: the two are separate builds, and the api's
 * types carry drizzle and Express with them. Each type names its source, so a
 * change there has an obvious place to land here.
 *
 * JSON turns every `Date` into an ISO string; those fields are `string` here.
 */

/* ── Session (`api/src/routes/auth.ts`, `createMeRoute`) ─────────────────── */

export interface Me {
  me: {
    id: number;
    email: string | null;
    name: string | null;
    given_name: string | null;
    family_name: string | null;
    roles: string[];
  };
  csrf_token: string;
  /** Where to send the browser after `POST /api/auth/logout`. */
  idp_logout_url: string;
}

/* ── Offerings (`api/src/offerings/catalog.ts`, `access.ts`, `content.ts`) ── */

export interface OfferingSummary {
  offeringId: number;
  subjectId: number;
  subjectName: string;
  /** Display-only; tells two offerings of one subject apart. */
  offeringName: string | null;
  courseNames: string[];
  year: number;
  /** `/<year>/<subject>/<offering>` — the only thing a link is built from. */
  path: string;
}

/** `GET /api/offerings/mine`. */
export interface MyOffering extends OfferingSummary {
  roles: ("student" | "teacher")[];
  openRevisions: number;
}

export interface Capabilities {
  editLibrary: boolean;
  /** Teaches this offering: gates the teacher page. */
  manageOffering: boolean;
  /** Enrolled in it. */
  seeOwnMarks: boolean;
}

export type Section =
  "program" | "articles" | "links" | "marks" | "presentations";

/** `GET /api/offerings/:year/:subject/:offering`. `program` and `articles`
 *  are the home's content, which no presentations screen reads; typed loosely
 *  until a screen does. */
export interface ResolvedOffering extends OfferingSummary {
  can: Capabilities;
  sections: Section[];
  links: { title: string; url: string }[];
  program: unknown[];
  articles: unknown[];
}

/* ── Presentations (`api/src/offerings/presentations.ts`, F45) ────────────── */

export type PresentationState =
  "pending" | "presenting" | "presented" | "passed" | "failed" | "absent";

export interface Slot {
  blockId: string;
  /** 1-based. */
  slot: number;
  /** `YYYY-MM-DD`, Buenos Aires. */
  date: string;
  /** `HH:MM`. */
  start: string;
  end: string;
  /** Its start was typed by a teacher rather than split evenly. */
  overridden: boolean;
  /** Struck on this date: draw it crossed out, it goes to nobody. */
  skipped: boolean;
}

export interface Block {
  /** Minted by the client (`crypto.randomUUID()`) when the block is created. */
  id: string;
  round: number;
  date: string;
  /** 1–6. */
  block: number;
  slotCount: number;
  /** One `HH:MM` or `null` (even split) per slot; `null` for all-even. */
  slotStarts: (string | null)[] | null;
  skippedSlots: number[];
  /** Read-only, computed: send `Block` without it. */
  slots: Slot[];
}

export interface Estimate extends Slot {
  /** Holding its pinned slot rather than placed by the queue. */
  pinned: boolean;
}

export interface Presentation {
  id: string;
  projectId: number;
  /** `null`: the project was archived or emptied upstream since it was queued. */
  name: string | null;
  round: number;
  position: number;
  state: PresentationState;
  pin: { blockId: string; slot: number } | null;
  /** `null`: finished, or more teams than slots. */
  estimate: Estimate | null;
  /** Its pinned slot passed with the team still waiting; placed by the queue. */
  pinMissed: boolean;
}

export interface Team {
  projectId: number;
  name: string;
}

export interface QueueStart {
  round: number;
  blockId: string;
  slot: number;
}

export interface ClassBlock {
  day: "monday" | "tuesday" | "wednesday" | "thursday" | "friday";
  block: number;
  classroom: string | null;
}

/** `GET /api/homes/:offeringId/presentations`. */
export interface PresentationsPayload {
  blocks: Block[];
  teams: Team[];
  presentations: Presentation[];
  /** The caller's own project ids — the student banner's team(s). */
  mine: number[];
  queueStarts: QueueStart[];
  /** Send it back as `base` on the next save; `null` if never saved. */
  savedAt: string | null;
  /** Staff only: the weekly modules a block may use. */
  classBlocks?: ClassBlock[];
  /** Staff only: blocks 1–6 with their bell times. */
  bell?: Record<string, { start: string; end: string }>;
}

/** `PUT /api/homes/:offeringId/presentations`. Order in `presentations` is
 *  position within each round; anything left out is deleted. */
export interface ScheduleBody {
  base: string | null;
  blocks: Omit<Block, "slots">[];
  presentations: {
    projectId: number;
    round: number;
    pin: { blockId: string; slot: number } | null;
  }[];
  queueStarts: QueueStart[];
}
