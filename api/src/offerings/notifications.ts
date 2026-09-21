import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type AnyColumn,
} from "drizzle-orm";
import type { Db } from "../db/client.js";
import { article } from "../db/schema/article.js";
import { directoryEnrollment } from "../db/schema/directory.js";
import { notificationRead } from "../db/schema/notification-read.js";
import { offeringArticle } from "../db/schema/offering-article.js";
import { offeringHome } from "../db/schema/offering-home.js";
import { result } from "../db/schema/result.js";
import { revisionRequest } from "../db/schema/revision-request.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The bell (F30): what happened to me lately that I have not looked at.
 *
 * **Derived on read, never written by a trigger.** Each kind is a fact another
 * table already holds together with its instant, so the list is three `SELECT`s
 * over those tables and nothing else. Two things that would each have needed a
 * job runner come free: a publish dated for Friday reaches the bell on Friday,
 * and a student who changes course stops getting the old course's items the
 * moment the directory says so. The only state F30 owns is the receipt
 * (`notification_read`, which carries the reasoning).
 *
 * **Every item needs a row in `directory.enrollment` now** — `seeOwnMarks`'s
 * question, so the bell never offers a link that `/results/mine` would 403.
 * It is an `exists` and not a join: the view carries one row per way somebody
 * is enrolled, and a join would print an item once per row.
 *
 * **No year and no lock enter it.** A mark published in a locked year is still
 * the student's to see (F35), and the window below already keeps last year
 * off the bell.
 *
 * Nothing about the kinds is per role: they are all things that happen to a
 * student, and staff with no enrolments get an empty bell, not a refusal.
 */

export const KINDS = [
  /** F24: a mark of mine became visible. Target: the `offering_article`. */
  "result_published",
  /** F29: a request that names me — as the student or as its filer — was
   *  answered. Target: the `revision_request`. */
  "revision_answered",
  /** F4: an article my class uses appeared, and its teacher asked for the
   *  class to be told (`offering_article.notify`). Target: the use. */
  "article_published",
] as const;
export type Kind = (typeof KINDS)[number];

/**
 * How far back the bell looks, by the item's own instant.
 * ponytail: a fixed window; a per-person "clear all" or a paged history is the
 * upgrade if a month of a student's items ever stops fitting on one screen.
 */
export const WINDOW_DAYS = 30;
/** What one read hands back. `unread` counts the whole window regardless. */
export const MAX_ITEMS = 50;

export interface Notification {
  kind: Kind;
  /** What `POST /api/notifications/read` names it by, with `kind`. */
  target: string;
  /** When it happened, which is also what a receipt has to be newer than. */
  at: Date;
  read: boolean;
  /** Enough for the client to build the link: the offering's URL is
   *  `/api/offerings/mine`'s, and the article's last segment is `slug`. */
  offeringId: number;
  activityId: string;
  slug: string;
  title: string;
}

export interface Bell {
  unread: number;
  items: Notification[];
}

