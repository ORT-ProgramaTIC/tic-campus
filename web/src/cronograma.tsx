import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Info,
  X,
  Minus,
  Pin,
  Play,
  Plus,
  RotateCcw,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useBlocker } from "react-router";
import { ApiError } from "./api/client.ts";
import {
  usePresentations,
  usePreview,
  useSaveSchedule,
  useSetState,
} from "./api/queries.ts";
import type {
  Estimate,
  PresentationsPayload,
  PresentationState,
  Presentation,
  ScheduleBody,
  Slot,
  Team,
} from "./api/types.ts";
import {
  addBlock,
  addTeam,
  expandSlots,
  fromPayload,
  MAX_SLOTS,
  moveTeam,
  pin,
  removeBlock,
  removeTeam,
  setQueueStart,
  setSlotCount,
  setSlotStart,
  timesProblem,
  toBody,
  toggleSkip,
  type Draft,
  type DraftBlock,
} from "./draft.ts";
import {
  blockLabel,
  formatDay,
  fullName,
  roundLabel,
  STATE_LABEL,
  STATE_TONE,
  surnames,
} from "./labels.ts";
import { useOffering } from "./router.tsx";
import { MemberList, Modal, Section } from "./ui.tsx";
import { WeekGrid } from "./weekgrid.tsx";
import { addDays, mondayOf, openingWeek } from "./weeks.ts";

/** The teacher page: the schedule as a draft, the grid as its editor, the
 *  queue beside it, and one save. */
export function Cronograma() {
  const offering = useOffering();
  const query = usePresentations(offering.offeringId);
  if (query.isPending) {
    return <div className="h-96 animate-pulse rounded-3xl bg-card" />;
  }
  if (query.isError) {
    return (
      <Section>
        <p className="text-ink-muted">{query.error.message}</p>
      </Section>
    );
  }
  return (
    <Editor
      // A rotation switch is another schedule: start its draft from scratch.
      key={offering.offeringId}
      payload={query.data}
      refetch={async () => (await query.refetch()).data}
    />
  );
}

/** `Slot` plus what the grid draws on it. */
interface Placement {
  estimate: Estimate | null;
  pinMissed: boolean;
  state: PresentationState;
}

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];
const weekday = (date: string) =>
  WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()];
