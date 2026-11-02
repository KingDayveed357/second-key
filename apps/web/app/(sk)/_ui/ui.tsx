"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { stageOf, type Tone } from "../../../lib/sk";

export function Nav() {
  const path = usePathname();
  const item = (href: string, label: string, cls = "") => (
    <Link href={href} className={cls} aria-current={path === href || (href !== "/" && path.startsWith(href)) ? "page" : undefined}>
      {label}
    </Link>
  );
  return (
    <nav className="sk-nav" aria-label="Second Key">
      {item("/pay", "Payer demo")}
      {item("/agent", "Agent demo")}
      {item("/desk", "Protection Desk")}
      {item("/developers", "Developers")}
    </nav>
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
