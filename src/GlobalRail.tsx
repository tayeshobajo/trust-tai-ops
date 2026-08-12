import type { ReactNode } from "react";

export type GlobalDestination = "projects" | "activity" | "approvals" | "settings";

type Props = {
  active: GlobalDestination;
  onNavigate: (destination: GlobalDestination) => void;
  operator: string;
  approvalsCount?: number;
};

const Icon = ({ name }: { name: GlobalDestination }) => {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "projects":
      return (
        <svg {...common}>
          <rect x="3" y="4" width="18" height="7" rx="2" />
          <rect x="3" y="14" width="18" height="6" rx="2" />
        </svg>
      );
    case "activity":
      return (
        <svg {...common}>
          <path d="M3 12h4l3 7 4-14 3 7h4" />
        </svg>
      );
    case "approvals":
      return (
        <svg {...common}>
          <path d="M20 6 9 17l-5-5" />
        </svg>
      );
    case "settings":
    default:
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3.2" />
          <path d="M12 3v2.2M12 18.8V21M3 12h2.2M18.8 12H21M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M18.4 5.6l-1.6 1.6M7.2 16.8l-1.6 1.6" />
        </svg>
      );
  }
};

const mainNav: Array<{ id: GlobalDestination; label: string }> = [
  { id: "projects", label: "Projects" },
  { id: "activity", label: "Activity" },
  { id: "approvals", label: "Approvals" },
];

export function GlobalRail({ active, onNavigate, operator, approvalsCount = 0 }: Props) {
  const initial = operator.slice(0, 1).toUpperCase();

  const item = (id: GlobalDestination, label: string) => (
    <li key={id}>
      <button
        type="button"
        className={`global-rail-link ${active === id ? "is-active" : ""}`}
        aria-current={active === id ? "page" : undefined}
        onClick={() => onNavigate(id)}
      >
        <span className="global-rail-icon" aria-hidden="true">
          <Icon name={id} />
          {id === "approvals" && approvalsCount > 0 ? (
            <span className="global-rail-count">{approvalsCount}</span>
          ) : null}
        </span>
        <span className="global-rail-label">{label}</span>
      </button>
    </li>
  );

  return (
    <>
      <nav className="global-rail" aria-label="Primary">
        <div className="global-rail-brand">
          <span className="global-rail-logo" aria-hidden="true">
            <img src="/brand-mark.png" alt="" />
          </span>
          <span className="sr-only">Trust Tai Ops</span>
        </div>

        <ul className="global-rail-nav">{mainNav.map((entry) => item(entry.id, entry.label))}</ul>

        <ul className="global-rail-utility">
          {item("settings", "Settings")}
          <li>
            <div className="global-rail-operator" title={operator}>
              <span className="global-rail-avatar" aria-hidden="true">{initial}</span>
              <small>{operator}</small>
            </div>
          </li>
        </ul>
      </nav>

      <nav className="global-tabbar" aria-label="Primary">
        {[...mainNav, { id: "settings" as const, label: "Settings" }].map((entry) => (
          <button
            key={entry.id}
            type="button"
            className={`global-tab ${active === entry.id ? "is-active" : ""}`}
            aria-current={active === entry.id ? "page" : undefined}
            onClick={() => onNavigate(entry.id)}
          >
            <span className="global-rail-icon" aria-hidden="true">
              <Icon name={entry.id} />
              {entry.id === "approvals" && approvalsCount > 0 ? (
                <span className="global-rail-count">{approvalsCount}</span>
              ) : null}
            </span>
            {entry.label}
          </button>
        ))}
      </nav>
    </>
  );
}

export function GlobalPage({
  active,
  onNavigate,
  operator,
  approvalsCount,
  children,
}: Props & { children: ReactNode }) {
  return (
    <div className="home-shell is-single">
      <GlobalRail active={active} onNavigate={onNavigate} operator={operator} approvalsCount={approvalsCount} />
      <section className="global-main">{children}</section>
    </div>
  );
}