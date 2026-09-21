import { Router } from "express";
import type { Db } from "../db/client.js";
import {
  checkRead,
  markRead,
  myNotifications,
} from "../offerings/notifications.js";

/**
 * The bell (F30), mounted behind `guard`: it is always the caller's own, so a
 * session is the whole of the gate and no offering is in the path.
 *
 * One read that carries the count, rather than a count route beside the list —
 * the badge and the dropdown are the same three queries, and a client that
 * asked twice would get two answers from two instants.
 */
export function createNotificationRoutes(db: Db): Router {
  const router = Router();

  router.get("/", (req, res, next) => {
    void (async () => {
      try {
        res
          .status(200)
          .json(await myNotifications(db, req.session!.record.userId));
      } catch (cause) {
        next(cause);
      }
    })();
  });

  // "Mark all read" is this with every item the client holds; there is no
  // second route for it, because "all" would have to mean "all as of when",
  // and the items the client was shown are the only honest answer.
  router.post("/read", (req, res, next) => {
    void (async () => {
      try {
        const items = checkRead(req.body);
        await markRead(db, req.session!.record.userId, items);
        res.status(204).end();
      } catch (cause) {
        next(cause);
      }
    })();
  });

  return router;
}