/** Today in Buenos Aires, at the api's fixed −03:00. */
const today = () =>
  new Date(Date.now() - 3 * 3_600_000).toISOString().slice(0, 10);

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function Editor({
  payload,
  refetch,
}: {
  payload: PresentationsPayload;
  refetch: () => Promise<PresentationsPayload | undefined>;
}) {
  const offering = useOffering();
  const bell = payload.bell!;
  const classBlocks = payload.classBlocks!;

  /* ── The draft, and whether it differs from what is saved ── */

  const [draft, setDraft] = useState<Draft>(() => fromPayload(payload));
  const [pristine, setPristine] = useState(() =>
    JSON.stringify(fromPayload(payload)),
  );
  const [base, setBase] = useState(payload.savedAt);
  const dirty = JSON.stringify(draft) !== pristine;

  const reset = (next: PresentationsPayload) => {
    const fresh = fromPayload(next);
    setDraft(fresh);
    setPristine(JSON.stringify(fresh));
    setBase(next.savedAt);
  };
  // A save from here or elsewhere: a clean draft follows it; a dirty one is
  // kept, and its save will meet the 409.
  const seen = useRef(payload.savedAt);
  useEffect(() => {
    if (payload.savedAt === seen.current) return;
    seen.current = payload.savedAt;
    if (!dirty) reset(payload);
  }, [payload]);

  /* ── The preview: where teams land with the draft as it is ── */

  const problems = new Map(
    draft.blocks
      .map((block) => [block.id, timesProblem(block, bell)] as const)
      .filter((pair): pair is [string, string] => pair[1] !== null),
  );
  const body: ScheduleBody | null =
    dirty && problems.size === 0 ? toBody(draft, base) : null;
  const asked = useDebounced(body, 300);
  const preview = usePreview(offering.offeringId, asked);
  const rows: (Placement & { projectId: number; round: number })[] = dirty
    ? (preview.data?.presentations ?? [])
    : payload.presentations;
  const placed = new Map(
    rows.map((row) => [`${row.round}/${row.projectId}`, row]),
  );
  const calculating =
    dirty &&
    (preview.isFetching || JSON.stringify(asked) !== JSON.stringify(body));
  // Who sits in each slot, by `blockId/slot`.
  const seated = new Map<string, number>();
  for (const row of rows) {
    if (row.estimate) {
      seated.set(`${row.estimate.blockId}/${row.estimate.slot}`, row.projectId);
    }
  }
  const teams = new Map(payload.teams.map((team) => [team.projectId, team]));
  const teamOf = (projectId: number) => teams.get(projectId);
  const [info, setInfo] = useState<{ projectId: number; round: number }>();

  /* ── Saving, and not leaving with it unsaved ── */

  const save = useSaveSchedule(offering.offeringId);
  const stale =
    save.error instanceof ApiError && save.error.code === "stale_schedule";
  const onSave = () => {
    const sent = draft;
    save.mutate(toBody(sent, base), {
      onSuccess: ({ savedAt }) => {
        setPristine(JSON.stringify(sent));
        setBase(savedAt);
      },
    });
  };
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  useEffect(() => {
    if (blocker.state !== "blocked") return;
    if (window.confirm("Hay cambios sin guardar. ¿Salir igual?")) {
      blocker.proceed();
    } else {
      blocker.reset();
    }
  }, [blocker]);
  useEffect(() => {
    if (!dirty) return;
    const hold = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, [dirty]);

  /* ── Rounds, weeks, and which dialog is open ── */

  const [round, setRound] = useState(1);
  const rounds = [
    ...new Set([
      1,
      round,
      ...draft.blocks.map((block) => block.round),
      ...draft.queue.map((entry) => entry.round),
    ]),
  ].sort((a, b) => a - b);
  const [week, setWeek] = useState(
    () => openingWeek(payload.blocks, new Date()) ?? mondayOf(today()),
  );
  const [editing, setEditing] = useState<
    { blockId: string; slot?: number } | undefined
  >();
  const edit = (change: (draft: Draft) => Draft) => {
    save.reset();
    setDraft(change);
  };

  const meets = (date: string, number: number) =>
    Number(date.slice(0, 4)) === offering.year &&
    classBlocks.some(
      (one) => one.day === weekday(date) && one.block === number,
    );
  const queueStart = (r: number) =>
    draft.queueStarts.find((one) => one.round === r);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end gap-4">
        <div className="mr-auto">
          <p className="text-sm text-ink-muted">
            {offering.subjectName} · {offering.courseNames.join(" + ")} ·{" "}
            {offering.year}
          </p>
          <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">
            Cronograma
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-ink-muted" aria-live="polite">
            {save.isPending
              ? "Guardando…"
              : dirty
                ? calculating
                  ? "Calculando…"
                  : "Cambios sin guardar"
                : "Guardado"}
          </span>
          <button
            type="button"
            onClick={onSave}
            disabled={!dirty || save.isPending || problems.size > 0}
            className="rounded-xl bg-lilac-300 px-5 py-2.5 font-medium text-ink hover:bg-lilac-500 hover:text-white disabled:bg-lilac-100 disabled:text-ink-faint"
          >
            Guardar
          </button>
        </div>
      </div>

      {stale ? (
        <Banner>
          Alguien guardó el cronograma mientras lo editabas.{" "}
          <button
            type="button"
            className="font-semibold underline"
            onClick={async () => {
              const fresh = await refetch();
              if (fresh) reset(fresh);
              save.reset();
            }}
          >
            Recargar
          </button>{" "}
          (se pierden tus cambios).
        </Banner>
      ) : save.error ? (
        <Banner>{save.error.message}</Banner>
      ) : preview.error && dirty ? (
        <Banner>{preview.error.message}</Banner>
      ) : null}

      <div role="tablist" className="flex flex-wrap gap-2">
        {rounds.map((one) => (
          <button
            key={one}
            type="button"
            role="tab"
            aria-selected={one === round}
            onClick={() => setRound(one)}
            className={`rounded-xl px-4 py-2 text-sm font-medium ${
              one === round
                ? "bg-onyx text-white"
                : "border border-line bg-card text-ink-muted hover:text-ink"
            }`}
          >
            {roundLabel(one)}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setRound(Math.max(...rounds) + 1)}
          className="flex items-center gap-1 rounded-xl border border-dashed border-line px-3 py-2 text-sm text-ink-muted hover:text-ink"
        >
          <Plus className="size-4" aria-hidden />
          Ronda
        </button>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <Section className="min-w-0">
          <WeekGrid
            title="Bloques"
            week={week}
            onWeek={setWeek}
            prev={addDays(week, -7)}
            next={addDays(week, 7)}
            cell={(date, number, labelled) => {
              const block = draft.blocks.find(
                (one) => one.date === date && one.block === number,
              );
              if (block) {
                return (
                  <EditBlock
                    block={block}
                    slots={expandSlots(block, bell)}
                    label={labelled ? blockLabel(block.block) : undefined}
                    current={block.round === round}
                    start={queueStart(block.round)}
                    seated={seated}
                    teamOf={teamOf}
                    pinned={draft.queue}
                    problem={problems.get(block.id)}
                    onBlock={() => setEditing({ blockId: block.id })}
                    onSlot={(slot) => setEditing({ blockId: block.id, slot })}
                  />
                );
              }
              if (!meets(date, number)) return null;
              return (
                <button
                  type="button"
                  onClick={() =>
                    edit((d) =>
                      addBlock(d, {
                        id: crypto.randomUUID(),
                        round,
                        date,
                        block: number,
                      }),
                    )
                  }
                  className="flex h-12 w-full items-center justify-center gap-1 rounded-xl border border-dashed border-lilac-300 text-sm text-lilac-700 hover:bg-lilac-50"
                >
                  <Plus className="size-4" aria-hidden />
                  {labelled ? `${blockLabel(number)} · ` : ""}
                  {roundLabel(round)}
                </button>
              );
            }}
          />
        </Section>

        <Queue
          round={round}
          draft={draft}
          edit={edit}
          placed={placed}
          saved={payload.presentations}
          teams={payload.teams}
          teamOf={teamOf}
          onInfo={(projectId) => setInfo({ projectId, round })}
        />
      </div>

      {info && (
        <Modal
          eyebrow={roundLabel(info.round)}
          title={teamOf(info.projectId)?.name ?? "Grupo eliminado"}
          onClose={() => setInfo(undefined)}
        >
          <MemberList members={teamOf(info.projectId)?.members ?? []} />
        </Modal>
      )}

      {editing &&
        (() => {
          const block = draft.blocks.find((one) => one.id === editing.blockId);
          if (!block) return null;
          const close = () => setEditing(undefined);
          if (editing.slot === undefined) {
            return (
              <BlockDialog
                block={block}
                onCount={(count) =>
                  edit((d) => setSlotCount(d, block.id, count))
                }
                onDelete={() => {
                  edit((d) => removeBlock(d, block.id));
                  close();
                }}
                onClose={close}
              />
            );
          }
          const slot = expandSlots(block, bell)[editing.slot - 1];
          if (!slot) return null;
          return (
            <SlotDialog
              block={block}
              slot={slot}
              bell={bell[block.block]!}
              draft={draft}
              seated={(() => {
                const id = seated.get(`${block.id}/${slot.slot}`);
                return id === undefined ? undefined : teams.get(id);
              })()}
              teamOf={teamOf}
              problem={problems.get(block.id)}
              edit={edit}
              onClose={close}
            />
          );
        })()}
    </div>
  );
}

const WEEKDAY = new Intl.DateTimeFormat("es-AR", {
  weekday: "short",
  timeZone: "UTC",
});
/** `2026-10-21` → `mié 21/10`. Built by hand: es-AR's numeric date is
 *  `21-10`. */
const shortDay = (date: string) =>
  `${WEEKDAY.format(new Date(`${date}T00:00:00Z`))} ${Number(date.slice(8))}/${Number(date.slice(5, 7))}`;

/** A team in a `<select>`: the project, then its members. */
const optionLabel = (team: Team | undefined) =>
  team && team.members.length > 0
    ? `${team.name} — ${surnames(team)}`
    : surnames(team);

function Banner({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-2xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 ring-inset">
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

/** A block in the editor: a button for the block's own settings, then one
 *  button per slot. Another round's block is drawn faded, still editable. */
function EditBlock({
  block,
  slots,
  label,
  current,
  start,
  seated,
  teamOf,
  pinned,
  problem,
  onBlock,
  onSlot,
}: {
  block: DraftBlock;
  slots: Slot[];
  label?: string;
  current: boolean;
  start: { blockId: string; slot: number } | undefined;
  seated: Map<string, number>;
  teamOf: (projectId: number) => Team | undefined;
  pinned: Draft["queue"];
  problem: string | undefined;
  onBlock: () => void;
  onSlot: (slot: number) => void;
}) {
  // Slots before the round's start are the queue's to skip: pins only.
  const startAt = start?.blockId === block.id ? start.slot : undefined;
  return (
    <div
      className={`rounded-xl bg-lilac-50 p-2 ${current ? "" : "opacity-55"}`}
    >
      <button
        type="button"
        onClick={onBlock}
        className="flex w-full items-center gap-1 rounded-lg px-1.5 pb-1 text-left text-xs font-medium text-lilac-700 hover:bg-lilac-100"
      >
        <span className="min-w-0 flex-1 truncate">
          {label && `${label} · `}
          {roundLabel(block.round)}
        </span>
        <Settings2
          className="size-3.5 shrink-0"
          aria-label="Ajustes del bloque"
        />
      </button>
      <ul className="flex flex-col gap-0.5">
        {slots.map((slot) => {
          const who = seated.get(`${block.id}/${slot.slot}`);
          const fixed = pinned.some(
            (entry) =>
              entry.pin?.blockId === block.id && entry.pin.slot === slot.slot,
          );
          return (
            <li key={slot.slot}>
              <button
                type="button"
                onClick={() => onSlot(slot.slot)}
                className={`flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-left text-sm hover:ring-1 hover:ring-lilac-300 ${
                  slot.skipped || who === undefined ? "" : "bg-card"
                }`}
              >
                <span
                  className={`w-10 shrink-0 tabular-nums ${
                    slot.overridden ? "text-lilac-700" : "text-ink-muted"
                  }`}
                >
                  {slot.start}
                </span>
                {slot.skipped ? (
                  <span className="whitespace-nowrap text-ink-faint line-through">
                    sin turno
                  </span>
                ) : who !== undefined ? (
                  <span
                    className="min-w-0 truncate"
                    title={surnames(teamOf(who))}
                  >
                    {teamOf(who)?.name ?? "Grupo eliminado"}
                  </span>
                ) : (
                  <span className="whitespace-nowrap text-ink-faint">
                    libre
                  </span>
                )}
                <span className="ml-auto flex shrink-0 items-center gap-1">
                  {fixed && (
                    <Pin
                      className="size-3.5 text-lilac-700"
                      aria-label="Turno fijado"
                    />
                  )}
                  {startAt === slot.slot && (
                    <Play
                      className="size-3.5 fill-current text-lilac-700"
                      aria-label="La cola empieza acá"
                    />
                  )}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {problem && <p className="mt-1 px-1.5 text-xs text-red-600">{problem}</p>}
    </div>
  );
}

function BlockDialog({
  block,
  onCount,
  onDelete,
  onClose,
}: {
  block: DraftBlock;
  onCount: (count: number) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <Modal
      eyebrow={roundLabel(block.round)}
      title={`${formatDay(block.date)}, ${blockLabel(block.block)}`}
      onClose={onClose}
    >
      <div className="mt-6 flex items-center justify-between gap-4">
        <span className="font-medium">Turnos</span>
        <div className="flex items-center gap-2">
          <StepButton
            label="Un turno menos"
            disabled={block.slotCount <= 1}
            onClick={() => onCount(block.slotCount - 1)}
          >
            <Minus className="size-4" aria-hidden />
          </StepButton>
          <span className="w-6 text-center text-lg font-semibold tabular-nums">
            {block.slotCount}
          </span>
          <StepButton
            label="Un turno más"
            disabled={block.slotCount >= MAX_SLOTS}
            onClick={() => onCount(block.slotCount + 1)}
          >
            <Plus className="size-4" aria-hidden />
          </StepButton>
        </div>
      </div>
      <p className="mt-2 text-sm text-ink-muted">
        Cada turno dura 20 minutos y lo que sobra del bloque queda de margen.
        Cambiar la cantidad reparte el bloque de nuevo: los horarios vuelven a
        automático, los turnos quitados vuelven, y se sueltan los grupos fijados
        en turnos que dejan de existir.
      </p>
      <button
        type="button"
        onClick={onDelete}
        className="mt-6 flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
      >
        <Trash2 className="size-4" aria-hidden />
        Eliminar bloque
      </button>
    </Modal>
  );
}

function StepButton({
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
      className="grid size-9 place-items-center rounded-xl border border-line hover:bg-lilac-50 disabled:text-ink-faint disabled:hover:bg-transparent"
    >
      {children}
    </button>
  );
}

/** One slot: who is fixed to it, when it starts, struck or not, and whether
 *  the round's queue starts here. Every change is a draft edit, live. */
function SlotDialog({
  block,
  slot,
  bell,
  draft,
  seated,
  teamOf,
  problem,
  edit,
  onClose,
}: {
  block: DraftBlock;
  slot: Slot;
  bell: { start: string; end: string };
  draft: Draft;
  seated: Team | undefined;
  teamOf: (projectId: number) => Team | undefined;
  problem: string | undefined;
  edit: (change: (draft: Draft) => Draft) => void;
  onClose: () => void;
}) {
  const here = { blockId: block.id, slot: slot.slot };
  const entries = draft.queue.filter((entry) => entry.round === block.round);
  const holder = entries.find(
    (entry) => entry.pin?.blockId === block.id && entry.pin.slot === slot.slot,
  );
  const isStart = draft.queueStarts.some(
    (one) =>
      one.round === block.round &&
      one.blockId === block.id &&
      one.slot === slot.slot,
  );

  return (
    <Modal
      eyebrow={`${roundLabel(block.round)} · turno ${slot.slot}`}
      title={`${formatDay(block.date)}, ${blockLabel(block.block)}`}
      onClose={onClose}
    >
      <div className="mt-4 rounded-2xl bg-lilac-50 p-4">
        <p className="font-semibold tabular-nums">
          {slot.start} – {slot.end}
        </p>
        <p className="text-sm text-ink-muted">
          {slot.skipped
            ? "Quitado: no presenta nadie."
            : seated
              ? `${holder ? "Fijado" : "Según la cola"}: ${seated.name}`
              : "Libre"}
        </p>
        {seated && !slot.skipped && seated.members.length > 0 && (
          <p className="text-xs text-ink-faint">{surnames(seated)}</p>
        )}
      </div>

      <label className="mt-6 block">
        <span className="text-sm font-medium">Grupo fijo</span>
        <select
          value={holder?.projectId ?? ""}
          disabled={slot.skipped}
          onChange={(event) => {
            const value = event.target.value;
            edit((d) =>
              value === ""
                ? holder
                  ? pin(d, holder.projectId, block.round, null)
                  : d
                : pin(d, Number(value), block.round, here),
            );
          }}
          className="mt-1 w-full rounded-xl border border-line bg-card px-3 py-2 disabled:text-ink-faint"
        >
          <option value="">Ninguno: lo llena la cola</option>
          {entries.map((entry) => (
            <option key={entry.projectId} value={entry.projectId}>
              {optionLabel(teamOf(entry.projectId))}
              {entry.pin && entry !== holder ? " (fijo en otro turno)" : ""}
            </option>
          ))}
        </select>
        {entries.length === 0 && (
          <span className="mt-1 block text-xs text-ink-muted">
            Agregá grupos a la {roundLabel(block.round)} para fijarlos.
          </span>
        )}
      </label>

      <div className="mt-4">
        <span className="text-sm font-medium">Empieza a las</span>
        <div className="mt-1 flex items-center gap-2">
          <input
            type="time"
            step={60}
            min={bell.start}
            max={bell.end}
            value={slot.start}
            onChange={(event) =>
              edit((d) =>
                setSlotStart(
                  d,
                  block.id,
                  slot.slot,
                  event.target.value || null,
                ),
              )
            }
            className="rounded-xl border border-line bg-card px-3 py-2 tabular-nums"
          />
          {slot.overridden && (
            <button
              type="button"
              onClick={() =>
                edit((d) => setSlotStart(d, block.id, slot.slot, null))
              }
              className="flex items-center gap-1 rounded-xl px-3 py-2 text-sm text-ink-muted hover:bg-lilac-50 hover:text-ink"
            >
              <RotateCcw className="size-4" aria-hidden />
              Automático
            </button>
          )}
        </div>
        {problem && <p className="mt-1 text-sm text-red-600">{problem}</p>}
      </div>

      <div className="mt-6 flex flex-col gap-3">
        <Toggle
          checked={slot.skipped}
          onChange={() => edit((d) => toggleSkip(d, block.id, slot.slot))}
          label="Quitar este turno"
          hint="Para un acto o un evento: queda tachado y no presenta nadie."
        />
        <Toggle
          checked={isStart}
          onChange={() =>
            edit((d) => setQueueStart(d, block.round, isStart ? null : here))
          }
          label={`La cola de la ${roundLabel(block.round)} empieza acá`}
          hint="Los turnos anteriores quedan solo para grupos fijos."
        />
      </div>
    </Modal>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex items-start gap-3">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="mt-1 size-4 accent-lilac-500"
      />
      <span>
        <span className="block font-medium">{label}</span>
        <span className="block text-sm text-ink-muted">{hint}</span>
      </span>
    </label>
  );
}

const FINISHED: PresentationState[] = [
  "presented",
  "passed",
  "failed",
  "absent",
];

/**
 * A round's order: drag (from the handle) or ↑↓ to reorder, add the teams not
 * in it yet, take one out. Each row says where the team lands — the preview's
 * answer while editing — and carries its state, which saves on its own
 * (`PATCH`, never the draft): only a saved row has the id it needs.
 */
function Queue({
  round,
  draft,
  edit,
  placed,
  saved,
  teams,
  teamOf,
  onInfo,
}: {
  round: number;
  draft: Draft;
  edit: (change: (draft: Draft) => Draft) => void;
  placed: Map<string, Placement>;
  saved: Presentation[];
  teams: Team[];
  teamOf: (projectId: number) => Team | undefined;
  onInfo: (projectId: number) => void;
}) {
  const offering = useOffering();
  const setState = useSetState(offering.offeringId);
  const line = draft.queue.filter((entry) => entry.round === round);
  const missing = teams.filter(
    (team) => !line.some((entry) => entry.projectId === team.projectId),
  );
  const rowOf = new Map(
    saved
      .filter((row) => row.round === round)
      .map((row) => [row.projectId, row]),
  );
  // Native drag, armed from the handle only, so the row's select and buttons
  // stay ordinary controls.
  const [armed, setArmed] = useState<number>();
  const [dragging, setDragging] = useState<number>();
  const [over, setOver] = useState<number>();
  const move = (from: number, to: number) =>
    edit((d) => moveTeam(d, round, from, to));

  return (
    <Section>
      <h2 className="text-lg font-semibold">Orden · {roundLabel(round)}</h2>
      {line.length === 0 && (
        <p className="mt-4 text-sm text-ink-muted">
          Todavía no hay grupos en esta ronda.
        </p>
      )}
      <ol className="mt-4 flex flex-col gap-1.5">
        {line.map((entry, index) => {
          const at = placed.get(`${round}/${entry.projectId}`);
          const row = rowOf.get(entry.projectId);
          const state = row?.state ?? "pending";
          const team = teamOf(entry.projectId);
          const name = surnames(team);
          return (
            <li
              key={entry.projectId}
              draggable={armed === index}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                setDragging(index);
              }}
              onDragOver={(event) => {
                if (dragging === undefined) return;
                event.preventDefault();
                setOver(index);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragging !== undefined) move(dragging, index);
              }}
              onDragEnd={() => {
                setArmed(undefined);
                setDragging(undefined);
                setOver(undefined);
              }}
              className={`flex items-center gap-2 rounded-xl bg-canvas py-2 pr-2 pl-1 text-sm ${
                over === index && dragging !== index
                  ? "ring-2 ring-lilac-300"
                  : ""
              } ${dragging === index ? "opacity-50" : ""}`}
            >
              <span
                onPointerDown={() => setArmed(index)}
                onPointerUp={() =>
                  dragging === undefined && setArmed(undefined)
                }
                className="cursor-grab text-ink-faint active:cursor-grabbing"
                aria-hidden
              >
                <GripVertical className="size-4" />
              </span>
              <span className="w-5 text-right text-ink-faint tabular-nums">
                {index + 1}
              </span>
              {/* Name over state on a phone, side by side from `sm`. */}
              <div className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
                <div className="min-w-0 flex-1">
                  {/* Members first: they are who the teacher knows. */}
                  <p className="flex items-center gap-1 font-semibold">
                    <span
                      className="line-clamp-2"
                      title={team?.members.map(fullName).join(", ")}
                    >
                      {name}
                    </span>
                    {entry.pin && (
                      <Pin
                        className="size-3.5 shrink-0 text-lilac-700"
                        aria-label="Turno fijado"
                      />
                    )}
                  </p>
                  <p
                    className={`truncate text-[13px] ${at?.pinMissed ? "text-amber-700" : "text-ink-muted"}`}
                  >
                    {team && team.members.length > 0 && (
                      <span className="text-ink">{team.name} · </span>
                    )}
                    {at?.pinMissed && "Su turno fijo pasó · "}
                    {at?.estimate
                      ? `${shortDay(at.estimate.date)} · ${at.estimate.start}`
                      : FINISHED.includes(state)
                        ? "ya presentó"
                        : "sin turno"}
                  </p>
                </div>
                <select
                  value={state}
                  disabled={!row || setState.isPending}
                  title={row ? "Estado" : "Guardá para cambiarle el estado"}
                  aria-label={`Estado de ${name}`}
                  onChange={(event) =>
                    setState.mutate({
                      id: row!.id,
                      state: event.target.value as PresentationState,
                    })
                  }
                  className={`max-w-32 self-start rounded-full px-2 py-1 text-xs sm:self-auto font-medium ring-1 ring-inset disabled:opacity-60 ${STATE_TONE[state]}`}
                >
                  {(Object.keys(STATE_LABEL) as PresentationState[]).map(
                    (one) => (
                      <option key={one} value={one}>
                        {STATE_LABEL[one]}
                      </option>
                    ),
                  )}
                </select>
              </div>
              <button
                type="button"
                aria-label={`Integrantes de ${name}`}
                title="Integrantes"
                onClick={() => onInfo(entry.projectId)}
                className="grid size-7 shrink-0 place-items-center rounded-lg text-ink-muted hover:bg-lilac-50 hover:text-ink"
              >
                <Info className="size-4" aria-hidden />
              </button>
              <div className="flex flex-col">
                <button
                  type="button"
                  aria-label={`Subir a ${name}`}
                  disabled={index === 0}
                  onClick={() => move(index, index - 1)}
                  className="rounded text-ink-muted hover:text-ink disabled:text-line"
                >
                  <ChevronUp className="size-4" aria-hidden />
                </button>
                <button
                  type="button"
                  aria-label={`Bajar a ${name}`}
                  disabled={index === line.length - 1}
                  onClick={() => move(index, index + 1)}
                  className="rounded text-ink-muted hover:text-ink disabled:text-line"
                >
                  <ChevronDown className="size-4" aria-hidden />
                </button>
              </div>
              <button
                type="button"
                aria-label={`Sacar a ${name} de la ronda`}
                onClick={() => {
                  if (
                    FINISHED.includes(state) &&
                    !window.confirm(
                      `${name} ya tiene estado "${STATE_LABEL[state]}". Al guardar se pierde. ¿Sacarlo igual?`,
                    )
                  ) {
                    return;
                  }
                  edit((d) => removeTeam(d, entry.projectId, round));
                }}
                className="grid size-7 place-items-center rounded-lg text-ink-muted hover:bg-red-50 hover:text-red-600"
              >
                <X className="size-4" aria-hidden />
              </button>
            </li>
          );
        })}
      </ol>

      {missing.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <select
            value=""
            aria-label="Agregar grupo"
            onChange={(event) =>
              edit((d) => addTeam(d, Number(event.target.value), round))
            }
            className="min-w-0 flex-1 rounded-xl border border-line bg-card px-3 py-2 text-sm"
          >
            <option value="" disabled>
              Agregar grupo…
            </option>
            {missing.map((team) => (
              <option key={team.projectId} value={team.projectId}>
                {optionLabel(team)}
              </option>
            ))}
          </select>
          {missing.length > 1 && (
            <button
              type="button"
              onClick={() =>
                edit((d) =>
                  missing.reduce(
                    (acc, team) => addTeam(acc, team.projectId, round),
                    d,
                  ),
                )
              }
              className="rounded-xl px-3 py-2 text-sm font-medium text-lilac-700 hover:bg-lilac-50"
            >
              Agregar los {missing.length} que faltan
            </button>
          )}
        </div>
      )}
    </Section>
  );
}
