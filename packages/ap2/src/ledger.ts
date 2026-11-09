// The mandate ledger: AP2's stateful rules (budget, recurrence, no second use of an open mandate,
// no replay of a closed one) need memory the spec leaves to "the verifier". Keys are issuer-JWT
// hashes, not sd_hash: a holder can present the same open mandate with different disclosures,
// which changes sd_hash but never the issuer-signed JWT, so disclosure games can't reset a budget.

import type { LedgerUsage } from "./constraints.ts";

export interface LedgerRecord {
  /** Closed-mandate references this presentation consumes. */
  closed: string[];
  opens: { ref: string; amountMinor?: number; currency?: string }[];
  /** Unix seconds. */
  at: number;
}

export interface LedgerState {
  usage: Map<string, LedgerUsage>;
  closedSeen: Set<string>;
}

export interface Ledger {
  /**
   * Read the state of these keys and, when `fn` returns a record, write it, atomically with
   * respect to any other transaction on the same keys.
   */
  transact<T>(keys: { open: string[]; closed: string[] }, fn: (s: LedgerState) => Promise<{ value: T; record?: LedgerRecord }>): Promise<T>;
}

/** In-process ledger for tests and the browser kit. One queue, so transactions never interleave. */
export class MemoryLedger implements Ledger {
  readonly usage = new Map<string, LedgerUsage>();
  readonly closed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  transact<T>(keys: { open: string[]; closed: string[] }, fn: (s: LedgerState) => Promise<{ value: T; record?: LedgerRecord }>): Promise<T> {
    const run = async () => {
      const usage = new Map(keys.open.map((k) => [k, { ...(this.usage.get(k) ?? { uses: 0, totalMinor: 0 }) }]));
      const closedSeen = new Set(keys.closed.filter((k) => this.closed.has(k)));
      const { value, record } = await fn({ usage, closedSeen });
      if (record) {
        for (const c of record.closed) this.closed.add(c);
        for (const o of record.opens) {
          const u = this.usage.get(o.ref) ?? { uses: 0, totalMinor: 0 };
          this.usage.set(o.ref, {
            uses: u.uses + 1,
            totalMinor: u.totalMinor + (o.amountMinor ?? 0),
            currency: u.currency ?? o.currency,
            lastUsedAt: record.at,
          });
        }
      }
      return value;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}