export async function myNotifications(
  db: Db,
  userId: number,
  now = new Date(),
): Promise<Bell> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const enrolled = sql`exists (
    select 1 from ${directoryEnrollment}
    where ${directoryEnrollment.studentId} = ${userId}
      and ${directoryEnrollment.offeringId} = ${offeringHome.offeringId})`;
  // The unread rule, one for all three: a receipt counts only if it is newer
  // than the item, so a re-answer or a publish moved later is news again.
  const read = (kind: Kind, target: AnyColumn, at: AnyColumn) =>
    sql<boolean>`exists (
      select 1 from ${notificationRead}
      where ${notificationRead.userId} = ${userId}
        and ${notificationRead.kind} = ${kind}
        and ${notificationRead.target} = ${target}
        and ${notificationRead.readAt} >= ${at})`;
  const common = {
    offeringId: offeringHome.offeringId,
    activityId: offeringArticle.id,
    slug: article.slug,
    title: article.title,
  };
  const live = and(
    eq(offeringHome.id, offeringArticle.offeringHomeId),
    isNull(offeringHome.archivedAt),
  );
  const inWindow = (at: AnyColumn) => and(lte(at, now), gt(at, since));

  const [results, revisions, articles] = await Promise.all([
    db
      .select({
        ...common,
        target: offeringArticle.id,
        at: offeringArticle.resultsPublishedAt,
        read: read(
          "result_published",
          offeringArticle.id,
          offeringArticle.resultsPublishedAt,
        ),
      })
      .from(offeringArticle)
      .innerJoin(offeringHome, live)
      // No `archivedAt` filter on the article: `myResults` shows the mark
      // whatever the library did with the statement, and so does this.
      .innerJoin(article, eq(article.id, offeringArticle.articleId))
      .where(
        and(
          isNotNull(offeringArticle.valueType),
          inWindow(offeringArticle.resultsPublishedAt),
          enrolled,
          // Only somebody who has a mark there. Any row: this asks whether
          // one exists, where F41's history does not matter.
          sql`exists (select 1 from ${result}
                where ${result.offeringArticleId} = ${offeringArticle.id}
                  and ${result.studentId} = ${userId})`,
        ),
      ),
    db
      .select({
        ...common,
        target: revisionRequest.id,
        at: revisionRequest.answeredAt,
        read: read(
          "revision_answered",
          revisionRequest.id,
          revisionRequest.answeredAt,
        ),
      })
      .from(revisionRequest)
      .innerJoin(
        offeringArticle,
        eq(offeringArticle.id, revisionRequest.offeringArticleId),
      )
      .innerJoin(offeringHome, live)
      .innerJoin(article, eq(article.id, offeringArticle.articleId))
      .where(
        and(
          // Whose mark it is, and who wrote the words (F29's group filing):
          // both are waiting for this answer.
          or(
            eq(revisionRequest.studentId, userId),
            eq(revisionRequest.requestedBy, userId),
          ),
          inWindow(revisionRequest.answeredAt),
          enrolled,
        ),
      ),
    db
      .select({
        ...common,
        target: offeringArticle.id,
        at: offeringArticle.publishedAt,
        read: read(
          "article_published",
          offeringArticle.id,
          offeringArticle.publishedAt,
        ),
      })
      .from(offeringArticle)
      .innerJoin(offeringHome, live)
      // `mayRead`'s conditions for an enrolled student, minus `restricted`,
      // which an enrolled student passes: served at all, and dated to now.
      .innerJoin(
        article,
        and(
          eq(article.id, offeringArticle.articleId),
          isNull(article.archivedAt),
          isNotNull(article.publishedVersionId),
        ),
      )
      .where(
        and(
          eq(offeringArticle.notify, true),
          inWindow(offeringArticle.publishedAt),
          enrolled,
        ),
      ),
  ]);

  const all = [
    ...results.map((row) => ({ ...row, kind: "result_published" as const })),
    ...revisions.map((row) => ({ ...row, kind: "revision_answered" as const })),
    ...articles.map((row) => ({ ...row, kind: "article_published" as const })),
  ]
    // `at` is non-null by the window's `lte`; the type cannot know that.
    .map((row) => ({ ...row, at: row.at! }) as Notification)
    .sort(
      (a, b) =>
        b.at.getTime() - a.at.getTime() || a.target.localeCompare(b.target),
    );
  return {
    unread: all.filter((item) => !item.read).length,
    items: all.slice(0, MAX_ITEMS),
  };
}

export interface ReadInput {
  kind: Kind;
  target: string;
}

/**
 * The caller has seen these. An upsert to `now()`, so marking read twice moves
 * the receipt forward and never mints a second one.
 *
 * **Nothing checks that the items are the caller's.** A receipt only ever
 * changes the caller's own bell, so the worst a forged one does is hide
 * nothing from nobody — the check would be three queries guarding no one.
 *
 * The caller's receipts older than the window are swept here: one can never
 * hide an item still on the bell, because anything inside the window happened
 * after it was written.
 */
export async function markRead(
  db: Db,
  userId: number,
  items: ReadInput[],
): Promise<void> {
  await db
    .insert(notificationRead)
    .values(items.map((item) => ({ userId, ...item })))
    .onConflictDoUpdate({
      target: [
        notificationRead.userId,
        notificationRead.kind,
        notificationRead.target,
      ],
      set: { readAt: sql`now()` },
    });
  await db
    .delete(notificationRead)
    .where(
      and(
        eq(notificationRead.userId, userId),
        lt(
          notificationRead.readAt,
          sql`now() - make_interval(days => ${WINDOW_DAYS})`,
        ),
      ),
    );
}

/** A whole bell, twice over. It only stops a garbage array reaching Postgres. */
const MAX_READ = 200;

export function checkRead(raw: unknown): ReadInput[] {
  if (typeof raw !== "object" || raw === null) {
    throw new ApiError(400, "invalid_body", "Esperábamos un objeto.");
  }
  const { items } = raw as Record<string, unknown>;
  if (!Array.isArray(items) || items.length === 0) {
    throw new ApiError(400, "invalid_body", "Faltan los avisos leídos.");
  }
  if (items.length > MAX_READ) {
    throw new ApiError(400, "invalid_body", "Son demasiados avisos.");
  }
  const seen = new Map<string, ReadInput>();
  for (const item of items) {
    const { kind, target } = (item ?? {}) as Record<string, unknown>;
    if (!KINDS.includes(kind as Kind) || !isUuid(target)) {
      throw new ApiError(400, "invalid_body", "Ese aviso no existe.");
    }
    // Deduplicated, or one statement would try to upsert the same row twice
    // and Postgres refuses that outright.
    const id = target.toLowerCase();
    seen.set(`${kind}:${id}`, { kind: kind as Kind, target: id });
  }
  return [...seen.values()];
}
