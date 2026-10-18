import { ChevronLeft, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { formatDay } from "./labels.ts";
import { addDays } from "./weeks.ts";

const DAYS = ["LUN", "MAR", "MIE", "JUE", "VIE"];
const BLOCKS = [1, 2, 3, 4, 5, 6];

const SHORT = new Intl.DateTimeFormat("es-AR", {
  day: "numeric",
  month: "long",
  timeZone: "UTC",
});
const at = (date: string) => new Date(`${date}T00:00:00Z`);

/** `Semana del 19 al 23 de octubre`, or across months `del 28 de septiembre
 *  al 2 de octubre`. */
function weekTitle(monday: string): string {
  const friday = addDays(monday, 4);
  const from =
    monday.slice(5, 7) === friday.slice(5, 7)
      ? String(at(monday).getUTCDate())
      : SHORT.format(at(monday));
  return `Semana del ${from} al ${SHORT.format(at(friday))}`;
}

/**
 * One week on tic-registry's grid: Monday to Friday by blocks 1–6, the
 * afternoon break drawn and labelled. A phone gets the week's days as a list
 * instead, with only the cells that hold something.
 *
 * What a cell holds is the caller's: `cell(date, block, labelled)` returns it,
 * or `null` for an empty module — dashed on the grid, left out of the list.
 * `labelled` is the list's case, where the row number is not there to say
 * which block it is.
 */
export function WeekGrid({
  title,
  week,
  onWeek,
  prev,
  next,
  cell,
}: {
  title: string;
  week: string;
  onWeek: (monday: string) => void;
  /** The Monday the arrows go to, or `undefined` to disable that arrow. */
  prev: string | undefined;
  next: string | undefined;
  cell: (date: string, block: number, labelled: boolean) => ReactNode | null;
}) {
  const dates = DAYS.map((_, day) => addDays(week, day));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="text-sm text-ink-muted">{weekTitle(week)}</p>
        </div>
        <div className="flex gap-1">
          <WeekButton label="Semana anterior" to={prev} onWeek={onWeek}>
            <ChevronLeft className="size-4" aria-hidden />
          </WeekButton>
          <WeekButton label="Semana siguiente" to={next} onWeek={onWeek}>
            <ChevronRight className="size-4" aria-hidden />
          </WeekButton>
        </div>
      </div>

      {/* `table-fixed`: five equal days, whatever is in them. */}
      <table className="mt-6 hidden w-full table-fixed border-separate border-spacing-1.5 md:table">
        <thead>
          <tr>
            <th className="w-8" />
            {dates.map((date, day) => (
              <th
                key={date}
                className="pb-1 text-xs font-semibold tracking-wider text-ink-faint"
              >
                {DAYS[day]} {at(date).getUTCDate()}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {BLOCKS.map((number) => (
            <Fragment key={number}>
              {number === 4 && <AfternoonBreak />}
              <tr>
                <th className="pr-1 text-right align-top text-xs font-semibold text-ink-faint">
                  {number}
                </th>
                {dates.map((date) => (
                  <td key={date} className="align-top">
                    {cell(date, number, false) ?? (
                      <div className="h-12 rounded-xl border border-dashed border-line" />
                    )}
                  </td>
                ))}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      <div className="mt-6 flex flex-col gap-5 md:hidden">
        {dates.map((date) => {
          const cells = BLOCKS.map((number) => ({
            number,
            node: cell(date, number, true),
          })).filter((one) => one.node !== null);
          if (cells.length === 0) return null;
          return (
            <div key={date}>
              <h3 className="mb-2 text-sm font-semibold">{formatDay(date)}</h3>
              <div className="flex flex-col gap-2">
                {cells.map((one) => (
                  <Fragment key={one.number}>{one.node}</Fragment>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function AfternoonBreak() {
  return (
    <tr>
      <td colSpan={DAYS.length + 1} className="py-1">
        <div className="flex items-center gap-2">
          <span className="h-px w-6 bg-line" />
          <span className="text-[0.65rem] font-bold tracking-[0.12em] text-ink-faint uppercase">
            Tarde
          </span>
          <span className="h-px flex-1 bg-line" />
        </div>
      </td>
    </tr>
  );
}

function WeekButton({
  label,
  to,
  onWeek,
  children,
}: {
  label: string;
  to: string | undefined;
  onWeek: (monday: string) => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={to === undefined}
      onClick={() => to && onWeek(to)}
      className="grid size-9 place-items-center rounded-xl border border-line text-ink hover:bg-lilac-50 disabled:text-ink-faint disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}
