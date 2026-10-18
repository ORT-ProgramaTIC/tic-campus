/**
 * The timetable's calendar arithmetic, on the api's `YYYY-MM-DD` calendar
 * days. Done at UTC so no offset moves a day; only "has this slot ended"
 * needs Buenos Aires, and that is the api's fixed −03:00 (F45).
 */

/** `2026-10-23` plus `n` days. */
export function addDays(date: string, n: number): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + n);
  return day.toISOString().slice(0, 10);
}

/** The Monday of the week holding `date`. */
export function mondayOf(date: string): string {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((weekday + 6) % 7));
}

/** The Mondays of every week with a block, in order. */
export function weeksOf(blocks: { date: string }[]): string[] {
  return [...new Set(blocks.map((block) => mondayOf(block.date)))].sort();
}

/** Has this slot ended, as of `now`. */
export function ended(slot: { date: string; end: string }, now: Date): boolean {
  return new Date(`${slot.date}T${slot.end}:00-03:00`) <= now;
}

/** The week to open on: the first with a slot still to come, else the last
 *  (everything has happened — show how it ended). */
export function openingWeek(
  blocks: { date: string; slots: { date: string; end: string }[] }[],
  now: Date,
): string | undefined {
  const upcoming = blocks
    .filter((block) => block.slots.some((slot) => !ended(slot, now)))
    .map((block) => block.date)
    .sort()[0];
  return upcoming ? mondayOf(upcoming) : weeksOf(blocks).at(-1);
}
