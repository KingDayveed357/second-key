"use client";

// The agent demo on real AP2 mandates. Rose's own browser is the Trusted Surface: a device key
// WebCrypto generated here (non-extractable) signs her open mandates. The demo agent and merchant
// are server-side parties with their own keys. Every verdict on this page comes from Second Key's
// verifier and PayPal; which run does what is scripted and labelled as such.

import { useEffect, useRef, useState } from "react";
import { api, errText } from "../../../lib/client";
import { deviceKey, type DeviceKey } from "../../../lib/ap2-device";
import { ROSE_REQUEST, roseMandates, thumbprint, type Ap2Setup } from "../../../lib/ap2-surface";
import { usd } from "../../../lib/sk";
import { Button, Demo, Live, Notice, Pill } from "../_ui/ui";
import { ReceiptRow } from "../_ap2/receipt";

type RunName = "conforms" | "steered" | "wrong_product" | "cart_swap" | "reused";
type CaughtBy = "none" | "ap2_constraints" | "secondkey_facts" | "secondkey_ledger" | "paypal_order" | "signatures" | "cannot_confirm";

interface Constraint {
  type: string;
  result: "pass" | "fail" | "unresolved";
  detail?: string;
}
interface Verification {
  verification_id: string;
  decision: "CONFORMS" | "NONCONFORMING" | "CANNOT_CONFIRM" | "COSIGN_REQUIRED";
  error?: string;
  findings: { code: string; message: string }[];
  constraints: Constraint[];
  facts_attestation: string | null;
  receipts: { checkout: string; payment: string | null };
}
interface Settlement {
  settlement_id: string;
  state: string;
  order_id: string;
  capture_id: string | null;
  diffs: string[];
  receipts: { checkout: string; payment: string } | null;
}
interface RunView {
  run: RunName;
  agent: { product_id: string; title: string; price_cents: number; narration: string };
  first?: Verification;
  verification: Verification;
  settlement: Settlement | null;
  caught_by: CaughtBy;
}

const RUNS: { name: RunName; label: string }[] = [
  { name: "conforms", label: "It goes right" },
  { name: "steered", label: "Agent steered" },
  { name: "wrong_product", label: "Wrong colour" },
  { name: "cart_swap", label: "Checkout swaps it" },
  { name: "reused", label: "Mandate reused" },
];

const HEADLINE: Record<CaughtBy, string> = {
  none: "Bought: every check passed",
  ap2_constraints: "Refused by AP2's own constraints",
  secondkey_facts: "AP2 said yes. Second Key's facts said no.",
  secondkey_ledger: "Refused: this mandate was already used",
  paypal_order: "Caught at PayPal: the order isn't what was verified",
  signatures: "Refused: not signed by Rose's device",
  cannot_confirm: "Paused: Second Key couldn't confirm it",
};

const FINAL = ["CAPTURED", "VOIDED", "CAPTURE_DECLINED", "REFUSED"];

/** One verification per page load, even if React runs the effect twice. */
let session: Promise<Response> | null = null;
const startSession = (reset = false) => (reset ? (session = fetch("/api/sk/session?reset=1", { method: "POST" })) : (session ??= fetch("/api/sk/session", { method: "POST" })));

