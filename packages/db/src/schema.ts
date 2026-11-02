// Drizzle table definitions mirroring migrations/*.sql (the SQL is the source of truth;
// integration tests exercise every table through these definitions, so drift fails loudly).

import { bigint, bigserial, boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  paypalMerchantId: text("paypal_merchant_id").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  principal: text("principal").notNull(),
  scopes: text("scopes").array().notNull(),
  keyHash: text("key_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  revokedAt: ts("revoked_at"),
});

export const shoppers = pgTable("shoppers", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  displayName: text("display_name").notNull(),
  vaultId: text("vault_id"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const intents = pgTable("intents", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  shopperId: text("shopper_id").notNull(),
  lineageId: text("lineage_id").notNull(),
  version: integer("version").notNull(),
  status: text("status", { enum: ["DRAFT", "CONFIRMED", "REVOKED", "SUPERSEDED"] }).notNull(),
  sourceText: text("source_text"),
  policy: jsonb("policy").notNull(),
  policyDigest: text("policy_digest"),
  ambiguities: jsonb("ambiguities").notNull().default([]),
  compiler: jsonb("compiler"),
  createdAt: ts("created_at").notNull().defaultNow(),
  confirmedAt: ts("confirmed_at"),
  revokedAt: ts("revoked_at"),
});

export const purchases = pgTable("purchases", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  intentId: text("intent_id").notNull(),
  intentVersion: integer("intent_version").notNull(),
  policyDigest: text("policy_digest").notNull(),
  agentPrincipal: text("agent_principal").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  requestHash: text("request_hash").notNull(),
  request: jsonb("request").notNull(),
  adapter: text("adapter").notNull().default("standard"),
  state: text("state").notNull(),
  version: integer("version").notNull().default(0),
  outcome: text("outcome"),
  reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
  retailer: text("retailer"),
  cart: jsonb("cart"),
  cartDigest: text("cart_digest"),
  facts: jsonb("facts"),
  amountCents: integer("amount_cents"),
  currency: text("currency"),
  paypalOrderId: text("paypal_order_id"),
  paypalAuthorizationId: text("paypal_authorization_id"),
  paypalCaptureId: text("paypal_capture_id"),
  authorizedAt: ts("authorized_at"),
  /** Second Key screening snapshot (0006): which protection governed this payment when it was screened. */
  protection: jsonb("protection"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const checks = pgTable("checks", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  purchaseId: text("purchase_id").notNull(),
  phase: text("phase", { enum: ["SCREEN", "VERIFY", "RECHECK", "CONTEXT"] }).notNull(),
  checkId: text("check_id").notNull(),
  kind: text("kind", { enum: ["deterministic", "ai"] }).notNull(),
  result: text("result", { enum: ["pass", "fail", "unknown"] }).notNull(),
  detail: text("detail").notNull(),
  line: text("line"),
  model: text("model"),
  promptVersion: text("prompt_version"),
  /** Grounded evidence for AI checks (0003); null for deterministic checks. */
  evidence: jsonb("evidence"),
  /** The check couldn't run or gave no usable answer: a technical failure, not a finding (0007). */
  unavailable: boolean("unavailable").notNull().default(false),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Conversation a payer shared after the pause (0005). Never unpauses anything. */
export const sharedContext = pgTable("shared_context", {
  purchaseId: text("purchase_id").primaryKey(),
  conversation: jsonb("conversation").notNull(),
  sharedBy: text("shared_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** A payer saying a finding is wrong (0005): a note for the reviewer and the Desk, not a policy input. */
export const evidenceFeedback = pgTable("evidence_feedback", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  purchaseId: text("purchase_id").notNull(),
  quote: text("quote").notNull(),
  note: text("note").notNull(),
  givenBy: text("given_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const decisions = pgTable("decisions", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  purchaseId: text("purchase_id").notNull(),
  outcome: text("outcome", { enum: ["REJECT", "HOLD", "CAPTURE", "VOID"] }).notNull(),
  reasons: jsonb("reasons").$type<string[]>().notNull(),
  decidedBy: text("decided_by").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const approvals = pgTable("approvals", {
  id: text("id").primaryKey(),
  purchaseId: text("purchase_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  paypalOrderId: text("paypal_order_id").notNull(),
  paypalAuthorizationId: text("paypal_authorization_id").notNull(),
  payeeMerchantId: text("payee_merchant_id").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").notNull(),
  cartDigest: text("cart_digest").notNull(),
  policyDigest: text("policy_digest").notNull(),
  intentVersion: integer("intent_version").notNull(),
  requestId: text("request_id").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const paypalCalls = pgTable("paypal_calls", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  purchaseId: text("purchase_id").notNull(),
  op: text("op", { enum: ["create-order", "capture", "void", "payout"] }).notNull(),
  requestId: text("request_id").notNull(),
  status: text("status", { enum: ["PENDING", "SUCCEEDED", "FAILED", "UNKNOWN"] }).notNull(),
  httpStatus: integer("http_status"),
  debugId: text("debug_id"),
  request: jsonb("request"),
  response: jsonb("response"),
  error: text("error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const webhookEvents = pgTable("webhook_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  transmissionId: text("transmission_id"),
  verified: boolean("verified").notNull(),
  payload: jsonb("payload").notNull(),
  receivedAt: ts("received_at").notNull().defaultNow(),
  processedAt: ts("processed_at"),
  outcome: text("outcome"),
});

/** Second Key recipient payouts (0004): executor only, one per purchase, after a verified capture. */
export const PAYOUT_STATUSES = ["SENDING", "UNKNOWN", "PENDING", "SUCCESS", "UNCLAIMED", "ONHOLD", "FAILED", "RETURNED", "BLOCKED", "REFUNDED", "REVERSED", "DENIED"] as const;
export const payouts = pgTable("payouts", {
  purchaseId: text("purchase_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  receiver: text("receiver").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: text("currency").notNull(),
  senderBatchId: text("sender_batch_id").notNull(),
  requestId: text("request_id").notNull(),
  batchId: text("batch_id"),
  itemId: text("item_id"),
  status: text("status", { enum: PAYOUT_STATUSES }).notNull(),
  checks: integer("checks").notNull().default(0),
  lastError: text("last_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const holds = pgTable("holds", {
  purchaseId: text("purchase_id").primaryKey(),
  tokenHash: text("token_hash"),
  tokenExpiresAt: ts("token_expires_at"),
  autoVoidAt: ts("auto_void_at").notNull(),
  notifiedAt: ts("notified_at"),
  resolvedAt: ts("resolved_at"),
  resolution: text("resolution", { enum: ["APPROVED", "DENIED", "TIMEOUT", "REVOKED", "CANCELLED"] }),
  /** Who may approve (0006, ADR-0020): the principal, the payer's guardian, or pre-0020 behaviour. */
  approver: text("approver", { enum: ["principal", "guardian", "legacy"] }).notNull().default("principal"),
  guardianId: text("guardian_id"),
  reasonClasses: text("reason_classes").array().notNull().default([]),
  /** The one live guardian credential: SHA-256 only, bound to a guardian, minted at the channel's last hop. */
  credentialHash: text("credential_hash"),
  credentialGuardianId: text("credential_guardian_id"),
  credentialExpiresAt: ts("credential_expires_at"),
  credentialSeq: integer("credential_seq"),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lastNotifiedAt: ts("last_notified_at"),
});

/** The payer's standing protection (0006, ADR-0020). Changed only through profile_changes. */
export const protectionProfiles = pgTable(
  "protection_profiles",
  {
    tenantId: text("tenant_id").notNull(),
    shopperId: text("shopper_id").notNull(),
    version: integer("version").notNull().default(1),
    thresholdCents: integer("threshold_cents"),
    guardianId: text("guardian_id"),
    protectionOn: boolean("protection_on").notNull().default(false),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.shopperId] })],
);

export const guardians = pgTable("guardians", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  shopperId: text("shopper_id").notNull(),
  displayName: text("display_name").notNull(),
  channel: text("channel", { enum: ["demo_inbox"] }).notNull(),
  address: text("address").notNull(),
  status: text("status", { enum: ["INVITED", "ACTIVE", "REMOVED", "REVOKED"] }).notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  activatedAt: ts("activated_at"),
  endedAt: ts("ended_at"),
  endedReason: text("ended_reason"),
});

export const profileChanges = pgTable("profile_changes", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  shopperId: text("shopper_id").notNull(),
  kind: text("kind", { enum: ["threshold", "guardian", "remove_guardian"] }).notNull(),
  value: jsonb("value").notNull(),
  requestedAt: ts("requested_at").notNull(),
  effectiveAt: ts("effective_at").notNull(),
  appliedAt: ts("applied_at"),
  cancelledAt: ts("cancelled_at"),
  cancelReason: text("cancel_reason"),
});

/** Transactional outbox for guardian messages. `body` never contains a credential. */
export const notifications = pgTable("notifications", {
  id: text("id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  guardianId: text("guardian_id").notNull(),
  purchaseId: text("purchase_id"),
  kind: text("kind", { enum: ["invite", "hold_review", "authority_change", "revoked"] }).notNull(),
  seq: integer("seq").notNull().default(1),
  body: jsonb("body").notNull().default({}),
  status: text("status", { enum: ["PENDING", "DELIVERED", "FAILED", "SUPERSEDED"] }).notNull(),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
  lastError: text("last_error"),
  deliveredAt: ts("delivered_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Demo channel standing in for a guardian's phone. Read only with its secret (hash stored). */
export const demoInboxes = pgTable("demo_inboxes", {
  address: text("address").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  secretHash: text("secret_hash").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

/** Who a payer has actually paid: written only when a transfer is CAPTURED (or by an audited import). */
export const payeeHistory = pgTable(
  "payee_history",
  {
    tenantId: text("tenant_id").notNull(),
    shopperId: text("shopper_id").notNull(),
    payeeKey: text("payee_key").notNull(),
    firstPaidAt: ts("first_paid_at").notNull(),
    purchaseId: text("purchase_id"),
    source: text("source", { enum: ["captured", "imported", "backfill"] }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.tenantId, t.shopperId, t.payeeKey] })],
);

export const auditLog = pgTable("audit_log", {
  epoch: integer("epoch").notNull(),
  seq: bigint("seq", { mode: "number" }).notNull(),
  tenantId: text("tenant_id"),
  purchaseId: text("purchase_id"),
  eventType: text("event_type").notNull(),
  payload: jsonb("payload").notNull(),
  at: ts("at").notNull(),
  prevHash: text("prev_hash").notNull(),
  hash: text("hash").notNull(),
});
