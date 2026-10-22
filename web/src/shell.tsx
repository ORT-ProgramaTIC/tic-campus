import { ChevronDown, LogOut } from "lucide-react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useRouteLoaderData,
} from "react-router";
import { useLogout, useMe } from "./api/queries.ts";
import type { OfferingSummary, ResolvedOffering } from "./api/types.ts";
import { useProyectoOfferings } from "./router.tsx";

/**
 * The thin header (`project-tic-campus-navigation-shell`): only Proyecto is
 * live this year, so it is the one item and always the current one. Staff of
 * the offering get the local nav under it — the student page and the
 * Cronograma.
 */
export function Shell() {
  // Undefined outside an offering's routes (`/proyecto` with none).
  const offering = useRouteLoaderData("offering") as
    ResolvedOffering | undefined;

  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-10 border-b border-line bg-card/90 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
          {/* The family mark, untouched (`BRAND.md` §4), and the name with its
              TIC in pink (§5). One static file, also the favicon. */}
          <Link
            to="/"
            aria-label="TIC Campus"
            className="flex items-center gap-2 text-lg font-extrabold tracking-tight"
          >
            <img src="/brand/tic-x.svg" alt="" aria-hidden className="size-7" />
            <span className="hidden sm:inline">
              <span className="text-tic-pink">TIC</span> Campus
            </span>
          </Link>
          <nav className="ml-1 sm:ml-4">
            <Link
              to="/proyecto"
              aria-current="page"
              className="rounded-xl bg-lilac-50 px-3 py-2 text-sm font-medium text-lilac-700"
            >
              Proyecto
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-2">
            <Rotations current={offering} />
            <Profile />
          </div>
        </div>
        {offering?.can.manageOffering && <LocalNav offering={offering} />}
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8 sm:px-6">
        <Outlet />
      </main>
    </div>
  );
}

const rotationName = (offering: OfferingSummary) =>
  offering.offeringName ?? offering.courseNames.join(" + ");

/** Every Proyecto offering this year, one per rotation. Hidden for one. */
function Rotations({ current }: { current: ResolvedOffering | undefined }) {
  const offerings = useProyectoOfferings();
  const navigate = useNavigate();
  const location = useLocation();
  if (offerings.length < 2) return null;

  return (
    <label className="relative">
      <span className="sr-only">Rotación</span>
      <select
        value={current?.offeringId ?? ""}
        onChange={(event) => {
          const next = offerings.find(
            (one) => one.offeringId === Number(event.target.value),
          );
          if (!next) return;
          // Same tab in the other rotation; the Cronograma's loader sends
          // non-staff back to the student page.
          const tab = current
            ? location.pathname.slice(current.path.length)
            : "/presentaciones";
          navigate(next.path + tab);
        }}
        className="appearance-none rounded-xl border border-line bg-card py-2 pr-8 pl-3 text-sm font-medium"
      >
        {current === undefined && <option value="">Rotación</option>}
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

/** The avatar and its menu — a native popover, so it closes on an outside
 *  click or Escape by itself. Pinned under the header's right edge, where the
 *  button always is, instead of anchored to it. */
function Profile() {
  const me = useMe().data!.me;
  const logout = useLogout();
  const name =
    [me.given_name, me.family_name].filter(Boolean).join(" ") ||
    me.name ||
    me.email ||
    "";
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => word.charAt(0).toUpperCase())
    .join("");

  return (
    <>
      <button
        type="button"
        popoverTarget="perfil"
        aria-label="Tu cuenta"
        className="grid size-10 place-items-center rounded-full bg-lilac-100 text-sm font-semibold text-lilac-700"
      >
        {initials}
      </button>
      <div
        id="perfil"
        popover="auto"
        // The header's content is `max-w-6xl` centred: its right edge is the
        // gutter, or the gutter plus half of what the viewport has beyond 72rem.
        className="inset-auto top-18 right-[max(1rem,calc((100vw-72rem)/2+1.5rem))] m-0 w-64 rounded-2xl border border-line bg-card p-2 text-ink shadow-lg"
      >
        <div className="px-3 py-2">
          <p className="font-medium">{name}</p>
          {me.email && <p className="text-sm text-ink-muted">{me.email}</p>}
        </div>
        <button
          type="button"
          onClick={() => logout.mutate()}
          disabled={logout.isPending}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm hover:bg-lilac-50"
        >
          <LogOut className="size-4" aria-hidden />
          Cerrar sesión
        </button>
      </div>
    </>
  );
}

function LocalNav({ offering }: { offering: ResolvedOffering }) {
  const tab = ({ isActive }: { isActive: boolean }) =>
    `-mb-px border-b-2 px-1 py-3 text-sm font-medium ${
      isActive
        ? "border-lilac-500 text-ink"
        : "border-transparent text-ink-muted hover:text-ink"
    }`;
  return (
    <nav className="mx-auto flex max-w-6xl gap-6 px-4 sm:px-6">
      <NavLink to={`${offering.path}/presentaciones`} end className={tab}>
        Presentaciones
      </NavLink>
      <NavLink
        to={`${offering.path}/presentaciones/cronograma`}
        className={tab}
      >
        Cronograma
      </NavLink>
    </nav>
  );
}
