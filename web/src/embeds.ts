/**
 * F10's allowlist: the only iframes an article may show. The renderer (F44)
 * picks the directive syntax, say `::embed{url=…}`, and asks this module for a
 * src. The src is rebuilt from ids that passed a tight pattern, never copied
 * from the teacher's URL, so nothing but these three players can be framed.
 *
 * ponytail: start times and Slides options are dropped; add them when a
 * teacher asks.
 */

const YOUTUBE_ID = /^[\w-]{11}$/;
const TOKEN = /^[\w-]+$/;

const YOUTUBE_HOSTS = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
]);

export function embedSrc(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.hostname === "youtu.be" || YOUTUBE_HOSTS.has(url.hostname)) {
    const id =
      url.hostname === "youtu.be"
        ? parts[0]
        : parts[0] === "watch"
          ? url.searchParams.get("v")
          : parts[0] === "embed" || parts[0] === "shorts"
            ? parts[1]
            : undefined;
    return id && YOUTUBE_ID.test(id)
      ? `https://www.youtube-nocookie.com/embed/${id}`
      : null;
  }

  if (
    url.hostname === "docs.google.com" &&
    parts[0] === "presentation" &&
    parts[1] === "d"
  ) {
    // A published deck is /d/e/<id>/pub; a shared one is /d/<id>/edit.
    const published = parts[2] === "e";
    const id = published ? parts[3] : parts[2];
    if (!id || !TOKEN.test(id)) return null;
    return `https://docs.google.com/presentation/d/${published ? "e/" : ""}${id}/embed`;
  }

  if (
    (url.hostname === "codepen.io" || url.hostname === "www.codepen.io") &&
    parts[1] === "pen"
  ) {
    const [user, , id] = parts;
    if (!user || !id || !TOKEN.test(user) || !TOKEN.test(id)) return null;
    return `https://codepen.io/${user}/embed/${id}?default-tab=result`;
  }

  return null;
}

/** Spread onto the `<iframe>` beside the src. */
export const embedAttrs = {
  sandbox: "allow-scripts allow-same-origin allow-popups allow-presentation",
  allow: "fullscreen; encrypted-media; picture-in-picture",
  referrerpolicy: "strict-origin-when-cross-origin",
  loading: "lazy",
} as const;
