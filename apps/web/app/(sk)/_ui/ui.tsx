"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { stageOf, type Tone } from "../../../lib/sk";

/** The routes in the order the demo tells its story: the agent problem, people, operations, adoption. */
const ROUTES = [
  { href: "/agent", label: "Agent demo", hint: "An agent is manipulated; the money isn't" },
  { href: "/pay", label: "Payer demo", hint: "A person under pressure; a trusted second key" },
  { href: "/desk", label: "Protection Desk", hint: "Every incident and its evidence, on AG Grid" },
  { href: "/developers", label: "Developers", hint: "Integrate it; run the sandbox conformance suite" },
  { href: "/try", label: "Try the analysis", hint: "Test the AI on your own text" },
] as const;

/**
 * Inline links on wide screens; a disclosure menu below 860px so no link is clipped or hidden.
 * The menu closes on navigation, Escape and outside clicks, and returns focus to its button.
 */
export function Nav() {
  const path = usePathname();
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const current = (href: string) => (path === href || (href !== "/" && path.startsWith(href)) ? "page" : undefined);

  useEffect(() => setOpen(false), [path]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onClick);
    panel.current?.querySelector<HTMLElement>("a")?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  return (
    <>
      <nav className="sk-nav" aria-label="Second Key">
        {ROUTES.slice(0, 4).map((r) => (
          <Link key={r.href} href={r.href} aria-current={current(r.href)}>
            {r.label}
          </Link>
        ))}
      </nav>
      <button ref={button} type="button" className="sk-menu-btn" aria-expanded={open} aria-controls="sk-menu" onClick={() => setOpen((o) => !o)}>
        <span className="bars" aria-hidden />
        {open ? "Close" : "Menu"}
      </button>
      <div ref={panel} id="sk-menu" className="sk-menu" hidden={!open}>
        <nav aria-label="Second Key, menu">
          <ul>
            {ROUTES.map((r) => (
              <li key={r.href}>
                <Link href={r.href} aria-current={current(r.href)}>
                  <span className="label">{r.label}</span>
                  <span className="hint">{r.hint}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </>
  );
}

export function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`sk-pill ${tone}`}>{children}</span>;
}

export function StatePill({ state }: { state: string | null | undefined }) {
  const s = stageOf(state);
  return <Pill tone={s.tone}>{s.label}</Pill>;
}

/** Marks a value read from the real backend / PayPal sandbox, or synthetic demo content. */
export function Live({ children = "Live sandbox" }: { children?: ReactNode }) {
  return <span className="sk-tag live">{children}</span>;
}
export function Demo({ children = "Demo data" }: { children?: ReactNode }) {
  return <span className="sk-tag demo">{children}</span>;
}

export function Button({
  busy,
  children,
  variant = "primary",
  size,
  block,
  ...rest
}: { busy?: boolean; variant?: "primary" | "secondary" | "quiet"; size?: "sm"; block?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} className={`sk-btn ${variant} ${size ?? ""} ${block ? "block" : ""} ${rest.className ?? ""}`} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Notice({ tone = "", title, children, role }: { tone?: "" | "held" | "bad" | "ok"; title?: ReactNode; children?: ReactNode; role?: "status" | "alert" }) {
  return (
    <div className={`sk-notice ${tone}`} role={role}>
      <div className="stack-sm">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

/**
 * The two-key rail. Steps are derived from real backend states by the caller; "now" marks the
 * current one, which pulses only while the backend is still working.
 */
export function Rail({ steps, label }: { steps: { label: string; status: "done" | "held" | "bad" | "now" | "todo"; moving?: boolean }[]; label: string }) {
  return (
    <ol className="sk-rail" style={{ ["--n" as string]: steps.length }} aria-label={label}>
      {steps.map((s) => (
        <li key={s.label} className={`${s.status === "now" ? `now ${s.moving ? "pending" : "held"}` : s.status}`} aria-current={s.status === "now" ? "step" : undefined}>
          {s.label}
        </li>
      ))}
    </ol>
  );
}
