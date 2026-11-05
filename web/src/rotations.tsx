import { ChevronDown } from "lucide-react";
import { useLocation, useNavigate } from "react-router";
import { rotationName } from "./labels.ts";
import { useOffering, useProyectoOfferings } from "./router.tsx";

/** A course tab's rotation: every Proyecto offering this year. It moves only
 *  this tab — the local nav remembers each tab's own. Hidden for one. */
export function Rotations() {
  const current = useOffering();
  const offerings = useProyectoOfferings();
  const navigate = useNavigate();
  const location = useLocation();
  if (offerings.length < 2) return null;

  return (
    <label className="relative">
      <span className="sr-only">Rotación</span>
      <select
        value={current.offeringId}
        onChange={(event) => {
          const next = offerings.find(
            (one) => one.offeringId === Number(event.target.value),
          );
          if (!next) return;
          // Same tab in the other rotation; the Cronograma's loader sends
          // non-staff back to the student page.
          navigate(next.path + location.pathname.slice(current.path.length));
        }}
        className="appearance-none rounded-xl border border-line bg-card py-2 pr-8 pl-3 text-sm font-medium"
      >
        {offerings.map((one) => (
          <option key={one.offeringId} value={one.offeringId}>
            {rotationName(one)}
          </option>
        ))}
      </select>
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-ink-muted"
        aria-hidden
      />
    </label>
  );
}
