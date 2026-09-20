/**
 * The public URL's middle two segments (F32):
 * `/<year>/<subject-slug>/<offering-slug>/<article-slug>`.
 *
 * **Derived on read, never stored.** F32 settles it: the offering slug comes
 * from the directory, so a rename there changes the URL and there is nothing to
 * keep in step. The cost is that an old link lands on "no encontrado" — accepted,
 * because offerings are renamed about never, and the alternative is a stored
 * copy of somebody else's name that is wrong the moment they fix a typo.
 *
 * Nothing here touches the database, which is the point: the same two functions
 * build a link and parse one, so the two directions cannot disagree.
 */

/**
 * Lowercase, unaccented, hyphenated — `Bases de Datos` → `bases-de-datos`.
 *
 * `normalize('NFD')` splits an accented letter into its letter and its
 * combining mark, and the range below deletes the marks; no dependency, and it
 * handles the ñ and every tilde in a subject name. Anything left that is not
 * `a-z0-9` becomes a separator, runs collapse, and the ends are trimmed.
 */
export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * An offering's own segment: its name when it has one, else its courses'.
 *
 * `offering.name` is nullable and display-only — it exists to tell two
 * offerings of one subject apart, and `subject.name` is what carries the
 * meaning (`tic-auth/tic_auth/models/directory.py:89-91`). So most offerings
 * have none, and the courses are what a person would call it anyway:
 * `5to-informatica`, or `nr5a-nr5b` where one offering serves two.
 *
 * Course names are sorted before joining, so the segment does not depend on the
 * order rows came back in. An offering with neither a name nor a course yields
 * `''`, which `resolveBySlug` can never match — correctly: it has nothing a
 * person could have typed.
 */
export function offeringSlug(
  name: string | null,
  courseNames: readonly string[],
): string {
  if (name?.trim()) return slugify(name);
  return slugify([...courseNames].sort().join(" "));
}

/** The offering home's URL (F32). The article segment is F4's to append. */
export function offeringPath(
  year: number,
  subjectName: string,
  name: string | null,
  courseNames: readonly string[],
): string {
  return `/${year}/${slugify(subjectName)}/${offeringSlug(name, courseNames)}`;
}
