import { Pin } from "lucide-react";
import { useState } from "react";
import type {
  Block,
  Presentation,
  PresentationsPayload,
  Slot,
} from "./api/types.ts";
import { blockLabel, formatDay, roundLabel, trackLabel } from "./labels.ts";
import { Modal, Section, StateChip } from "./ui.tsx";
import { WeekGrid } from "./weekgrid.tsx";
import { ended, openingWeek, weeksOf } from "./weeks.ts";

/**
 * Every team's slot, a week at a time (`WeekGrid`). The arrows go only to
 * weeks that have blocks.
 *
 * Only waiting teams have a slot (`estimate`): one that already presented has
 * none, so a past slot shows dimmed and empty.
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
  return (
    <Section>
      <WeekGrid
        title="Fechas de presentación"
        week={week}
        onWeek={setWeek}
        prev={weeks[index - 1]}
        next={weeks[index + 1]}
        cell={(date, number, labelled) => {
          const block = data.blocks.find(
            (one) => one.date === date && one.block === number,
          );
          return block ? (
            <BlockCard
              block={block}
              label={labelled ? blockLabel(block.block) : undefined}
              seated={seated}
              mine={mine}
              now={now}
              onOpen={setOpen}
            />
          ) : null;
        }}
      />
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

/** Who is in a slot: the team, the slot it holds, and its members. */
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
    <Modal
      eyebrow={roundLabel(row.round)}
      title={row.name ?? "—"}
      onClose={onClose}
    >
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
        <p className="mt-2 text-sm text-ink-muted">Sin integrantes cargados.</p>
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
    </Modal>
  );
}
