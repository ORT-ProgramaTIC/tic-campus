import {
  CalendarDays,
  Clock,
  Hash,
  Info,
  Pin,
  Radio,
  RotateCcw,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { useMe, usePresentations } from "./api/queries.ts";
import type {
  Presentation,
  PresentationsPayload,
  PresentationState,
} from "./api/types.ts";
import { blockLabel, formatDay, roundLabel } from "./labels.ts";
import { useOffering } from "./router.tsx";
import { Timetable } from "./timetable.tsx";
import { StateChip } from "./ui.tsx";

/** The student page: who you are, and when your team presents. */
export function Presentaciones() {
  const offering = useOffering();
  const me = useMe().data!.me;
  const query = usePresentations(offering.offeringId);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-muted">
          {offering.subjectName} · {offering.courseNames.join(" + ")} ·{" "}
          {offering.year}
        </p>
        <h1 className="mt-1 text-2xl font-semibold sm:text-3xl">
          Hola, {me.given_name ?? me.name ?? ""}
        </h1>
      </div>
      {query.isPending ? (
        <div className="h-52 animate-pulse rounded-3xl bg-card" />
      ) : query.isError ? (
        <Notice>{query.error.message}</Notice>
      ) : (
        <>
          <Banners data={query.data} staff={offering.can.manageOffering} />
          <Timetable data={query.data} />
        </>
      )}
    </div>
  );
}

/** One banner per round the caller's team is queued in. */
function Banners({
  data,
  staff,
}: {
  data: PresentationsPayload;
  staff: boolean;
}) {
  const rows = data.presentations
    .filter((row) => data.mine.includes(row.projectId))
    .sort((a, b) => a.round - b.round);

  if (rows.length > 0) {
    return rows.map((row) => <TeamBanner key={row.id} row={row} data={data} />);
  }
  if (staff) return null;
  if (data.mine.length === 0) {
    return (
      <Notice>
        Todavía no estás en ningún grupo de esta materia. Si es un error,
        avisale a tu profe.
      </Notice>
    );
  }
  const names = data.teams
    .filter((team) => data.mine.includes(team.projectId))
    .map((team) => team.name)
    .join(", ");
  return (
    <Notice>
      Tu grupo, {names}, todavía no está en el orden de presentación.
    </Notice>
  );
}

const FINISHED: PresentationState[] = [
  "presented",
  "passed",
  "failed",
  "absent",
];

function TeamBanner({
  row,
  data,
}: {
  row: Presentation;
  data: PresentationsPayload;
}) {
  const estimate = row.estimate;
  const block = data.blocks.find((one) => one.id === estimate?.blockId);
  const finished = FINISHED.includes(row.state);

  return (
    <section className="rounded-3xl border border-line bg-card p-6 sm:p-8">
      <div className="flex flex-wrap items-center gap-4">
        <Circle icon={Users} tone="bg-lilac-50 text-lilac-700" />
        <div className="mr-auto min-w-40 flex-1">
          <p className="text-sm text-ink-muted">Tu grupo</p>
          <h2 className="truncate text-2xl font-semibold">{row.name ?? "—"}</h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-canvas px-3 py-1 text-sm text-ink-muted">
            {roundLabel(row.round)}
          </span>
          <StateChip state={row.state} />
        </div>
      </div>

      {estimate && block && (
        <dl className="mt-6 grid gap-4 border-t border-line pt-6 sm:grid-cols-3 sm:gap-6">
          <Tile
            icon={CalendarDays}
            tone="bg-sky-soft text-sky-600"
            label="Fecha estimada"
            value={formatDay(estimate.date)}
          />
          <Tile
            icon={Hash}
            tone="bg-peach-soft text-orange-500"
            label="Bloque"
            value={blockLabel(block.block)}
          />
          <Tile
            icon={Clock}
            tone="bg-mint-soft text-emerald-600"
            label="Horario"
            value={`${estimate.start} – ${estimate.end}`}
          />
        </dl>
      )}

      <Note row={row} finished={finished} />
    </section>
  );
}

/** The one sentence under the tiles: why this slot, or why none. */
function Note({ row, finished }: { row: Presentation; finished: boolean }) {
  const line = (icon: LucideIcon, text: string) => {
    const Icon = icon;
    return (
      <p className="mt-6 flex items-start gap-2 text-sm text-ink-muted">
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
        {text}
      </p>
    );
  };
  if (finished) return line(Info, "Ya pasaron por esta ronda.");
  if (row.state === "presenting")
    return line(Radio, "Están presentando ahora.");
  if (!row.estimate) {
    return line(
      Info,
      "Todavía no tienen turno: faltan fechas en el cronograma.",
    );
  }
  if (row.pinMissed) {
    return line(
      RotateCcw,
      "Su turno fijo pasó sin que presentaran, así que volvieron a la fila.",
    );
  }
  if (row.estimate.pinned) return line(Pin, "Turno fijado por tu profe.");
  return line(
    Info,
    "Es una estimación: se mueve si otros grupos presentan antes, o no presentan.",
  );
}

function Circle({ icon: Icon, tone }: { icon: LucideIcon; tone: string }) {
  return (
    <span
      className={`grid size-12 shrink-0 place-items-center rounded-full ${tone}`}
    >
      <Icon className="size-5" aria-hidden />
    </span>
  );
}

function Tile({
  icon,
  tone,
  label,
  value,
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-4">
      <Circle icon={icon} tone={tone} />
      <div>
        <dt className="text-sm text-ink-muted">{label}</dt>
        <dd className="text-lg font-semibold">{value}</dd>
      </div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-3xl border border-line bg-card p-6 text-ink-muted">
      {children}
    </p>
  );
}
