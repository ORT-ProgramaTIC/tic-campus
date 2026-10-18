import { ChevronLeft, ChevronRight, Pin, X } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import type {
  Block,
  Presentation,
  PresentationsPayload,
  Slot,
} from "./api/types.ts";
import { blockLabel, formatDay, roundLabel, trackLabel } from "./labels.ts";
import { StateChip } from "./ui.tsx";
import { addDays, ended, openingWeek, weeksOf } from "./weeks.ts";

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
 * Every team's slot, a week at a time, on tic-registry's grid: Monday to
 * Friday by blocks 1–6, the afternoon break drawn and labelled. A phone gets
 * the week's days as a list instead.
 *
 * Only waiting teams have a slot (`estimate`): one that already presented has
 * none, so a past slot shows dimmed and empty — the results are the order
 * table's.
 */
export function Timetable({ data }: { data: PresentationsPayload }) {
  const now = new Date();
  const weeks = weeksOf(data.blocks);
  const [chosen, setWeek] = useState<string>();
  const [open, setOpen] = useState<Presentation>();
  const week = chosen ?? openingWeek(data.blocks, now);

  // Who sits in each slot, by `blockId/slot`.
  const seated = new Map<string, Presentation>();
  for (const row of data.presentations) {
    if (row.estimate) {
      seated.set(`${row.estimate.blockId}/${row.estimate.slot}`, row);
    }
  }
  const mine = new Set(data.mine);

  if (week === undefined) {
    return (
      <Section>
        <p className="text-ink-muted">Todavía no hay fechas de presentación.</p>
      </Section>
    );
  }

  const index = weeks.indexOf(week);
  const dates = DAYS.map((_, day) => addDays(week, day));
  const blockAt = (date: string, number: number) =>
    data.blocks.find((block) => block.date === date && block.block === number);
  const card = (block: Block, label?: string) => (
    <BlockCard
      block={block}
      label={label}
      seated={seated}
      mine={mine}
      now={now}
      onOpen={setOpen}
    />
  );

  return (
    <Section>
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto">
          <h2 className="text-lg font-semibold">Fechas de presentación</h2>
          <p className="text-sm text-ink-muted">{weekTitle(week)}</p>
        </div>
        <div className="flex gap-1">
          <WeekButton
            label="Semana anterior"
            disabled={index <= 0}
            onClick={() => setWeek(weeks[index - 1])}
          >
            <ChevronLeft className="size-4" aria-hidden />
          </WeekButton>
          <WeekButton
            label="Semana siguiente"
            disabled={index >= weeks.length - 1}
            onClick={() => setWeek(weeks[index + 1])}
          >
            <ChevronRight className="size-4" aria-hidden />
          </WeekButton>
        </div>
      </div>

      {/* The grid. `table-fixed`: five equal days, whatever is in them. */}
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
                {dates.map((date) => {
                  const block = blockAt(date, number);
                  return (
                    <td key={date} className="align-top">
                      {block ? (
                        card(block)
                      ) : (
                        <div className="h-12 rounded-xl border border-dashed border-line" />
                      )}
                    </td>
                  );
                })}
              </tr>
            </Fragment>
          ))}
        </tbody>
      </table>

      {/* The phone: only the days with blocks. */}
      <div className="mt-6 flex flex-col gap-5 md:hidden">
        {dates.map((date) => {
          const blocks = data.blocks
            .filter((block) => block.date === date)
            .sort((a, b) => a.block - b.block);
          if (blocks.length === 0) return null;
          return (
            <div key={date}>
              <h3 className="mb-2 text-sm font-semibold">{formatDay(date)}</h3>
              <div className="flex flex-col gap-2">
                {blocks.map((block) => (
                  <Fragment key={block.id}>
                    {card(block, blockLabel(block.block))}
                  </Fragment>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {open && (
        <TeamDialog row={open} data={data} onClose={() => setOpen(undefined)} />
      )}
    </Section>
  );
}

/** One presentation block: its round, then a line per slot. */
function BlockCard({
  block,
  label,
  seated,
  mine,
  now,
  onOpen,
}: {
  block: Block;
  label?: string;
  seated: Map<string, Presentation>;
  mine: Set<number>;
  now: Date;
  onOpen: (row: Presentation) => void;
}) {
  return (
    <div className="rounded-xl bg-lilac-50 p-2">
      <p className="px-1.5 pb-1 text-xs font-medium text-lilac-700">
        {label && `${label} · `}
        {roundLabel(block.round)}
      </p>
      <ul className="flex flex-col gap-0.5">
        {block.slots.map((slot) => (
          <SlotLine
            key={slot.slot}
            slot={slot}
            team={seated.get(`${block.id}/${slot.slot}`)}
            mine={mine}
            now={now}
            onOpen={onOpen}
          />
        ))}
      </ul>
    </div>
  );
}

function SlotLine({
  slot,
  team,
  mine,
  now,
  onOpen,
}: {
  slot: Slot;
  team: Presentation | undefined;
  mine: Set<number>;
  now: Date;
  onOpen: (row: Presentation) => void;
}) {
  const time = (
    <span className="w-10 shrink-0 text-ink-muted tabular-nums">
      {slot.start}
    </span>
  );
  const line = "flex items-center gap-1.5 rounded-lg px-1.5 py-1 text-sm";

  if (slot.skipped) {
    return (
      <li className={`${line} text-ink-faint line-through`}>
        {time}
        sin turno
      </li>
    );
  }
  if (!team) {
    return (
      <li className={`${line} text-ink-faint`}>
        {time}
        {ended(slot, now) ? "—" : "libre"}
      </li>
    );
  }
  const ours = mine.has(team.projectId);
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpen(team)}
        className={`${line} w-full text-left hover:ring-1 hover:ring-lilac-300 ${
          ours ? "bg-lilac-100 font-semibold" : "bg-card"
        }`}
      >
        {time}
        <span className="min-w-0 truncate" title={team.name ?? undefined}>
          {team.name ?? "—"}
        </span>
        {team.estimate?.pinned && (
          <Pin
            className="size-3.5 shrink-0 text-lilac-700"
            aria-label="Turno fijado"
          />
        )}
        {team.state === "presenting" && (
          <span className="ml-auto rounded-full bg-lilac-500 px-1.5 text-xs font-medium text-white">
            ahora
          </span>
        )}
      </button>
    </li>
  );
}

/**
 * Who is in a slot: the team, the slot it holds, and its members. A native
 * modal `<dialog>` — Escape closes it by itself, and so does a click on the
 * backdrop, which is the dialog element itself (the content is a child).
 */
function TeamDialog({
  row,
  data,
  onClose,
}: {
  row: Presentation;
  data: PresentationsPayload;
  onClose: () => void;
}) {
  const estimate = row.estimate;
  const block = data.blocks.find((one) => one.id === estimate?.blockId);
  const members =
    data.teams.find((team) => team.projectId === row.projectId)?.members ?? [];

  return (
    <dialog
      // StrictMode attaches refs twice; a second `showModal` on an open
      // dialog throws in older engines.
      ref={(element) => {
        if (element && !element.open) element.showModal();
      }}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
      aria-labelledby="equipo"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl bg-card p-0 text-ink shadow-xl backdrop:bg-onyx/40"
    >
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-ink-muted">{roundLabel(row.round)}</p>
            <h2 id="equipo" className="text-xl font-semibold break-words">
              {row.name ?? "—"}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Cerrar"
            onClick={(event) => event.currentTarget.closest("dialog")?.close()}
            className="grid size-9 shrink-0 place-items-center rounded-xl hover:bg-lilac-50"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <StateChip state={row.state} />
          {estimate?.pinned && (
            <span className="flex items-center gap-1 text-sm text-lilac-700">
              <Pin className="size-3.5" aria-hidden />
              Turno fijado
            </span>
          )}
        </div>

        {estimate && block && (
          <div className="mt-4 rounded-2xl bg-lilac-50 p-4">
            <p className="font-semibold">
              {formatDay(estimate.date)}, {blockLabel(block.block)}
            </p>
            <p className="text-sm text-ink-muted tabular-nums">
              {estimate.start} – {estimate.end}
            </p>
          </div>
        )}

        <h3 className="mt-6 text-sm font-semibold">Integrantes</h3>
        {members.length === 0 ? (
          <p className="mt-2 text-sm text-ink-muted">
            Sin integrantes cargados.
          </p>
        ) : (
          <ul className="mt-2 flex flex-col gap-2">
            {members.map((member, index) => {
              const name = [member.name, member.surname]
                .filter(Boolean)
                .join(" ");
              return (
                <li key={index} className="flex items-center gap-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-lilac-100 text-xs font-semibold text-lilac-700">
                    {[member.name, member.surname]
                      .map((part) => part?.charAt(0).toUpperCase() ?? "")
                      .join("")}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate">{name || "—"}</p>
                    <p className="text-xs text-ink-muted">
                      {trackLabel(member.track)}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </dialog>
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
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="grid size-9 place-items-center rounded-xl border border-line text-ink hover:bg-lilac-50 disabled:text-ink-faint disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

function Section({ children }: { children: ReactNode }) {
  return (
    <section className="rounded-3xl border border-line bg-card p-6 sm:p-8">
      {children}
    </section>
  );
}
