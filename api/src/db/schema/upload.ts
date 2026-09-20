import { index, integer, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { campus } from "./_schema.js";
import { directorySubjectTable, directoryUserTable } from "./directory.js";

/**
 * A file a teacher dropped into an article: the TP's PDF, a screenshot, a
 * starter zip (F9). **The row is the index and the bytes are not here** — they
 * live on a Docker volume at a path derived from the id, because a shared
 * database that also carries every PDF bloats itself and every dump of it.
 *
 * **It belongs to a subject, not to an article.** The only link from an article
 * to a file is the text `::download{file=<id>}` inside `article_version.body`,
 * and the api parses no Markdown (F7, F44) — so nothing here can say which
 * articles reference a given upload. F37's "serving a file checks the
 * visibility of the articles that reference it" was reopened on exactly that,
 * and the reasoning is in F9: an upload is served to anybody holding its uuid.
 *
 * `size` and `sha256` are what make a restored backup checkable against the
 * database it was dumped beside. Neither is unique: two subjects uploading the
 * same PDF are two files, and deduplicating them would make one teacher's
 * delete another teacher's broken article.
 */
export const upload = campus.table(
  "upload",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    subjectId: integer("subject_id")
      .notNull()
      .references(() => directorySubjectTable.id),
    uploaderId: integer("uploader_id")
      .notNull()
      .references(() => directoryUserTable.id),
    /** As the teacher's filesystem spelled it — accents, spaces and all. */
    filename: text("filename").notNull(),
    /** What the browser claimed. What is *served* is `serveAs`'s decision. */
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("upload_subject_created_idx").on(t.subjectId, t.createdAt)],
);
