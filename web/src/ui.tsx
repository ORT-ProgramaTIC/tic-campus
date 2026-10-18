import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { Member, PresentationState } from "./api/types.ts";
import { fullName, STATE_LABEL, STATE_TONE, trackLabel } from "./labels.ts";

/** Pieces more than one screen draws. */

/** A team's members, with their track: the dialogs' "Integrantes". */
export function MemberList({ members }: { members: Member[] }) {
  return (
    <>
      <h3 className="mt-6 text-sm font-semibold">Integrantes</h3>
      {members.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">Sin integrantes cargados.</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {members.map((member, index) => (
            <li key={index} className="flex items-center gap-3">
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-lilac-100 text-xs font-semibold text-lilac-700">
                {[member.name, member.surname]
                  .map((part) => part?.charAt(0).toUpperCase() ?? "")
                  .join("")}
              </span>
              <div className="min-w-0">
                <p className="truncate">{fullName(member)}</p>
                <p className="text-xs text-ink-muted">
                  {trackLabel(member.track)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

export function StateChip({ state }: { state: PresentationState }) {
  return (
    <span
      className={`rounded-full px-3 py-1 text-sm font-medium ring-1 ring-inset ${STATE_TONE[state]}`}
    >
      {STATE_LABEL[state]}
    </span>
  );
}

/** The white card every panel sits in. */
export function Section({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-3xl border border-line bg-card p-6 sm:p-8 ${className}`}
    >
      {children}
    </section>
  );
}

/**
 * A native modal `<dialog>`, open while mounted: Escape closes it by itself,
 * and so does a click on the backdrop, which is the dialog element itself
 * (the content is a child). `onClose` is where the caller unmounts it.
 */
export function Modal({
  eyebrow,
  title,
  onClose,
  children,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
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
      aria-labelledby="modal-title"
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-3xl bg-card p-0 text-ink shadow-xl backdrop:bg-onyx/40"
    >
      <div className="p-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {eyebrow && <p className="text-sm text-ink-muted">{eyebrow}</p>}
            <h2 id="modal-title" className="text-xl font-semibold break-words">
              {title}
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
        {children}
      </div>
    </dialog>
  );
}
