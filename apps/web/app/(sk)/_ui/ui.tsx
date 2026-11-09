"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { stageOf, type Tone } from "../../../lib/sk";

/** The routes in the order the demo tells its story: the agent problem, people, operations, adoption. */
const ROUTES = [
  { href: "/pay", label: "People", hint: "Rose is pressured into a $1,800 payment" },
  { href: "/agent", label: "Agents", hint: "Rose's shopping agent meets a poisoned page" },
  { href: "/desk", label: "Protection Desk", hint: "Inspect every decision and its evidence" },
  { href: "/developers", label: "Developers", hint: "The API, AP2 verification, the conformance suite" },
  { href: "/about", label: "About", hint: "What is real, sandboxed and synthetic here" },
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
        {ROUTES.map((r) => (
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

/**
 * Marks synthetic content that could otherwise be mistaken for real (a call transcript, a product page).
 * Use once per object, only where needed: what is real, sandboxed and synthetic is stated once, on /about.
 */
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
