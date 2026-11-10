"use client";

// The Protection Desk's three views: the incident grid (AG Grid Community) for working through cases,
// agent mandates (AP2 verifications, also AG Grid) layer by layer, and
// Insights (AG Studio) for the patterns across them. The tab is kept in the URL so it can be linked.

import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Desk } from "./desk";
import { AgentMandates } from "./agent-mandates";

// AG Studio touches the DOM on import, so it loads only in the browser.
const Insights = dynamic(() => import("./insights").then((m) => m.Insights), { ssr: false, loading: () => <p className="small muted">Loading Insights…</p> });

export function Workspace({ mode, licenseKey }: { mode: "public" | "operator"; licenseKey: string }) {
  const params = useSearchParams();
  const router = useRouter();
  const raw = params.get("tab");
  const tab = raw === "insights" || raw === "agents" ? raw : "incidents";
  const go = (t: "incidents" | "agents" | "insights") => {
    const next = new URLSearchParams(params.toString());
    if (t !== "incidents") next.set("tab", t);
    else next.delete("tab");
    router.replace(`/desk${next.size ? `?${next}` : ""}`, { scroll: false });
  };
  return (
    <div className="stack">
      <div className="sk-seg" role="tablist" aria-label="Desk view">
        <button role="tab" aria-selected={tab === "incidents"} aria-pressed={tab === "incidents"} onClick={() => go("incidents")}>
          Incidents
        </button>
        <button role="tab" aria-selected={tab === "agents"} aria-pressed={tab === "agents"} onClick={() => go("agents")}>
          Agent mandates<span className="sk-tab-extra"> · AP2</span>
        </button>
        <button role="tab" aria-selected={tab === "insights"} aria-pressed={tab === "insights"} onClick={() => go("insights")}>
          Insights<span className="sk-tab-extra"> · AG Studio</span>
        </button>
      </div>
      {tab === "incidents" ? <Desk mode={mode} /> : tab === "agents" ? <AgentMandates mode={mode} /> : <Insights mode={mode} licenseKey={licenseKey} />}
    </div>
  );
}
