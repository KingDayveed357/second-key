"use client";

// Collapsible replays. A link to #poisoned or #ap2 (the home card, older links, the video script's
// fallback) opens the matching panel and scrolls to it.

import { useEffect, useState, type ReactNode } from "react";

export function Replay({ items }: { items: { id: string; title: string; meta: string; children: ReactNode }[] }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      if (!items.some((i) => i.id === id)) return;
      setOpen((s) => new Set(s).add(id));
      requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [items]);

  return (
    <div className="sk-replays">
      {items.map((i) => (
        <details
          key={i.id}
          id={i.id}
          className="sk-replay"
          open={open.has(i.id)}
          onToggle={(e) => {
            const isOpen = (e.target as HTMLDetailsElement).open;
            setOpen((s) => {
              const n = new Set(s);
              if (isOpen) n.add(i.id);
              else n.delete(i.id);
              return n;
            });
          }}
        >
          <summary>
            <span className="sk-replay-title">{i.title}</span>
            <span className="xs muted">{i.meta}</span>
          </summary>
          {open.has(i.id) && <div className="sk-replay-body">{i.children}</div>}
        </details>
      ))}
    </div>
  );
}
