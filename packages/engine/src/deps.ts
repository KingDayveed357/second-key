import type pg from "pg";
import type { PgBoss } from "pg-boss";
import { standardAdapter, swapAdapter, type CheckoutAdapter } from "@witness/core";
import type { CatalogSource } from "@witness/catalog";
import type { PayPalClient } from "@witness/paypal";
import type { LlmClient } from "@witness/ai";
import type { Notifier } from "./protection.ts";

export interface Logger {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

export interface EngineDeps {
  pool: pg.Pool;
  boss: PgBoss;
  paypal: PayPalClient;
  catalog: CatalogSource;
  /** Model provider for AI checks. Absent means every AI check fails closed (HOLD). */
  ai?: LlmClient;
  /** Stores proposed when a compiled intent names none (the shopper must confirm). */
  defaultRetailers?: string[];
  log?: Logger;
  now?: () => Date;
  /** How long an approval may wait for the executor before it expires (default 10 min). */
  approvalTtlMs?: number;
  /** HOLD auto-void delay after authorization (default 72 h, inside PayPal's 3-day honour period). */
  holdMs?: number;
  /**
   * Lifetime of a one-time reviewer link (default 30 min), never past the auto-void time. The hold
   * itself lasts holdMs; an expired link only means a new one must be issued.
   */
  holdLinkMs?: number;
  /**
   * Second Key demo only: the PayPal sandbox account that stands in for every demo recipient. When
   * set, demo transfer intents carry it as the confirmed payee email, so approved transfers are paid out.
   */
  demoRecipientEmail?: string;
  adapters?: Record<string, CheckoutAdapter>;
  /** Guardian channel (ADR-0020). Default: the demo inbox. */
  notifier?: Notifier;
  /** Delay before a loosening profile change applies (default 48 h; never below 24 h). */
  loosenDelayMs?: number;
}

export interface Principal {
  tenantId: string;
  principal: string;
  scopes: string[];
}

/** Demo-only faulty adapters are registered by name; agents can never choose one (only the demo route can). */
export const DEFAULT_ADAPTERS: Record<string, CheckoutAdapter> = {
  standard: standardAdapter,
  "faulty:swap": swapAdapter({ sku: "TRL-WHT-10", name: "Ridgeline Trail Runner, Cloud White, US 10" }),
};

export const nowOf = (d: EngineDeps) => (d.now ?? (() => new Date()))();
export const logOf = (d: EngineDeps) => d.log ?? silentLogger;
