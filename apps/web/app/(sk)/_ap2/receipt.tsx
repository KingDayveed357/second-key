"use client";

// One signed artifact (receipt, attestation): decoded, and its signature checked in this browser
// against Second Key's published key set, without trusting this page's server.

import { createLocalJWKSet, decodeJwt, decodeProtectedHeader, jwtVerify, type JSONWebKeySet } from "jose";
import { useState } from "react";
import { api } from "../../../lib/client";
import { Button, Pill } from "../_ui/ui";

let jwks: Promise<JSONWebKeySet> | null = null;

export function ReceiptRow({ label, jwt }: { label: string; jwt: string }) {
  const [open, setOpen] = useState(false);
  const [check, setCheck] = useState<"idle" | "ok" | "bad">("idle");
  const [why, setWhy] = useState("");
  const claims = (() => {
    try {
      return decodeJwt(jwt);
    } catch {
      return {};
    }
  })();
  const kid = (() => {
    try {
      return decodeProtectedHeader(jwt).kid;
    } catch {
      return undefined;
    }
  })();
  const summary = String(claims.status ?? claims.result ?? (Array.isArray(claims.products) ? `${claims.products.length} product(s)` : ""));

  async function verify() {
    try {
      jwks ??= api<JSONWebKeySet>("/.well-known/jwks.json");
      await jwtVerify(jwt, createLocalJWKSet(await jwks), { algorithms: ["ES256"] });
      setCheck("ok");
      setWhy("");
    } catch (e) {
      setCheck("bad");
      setWhy((e as Error).message);
    }
  }

  return (
    <div className="sk-verify">
      <div className="head">
        <div className="stack-sm" style={{ gap: 2, minWidth: 0 }}>
          <strong className="small">{label}</strong>
          <span className="xs muted mono" style={{ overflowWrap: "anywhere" }}>
            {summary} · kid {kid ?? "?"}
          </span>
        </div>
        <div className="row" style={{ gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {check === "ok" && <Pill tone="ok">Signature valid</Pill>}
          {check === "bad" && <Pill tone="bad">Invalid</Pill>}
          <Button size="sm" variant="secondary" onClick={verify}>
            Verify
          </Button>
          <Button size="sm" variant="quiet" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? "Hide" : "Show"}
          </Button>
        </div>
      </div>
      {why && <span className="xs" style={{ color: "var(--brick)" }}>{why}</span>}
      {open && (
        <pre className="xs mono" style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 320, overflow: "auto", background: "var(--surface-2)", padding: 10, borderRadius: 8 }}>
          {JSON.stringify(claims, null, 2)}
        </pre>
      )}
    </div>
  );
}
