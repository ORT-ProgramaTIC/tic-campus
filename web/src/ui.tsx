import { X } from "lucide-react";
import type { ReactNode } from "react";
import type { PresentationState } from "./api/types.ts";
import { STATE_LABEL, STATE_TONE } from "./labels.ts";

/** Pieces more than one screen draws. */

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
