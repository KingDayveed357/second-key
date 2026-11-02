"use client";

// The Protection Desk's two views: the incident grid (AG Grid Community) for working through cases, and
// Insights (AG Studio) for the patterns across them. The tab is kept in the URL so it can be linked.

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Desk } from "./desk";

// AG Studio touches the DOM on import, so it loads only in the browser.
const Insights = dynamic(() => import("./insights").then((m) => m.Insights), { ssr: false, loading: () => <p className="small muted">Loading Insights…</p> });

export function Workspace({ mode, licenseKey }: { mode: "public" | "operator"; licenseKey: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const tab = params.get("tab") === "insights" ? "insights" : "incidents";
  const go = (t: "incidents" | "insights") => {
    const next = new URLSearchParams(params.toString());
    if (t === "insights") next.set("tab", "insights");
    else next.delete("tab");
    router.replace(`/desk${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  return (
    <div className="stack">
      <div className="sk-seg" role="tablist" aria-label="Desk view">
        <button role="tab" aria-selected={tab === "incidents"} aria-pressed={tab === "incidents"} onClick={() => go("incidents")}>
          Incidents
        </button>
        <button role="tab" aria-selected={tab === "insights"} aria-pressed={tab === "insights"} onClick={() => go("insights")}>
          Insights · AG Studio
        </button>
      </div>
      {tab === "incidents" ? <Desk mode={mode} /> : <Insights mode={mode} licenseKey={licenseKey} />}
    </div>
  );
}
