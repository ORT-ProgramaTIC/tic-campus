import { createHash, randomUUID } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { upload } from "../db/schema/upload.js";
import { ApiError } from "../middleware/errors.js";

/**
 * The files an article carries: the TP's PDF, a screenshot, a starter zip (F9).
 *
 * **The row is the index; the bytes are on the volume**, at `pathFor(dir, id)`.
 * That split is what makes listing and — the day somebody writes it — garbage
 * collection possible, without putting every PDF in the database tic-auth also
 * lives in.
 *
 * **An upload belongs to a subject and is served to anybody holding its uuid.**
 * F37 asked for the visibility of "the articles that reference it", and nothing
 * here can answer that: the reference is `::download{file=<id>}` inside the
 * Markdown, and the api parses no Markdown (F7, F44). F9 has the reasoning for
 * reopening it — in short, the check would only stop somebody *guessing* a
 * 122-bit id, while anybody who may read a restricted article can forward the
 * file itself regardless.
 */

export interface UploadSummary {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  sha256: string;
  uploaderId: number;
  createdAt: Date;
}

const SUMMARY = {
  id: upload.id,
  filename: upload.filename,
  mediaType: upload.mediaType,
  size: upload.size,
  sha256: upload.sha256,
  uploaderId: upload.uploaderId,
  createdAt: upload.createdAt,
};

/**
 * Flat, and the id is the whole name: no extension, because the media type is
 * a column, and no subject directory, because a file moved between subjects
 * would then have to move on disk too.
 *
 * ponytail: one directory for every upload of every subject. ext4 indexes
 * directories, so this is fine into the hundreds of thousands; shard on the
 * first two hex characters of the id if it ever stops being.
 */
export function pathFor(dir: string, id: string): string {
  return join(dir, id);
}

/**
 * What a filename may be before it reaches the database and a response header.
 *
 * `basename` rather than a rejection: the browser sends what the teacher's
 * filesystem had, and a path separator in it is a quirk of the upload (Safari
 * has historically sent full paths), not an attack to refuse. The id is what
 * names the file on disk — this never touches `pathFor` — but it does reach
 * `Content-Disposition`, which is why the control characters go.
 */
export function checkFilename(raw: unknown): string {
  if (typeof raw !== "string") {
    throw new ApiError(400, "invalid_upload", "Falta el nombre del archivo.");
  }
  const clean = basename(raw.replace(/[\u0000-\u001f\u007f]/g, "")).trim();
  if (clean === "" || clean === "." || clean === "..") {
    throw new ApiError(400, "invalid_upload", "Falta el nombre del archivo.");
  }
  if (clean.length > 200) {
    throw new ApiError(
      400,
      "invalid_upload",
      "El nombre del archivo es demasiado largo.",
    );
  }
  return clean;
}

/** A media type, or the honest fallback. Never echoed to a browser as-is. */
export function checkMediaType(raw: unknown): string {
  return typeof raw === "string" && /^[\w.+-]+\/[\w.+-]+$/.test(raw)
    ? raw.toLowerCase()
    : "application/octet-stream";
}

/**
 * **The one rule with teeth in this file.** Uploads are served from the same
 * origin as the app, so a file served `inline` with the type its uploader
 * claimed is stored XSS: an `.html`, or an `.svg` — which is a document that
 * runs script — would execute against a logged-in teacher's session.
 *
 * So the browser is only ever told the real type for things it renders and
 * cannot be scripted by, and **everything else is an octet-stream download**.
 * `image/svg+xml` is missing from this list on purpose and is the reason the
 * list is an allowlist rather than a denylist.
 *
 * Nothing is refused at *upload* time: F9 is explicitly for starter zips and
 * whatever else a teacher hands out.
 */
const INLINE = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "application/pdf",
]);

export function serveAs(mediaType: string): {
  contentType: string;
  disposition: "inline" | "attachment";
} {
  return INLINE.has(mediaType)
    ? { contentType: mediaType, disposition: "inline" }
    : { contentType: "application/octet-stream", disposition: "attachment" };
}

/**
 * `filename*` and not `filename`: these are Spanish filenames — `Guía de
 * TPs.pdf` — and the plain parameter is latin-1 by the letter of RFC 6266,
 * which mangles every accent.
 */
export function contentDisposition(
  filename: string,
  kind: "inline" | "attachment",
): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

/**
 * **Bytes first, row second.** A crash between them leaves a file nothing
 * points at: invisible, and swept up by whatever garbage collection the row
 * makes possible later. The other order would leave a row whose file 404s,
 * which is a broken article.
 *
 * The write goes to a temp name and is `rename`d into place — an atomic
 * operation within one filesystem — so the nightly `tar` can never pick up a
 * half-written file and call it a backup.
 */
export async function saveUpload(
  db: Db,
  dir: string,
  subjectId: number,
  uploaderId: number,
  file: { filename: string; mediaType: string; bytes: Buffer },
): Promise<UploadSummary> {
  // Minted here rather than by the database (F36): it names the file on disk,
  // and the bytes are written before the row exists.
  const id = randomUUID();
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");

  const target = pathFor(dir, id);
  const staging = `${target}.part`;
  await writeFile(staging, file.bytes, { flag: "wx" });
  await rename(staging, target);

  const [row] = await db
    .insert(upload)
    .values({
      id,
      subjectId,
      uploaderId,
      filename: file.filename,
      mediaType: file.mediaType,
      size: file.bytes.byteLength,
      sha256,
    })
    .returning(SUMMARY);
  return row!;
}

/** What the public serve route needs, and nothing else. */
export async function readUpload(
  db: Db,
  id: string,
): Promise<{ filename: string; mediaType: string } | null> {
  const [row] = await db
    .select({ filename: upload.filename, mediaType: upload.mediaType })
    .from(upload)
    .where(eq(upload.id, id))
    .limit(1);
  return row ?? null;
}

/** The subject's files, newest first — the editor's picker (F9). */
export async function listUploads(
  db: Db,
  subjectId: number,
): Promise<UploadSummary[]> {
  return db
    .select(SUMMARY)
    .from(upload)
    .where(eq(upload.subjectId, subjectId))
    .orderBy(desc(upload.createdAt));
}