export function MandateDemo() {
  const [setup, setSetup] = useState<(Ap2Setup & { merchant: Ap2Setup["merchant"] }) | null>(null);
  const [device, setDevice] = useState<(DeviceKey & { kid: string }) | null>(null);
  const [enrolled, setEnrolled] = useState(false);
  const [run, setRun] = useState<RunName>("conforms");
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<RunView | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [err, setErr] = useState("");
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    (async () => {
      try {
        const [s, k] = await Promise.all([api<Ap2Setup>("/v1/demo/ap2/setup"), deviceKey()]);
        setSetup(s);
        setDevice({ ...k, kid: await thumbprint(k.publicJwk) });
      } catch (e) {
        setErr(errText(e));
      }
    })();
  }, []);

  /** Enrol this device's public key for the visitor's demo payer (once per session). */
  async function ensureEnrolled(d: DeviceKey) {
    if (enrolled) return;
    await startSession();
    try {
      await api("/v1/me/demo/ap2/surface", { method: "POST", body: { jwk: d.publicJwk }, asPayer: true });
    } catch {
      // A stale session cookie: start a fresh demo payer once and enrol again.
      await startSession(true);
      await api("/v1/me/demo/ap2/surface", { method: "POST", body: { jwk: d.publicJwk }, asPayer: true });
    }
    setEnrolled(true);
  }

  async function go() {
    if (!setup || !device) return;
    setBusy(true);
    setErr("");
    setView(null);
    setSettlement(null);
    try {
      await ensureEnrolled(device);
      const m = await roseMandates(setup, device.privateKey, device.kid);
      const v = await api<RunView>(`/v1/me/demo/ap2/runs/${run}`, { method: "POST", body: { open_checkout: m.openCheckout, open_payment: m.openPayment }, asPayer: true });
      setView(v);
      setSettlement(v.settlement);
      requestAnimationFrame(() => headingRef.current?.focus());
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  }

  // The worker captures or voids after binding; follow the settlement until PayPal's state is final.
  useEffect(() => {
    if (!settlement || FINAL.includes(settlement.state)) return;
    const t = setInterval(async () => {
      try {
        const s = await api<Settlement>(`/v1/me/demo/ap2/settlements/${settlement.settlement_id}`, { asPayer: true });
        if (s.state !== settlement.state || (s.receipts && !settlement.receipts)) setSettlement(s);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(t);
  }, [settlement]);

  const family = setup?.products.filter((p) => p.title.startsWith(ROSE_REQUEST.family)) ?? [];
  const caught: CaughtBy | null = view ? (view.caught_by === "none" && settlement && ["VOIDED", "VOIDING", "REFUSED"].includes(settlement.state) ? "paypal_order" : view.caught_by) : null;

  return (
    <div className="stack-lg" style={{ gap: "var(--s7)" }}>
      <div className="sk-stage">
        <section className="sk-phone stack-lg" aria-label="Rose's device">
          <div className="appbar">
            <span className="soft">Rose&apos;s device</span>
            {device ? <Pill tone="ok">Key on this device</Pill> : <span className="xs muted">Preparing…</span>}
          </div>
          <div className="stack-sm">
            <span className="sk-section-title">What Rose signs, here, with her own key</span>
            <ul className="small" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 4 }}>
              <li>
                One pair of <strong>{ROSE_REQUEST.family}</strong>, any of: {family.map((p) => p.color ?? p.id).join(", ") || "…"}
              </li>
              <li>
                Size <strong>{ROSE_REQUEST.size}</strong>, and <strong>not {ROSE_REQUEST.notColour}</strong>
              </li>
              <li>
                Up to <strong>{usd(ROSE_REQUEST.maxCents)}</strong>, paid to {setup?.merchant.name ?? "the shop"} only
              </li>
              <li>Only her agent&apos;s key can use it, for the next 30 minutes</li>
            </ul>
            <p className="xs muted">
              AP2 can list the shoes and cap the price. &ldquo;Not white&rdquo; isn&apos;t something AP2 can say: it travels as Second Key&apos;s own constraint, checked against product facts Second Key fetches and signs itself.
            </p>
            {device && (
              <p className="xs muted mono" title="RFC 7638 thumbprint of the device's public key">
                Device key {device.kid.slice(0, 12)}… {device.persisted ? "· kept in this browser" : "· this page only (private window)"}
              </p>
            )}
          </div>
          <div className="stack-sm">
            <span className="sk-section-title">What happens on this run</span>
            <div className="sk-seg wrap" role="group" aria-label="What happens on this run">
              {RUNS.map((r) => (
                <button key={r.name} aria-pressed={run === r.name} disabled={busy} onClick={() => (setRun(r.name), setView(null), setSettlement(null), setErr(""))}>
                  {r.label}
                </button>
              ))}
            </div>
            <Demo>Scripted agent and merchant, synthetic shop</Demo>
          </div>
          <Button block onClick={go} busy={busy} disabled={!setup || !device}>
            {busy ? "Signing and shopping…" : "Sign the mandate and let the agent buy"}
          </Button>
          {err && (
            <Notice tone="bad" title="Something went wrong" role="alert">
              {err}
            </Notice>
          )}
        </section>

        <aside className="stack" aria-live="polite">
          {!view ? (
            <div className="sk-card tint stack-sm">
              <p className="small soft">
                Pick a run and press the button. Rose&apos;s browser signs two AP2 open mandates; the agent closes them for its cart; the merchant signs the checkout; Second Key verifies everything and, if it conforms, binds the payment to PayPal&apos;s own order before anything is captured.
              </p>
            </div>
          ) : (
            <>
              <div className="stack-sm">
                <h2 ref={headingRef} tabIndex={-1} style={{ fontSize: "var(--text-xl)" }}>
                  {caught === "none" && settlement?.state !== "CAPTURED" ? "Every check passed: PayPal is capturing…" : caught && HEADLINE[caught]}
                </h2>
                <p className="small soft">
                  <Demo>Narration</Demo> {view.agent.narration} Cart: {view.agent.title}, {usd(view.agent.price_cents)}.
                </p>
              </div>
              <Ladder view={view} settlement={settlement} />
            </>
          )}
        </aside>
      </div>

      {view && <Receipts view={view} settlement={settlement} />}
    </div>
  );
}

type Status = "pass" | "fail" | "open" | "skip" | "wait";
const MARK: Record<Status, { text: string; tone: "ok" | "bad" | "held" | "neutral" | "pending" }> = {
  pass: { text: "Passed", tone: "ok" },
  fail: { text: "Stopped it", tone: "bad" },
  open: { text: "Couldn't confirm", tone: "held" },
  skip: { text: "Not reached", tone: "neutral" },
  wait: { text: "Checking PayPal…", tone: "pending" },
};

/** The trust ladder: who checked what, and which rung stopped the run. */
function Ladder({ view, settlement }: { view: RunView; settlement: Settlement | null }) {
  const v = view.verification;
  const standard = v.constraints.filter((c) => /^(checkout|payment)\./.test(c.type));
  const ours = v.constraints.filter((c) => c.type.startsWith("x-secondkey."));
  const ledger = v.findings.filter((f) => f.code.startsWith("ledger."));
  const other = v.findings.filter((f) => !f.code.startsWith("ledger."));
  const of = (cs: Constraint[]): Status => (cs.some((c) => c.result === "fail") ? "fail" : cs.some((c) => c.result === "unresolved") ? "open" : "pass");

  const sig: Status = v.error === "invalid_credential" ? "fail" : "pass";
  const ap2: Status = sig === "fail" ? "skip" : other.length ? "fail" : of(standard);
  const facts: Status = sig === "fail" ? "skip" : of(ours);
  const used: Status = sig === "fail" ? "skip" : ledger.length ? "fail" : "pass";
  const pp: Status = !settlement ? "skip" : settlement.state === "CAPTURED" ? "pass" : ["VOIDED", "VOIDING", "REFUSED", "CAPTURE_DECLINED"].includes(settlement.state) ? "fail" : "wait";

  const rungs: { name: string; who: string; status: Status; detail: string }[] = [
    {
      name: "Signatures",
      who: "Any AP2 verifier",
      status: sig,
      detail: sig === "fail" ? (v.findings[0]?.message ?? "the chain doesn't verify") : "Rose's device signed the open mandates; only the agent key they name closed them; the merchant signed the checkout.",
    },
    {
      name: "AP2 constraints",
      who: "Any AP2 verifier",
      status: ap2,
      detail:
        ap2 === "fail"
          ? [...other.map((f) => f.message), ...standard.filter((c) => c.result === "fail").map((c) => `${c.type}: ${c.detail ?? "failed"}`)].join("; ")
          : "Listed item, allowed merchant, amount within range, allowed payee, payment bound to this checkout.",
    },
    {
      name: "Second Key's facts",
      who: "Second Key",
      status: facts,
      detail: ours.length ? ours.map((c) => (c.result === "pass" ? "size 10 and not white, on facts Second Key fetched and signed" : (c.detail ?? c.result))).join("; ") : "No attribute rule in this mandate.",
    },
    {
      name: "Ledger",
      who: "Second Key",
      status: used,
      detail: used === "fail" ? `${ledger.map((f) => f.message).join("; ")}${view.first ? ` (its first use ${view.first.decision === "CONFORMS" ? "conformed" : `was ${view.first.decision}`})` : ""}` : "Each open mandate is used once; this one hadn't been.",
    },
    {
      name: "PayPal's order",
      who: "Second Key + PayPal",
      status: v.decision === "CONFORMS" ? pp : "skip",
      detail: !settlement
        ? "Not reached: nothing was sent to PayPal."
        : settlement.diffs.length
          ? settlement.diffs.join("; ")
          : settlement.state === "CAPTURED"
            ? `PayPal's stored order held exactly the verified checkout; captured (${settlement.capture_id}).`
            : `Order ${settlement.order_id} matches; the executor is capturing.`,
    },
  ];
  return (
    <ol className="sk-ladder" aria-label="Which check stopped it">
      {rungs.map((r) => (
        <li key={r.name} className={r.status}>
          <div className="row between" style={{ gap: 8, alignItems: "baseline" }}>
            <strong className="small">{r.name}</strong>
            <Pill tone={MARK[r.status].tone}>{MARK[r.status].text}</Pill>
          </div>
          <span className="xs muted">{r.who}</span>
          <span className="xs soft">{r.detail}</span>
        </li>
      ))}
    </ol>
  );
}

/** Every signed artifact of the run, decoded, with its signature checked here against the JWKS. */
function Receipts({ view, settlement }: { view: RunView; settlement: Settlement | null }) {
  const items: { label: string; jwt: string }[] = [
    { label: "Mandate receipt: checkout", jwt: view.verification.receipts.checkout },
    ...(view.verification.receipts.payment ? [{ label: "Mandate receipt: payment", jwt: view.verification.receipts.payment }] : []),
    ...(view.verification.facts_attestation ? [{ label: "Facts attestation", jwt: view.verification.facts_attestation }] : []),
    ...(settlement?.receipts ? [{ label: "AP2 Checkout Receipt", jwt: settlement.receipts.checkout }, { label: "AP2 Payment Receipt", jwt: settlement.receipts.payment }] : []),
  ];
  return (
    <section className="sk-card stack" aria-labelledby="receipts">
      <div className="row between">
        <h2 id="receipts" style={{ fontSize: "var(--text-lg)" }}>
          Signed receipts
        </h2>
        <Live>Signed by Second Key</Live>
      </div>
      <p className="xs muted">Each is an ES256 JWT. &ldquo;Verify&rdquo; checks its signature in this browser against Second Key&apos;s published key set, without trusting this page&apos;s server.</p>
      <div className="stack-sm">
        {items.map((it) => (
          <ReceiptRow key={it.label + it.jwt.slice(-12)} {...it} />
        ))}
      </div>
    </section>
  );
}
