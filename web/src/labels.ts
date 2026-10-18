import type { PresentationState } from "./api/types.ts";

/** What each state is called on screen — the 2025 sheet's words. */
export const STATE_LABEL: Record<PresentationState, string> = {
  pending: "Pendiente",
  presenting: "Presentando",
  presented: "Presentado",
  passed: "Aprobado",
  failed: "Desaprobado",
  absent: "No presentan",
};

/** The 2025 chip colours, plus violet for the one on stage now. */
export const STATE_TONE: Record<PresentationState, string> = {
  pending: "bg-gray-100 text-gray-700 ring-gray-300",
  presenting: "bg-lilac-100 text-lilac-700 ring-lilac-300",
  presented: "bg-indigo-50 text-indigo-600 ring-indigo-300",
  passed: "bg-emerald-50 text-emerald-600 ring-emerald-300",
  failed: "bg-red-50 text-red-600 ring-red-300",
  absent: "bg-amber-50 text-amber-600 ring-amber-300",
};

const DAY = new Intl.DateTimeFormat("es-AR", {
  weekday: "long",
  day: "numeric",
  month: "long",
  // The api's dates are calendar days, not instants: read them at UTC so no
  // offset can move one to the day before.
  timeZone: "UTC",
});

/** `2026-10-23` → `Viernes 23 de octubre`. */
export function formatDay(date: string): string {
  const text = DAY.format(new Date(`${date}T00:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** `1` → `1ª ronda`. */
export const roundLabel = (round: number) => `${round}ª ronda`;

const ORDINAL = ["", "1er", "2do", "3er", "4to", "5to", "6to"];

/** `3` → `3er bloque`. */
export const blockLabel = (block: number) =>
  `${ORDINAL[block] ?? `${block}°`} bloque`;

/**
 * A member's track as people read it. Copied from tic-registry's
 * `PROJECT_TRACK_LABELS` (`tic_directory/models/enums.py`), which the
 * directory view does not publish; a track added there shows as its slug
 * here until this catches up.
 */
const TRACK_LABEL: Record<string, string> = {
  backend: "Backend",
  frontend: "Frontend",
  fullstack: "Fullstack",
  timi: "TIMI",
  ia: "IA",
  "videojuegos-desarrollo": "Desarrollo de Videojuegos",
  "videojuegos-arte": "Arte de Videojuegos",
  "ux-ui": "UX/UI",
  hardware: "Hardware",
};

export const trackLabel = (track: string) => TRACK_LABEL[track] ?? track;
