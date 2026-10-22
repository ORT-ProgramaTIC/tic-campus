import { Router, type Request } from "express";
import type { Db } from "../db/client.js";
import { isUuid } from "../library/program.js";
import { ApiError } from "../middleware/errors.js";
import { actorFrom, capabilitiesFor } from "../offerings/access.js";
import { activeHome, manageableHome } from "../offerings/content.js";
import {
  BELL,
  checkSchedule,
  checkState,
  classBlocks,
  expandSlots,
  myTeams,
  offeringTeams,
  previewSchedule,
  readSchedule,
  saveSchedule,
  schedule,
  setState,
} from "../offerings/presentations.js";

/**
 * The presentation schedule (F45), under `/api/homes` beside the gradebook and
 * for the same reason: its segments are ids, not a public URL. **The guard is
 * on the mount** (`index.ts`), so this router has none of its own.
 *
 * **Signed-in only, and not F4-public.** Any signed-in user reads a
 * current-year schedule, so a student can look at the other rotation's; a past
 * year's is its staff's and enrolled students' only. Writing is `manageOffering`.
 *
 * No year lock: F35 locks marks, and nothing here is one.
 */

function offeringIdFrom(raw: string): number {
  if (!/^\d{1,9}$/.test(raw)) {
    throw new ApiError(404, "not_found", "No encontrado.");
  }
  return Number(raw);
}

export function createPresentationRoutes(db: Db): Router {
  const router = Router();

  function mustManage(req: Request) {
    const { record } = req.session!;
    return manageableHome(
      db,
      offeringIdFrom(String(req.params.offeringId)),
      actorFrom(record.userId, record.claims),
    );
  }

  /**
   * The whole schedule in one read, for both screens: blocks with their slots,
   * the teams, the queue with each team's estimate, `queueStarts`, and `mine`
   * for the student banner. Staff also get `classBlocks` and `bell`, which are what the block
   * picker offers — a student has no use for the timetable of a schedule they
   * cannot edit.
   *
   * `savedAt` is the token the `PUT` carries back (F12).
   */
  router.get("/:offeringId/presentations", (req, res, next) => {
    void (async () => {
      try {
        const offeringId = offeringIdFrom(String(req.params.offeringId));
        const home = await activeHome(db, offeringId);
        if (!home) {
          throw new ApiError(404, "not_found", "Esa materia no está activada.");
        }
        const { record } = req.session!;
        const can = await capabilitiesFor(
          db,
          actorFrom(record.userId, record.claims),
          offeringId,
          home.subjectId,
        );
        if (!home.isCurrent && !can.manageOffering && !can.seeOwnMarks) {
          throw new ApiError(
            403,
            "forbidden",
            "El cronograma de otro año lo ve quien cursó o dio esta materia.",
          );
        }
        const [rows, teams, mine, modules] = await Promise.all([
          readSchedule(db, home.homeId),
          offeringTeams(db, offeringId),
          myTeams(db, offeringId, record.userId),
          can.manageOffering ? classBlocks(db, offeringId) : null,
        ]);
        const names = new Map(teams.map((team) => [team.projectId, team.name]));
        const placed = schedule(
          rows.blocks,
          rows.queue,
          new Date(),
          rows.queueStarts,
        );
        res.status(200).json({
          blocks: rows.blocks.map((block) => ({
            ...block,
            slots: expandSlots(block),
          })),
          teams,
          presentations: rows.queue.map((entry) => ({
            id: entry.id,
            projectId: entry.projectId,
            // A project archived or emptied upstream since it was queued keeps
            // its row here, nameless, so the teacher can see it and take it out.
            name: names.get(entry.projectId) ?? null,
            round: entry.round,
            position: entry.position,
            state: entry.state,
            pin:
              entry.pinnedBlockId === null
                ? null
                : { blockId: entry.pinnedBlockId, slot: entry.pinnedSlot },
            ...placed.get(entry.id),
          })),
          mine,
          queueStarts: rows.queueStarts,
          savedAt: rows.savedAt,
          ...(modules ? { classBlocks: modules, bell: BELL } : {}),
        });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The teacher saves the schedule whole: `{ base, blocks, presentations }`.
   * Order in `presentations` is position within each round. Leaving something
   * out deletes it; a stale `base` is `409 stale_schedule`. See
   * `saveSchedule` for why both are safe.
   */
  router.put("/:offeringId/presentations", (req, res, next) => {
    void (async () => {
      try {
        const home = await mustManage(req);
        const savedAt = await saveSchedule(
          db,
          home.homeId,
          offeringIdFrom(String(req.params.offeringId)),
          home.year,
          checkSchedule(req.body),
        );
        res.status(200).json({ savedAt });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /**
   * The same body as the `PUT`, answered with where every team would land and
   * nothing saved — the dashboard's live view while the teacher edits. A body
   * the save would refuse is refused here the same way.
   */
  router.post("/:offeringId/presentations/preview", (req, res, next) => {
    void (async () => {
      try {
        const home = await mustManage(req);
        const input = checkSchedule(req.body);
        const presentations = await previewSchedule(
          db,
          home.homeId,
          offeringIdFrom(String(req.params.offeringId)),
          home.year,
          input,
        );
        res.status(200).json({
          blocks: input.blocks.map((block) => ({
            ...block,
            slots: expandSlots(block),
          })),
          presentations,
        });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  /** One team's state, on the day (F45). Does not stale an open dashboard. */
  router.patch("/:offeringId/presentations/:rowId/state", (req, res, next) => {
    void (async () => {
      try {
        const { homeId } = await mustManage(req);
        if (!isUuid(req.params.rowId)) {
          throw new ApiError(404, "not_found", "No encontrado.");
        }
        const state = checkState(req.body);
        await setState(db, homeId, req.params.rowId, state);
        res.status(200).json({ state });
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
