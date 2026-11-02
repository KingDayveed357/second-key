-- Second Key (ADR-0020): the second key is held by someone else.
--   - a standing protection profile per payer (threshold, guardian), changed only through profile_changes:
--     tightening applies at once, loosening after a delay;
--   - enrolled guardians, reached through a channel the payer can't read;
--   - a transactional notification outbox; the hold credential is minted at the channel's last hop and
--     only its SHA-256 is stored, bound to one hold and one guardian;
--   - payee history derived from captured transfers, so "first payment" can't be asserted away.
-- Existing holds become 'legacy' and keep their behaviour; they all auto-void within 72 h.

CREATE TABLE protection_profiles (
  tenant_id        text NOT NULL,
  shopper_id       text NOT NULL,
  version          integer NOT NULL DEFAULT 1,
  threshold_cents  integer CHECK (threshold_cents IS NULL OR threshold_cents >= 0),
  guardian_id      text,
  protection_on    boolean NOT NULL DEFAULT false,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, shopper_id)
);

CREATE TABLE guardians (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL,
  shopper_id    text NOT NULL,
  display_name  text NOT NULL,
  channel       text NOT NULL CHECK (channel IN ('demo_inbox')),
  address       text NOT NULL,
  status        text NOT NULL CHECK (status IN ('INVITED', 'ACTIVE', 'REMOVED', 'REVOKED')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  activated_at  timestamptz,
  ended_at      timestamptz,
  ended_reason  text
);
CREATE INDEX guardians_shopper ON guardians (tenant_id, shopper_id);
CREATE INDEX guardians_address ON guardians (tenant_id, channel, address);

CREATE TABLE profile_changes (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL,
  shopper_id     text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('threshold', 'guardian', 'remove_guardian')),
  value          jsonb NOT NULL,
  requested_at   timestamptz NOT NULL,
  effective_at   timestamptz NOT NULL,
  applied_at     timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text
);
-- One pending change per kind per payer.
CREATE UNIQUE INDEX profile_changes_one_pending ON profile_changes (tenant_id, shopper_id, kind) WHERE applied_at IS NULL AND cancelled_at IS NULL;

CREATE TABLE notifications (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL,
  guardian_id      text NOT NULL,
  purchase_id      text,
  kind             text NOT NULL CHECK (kind IN ('invite', 'hold_review', 'authority_change', 'revoked')),
  seq              integer NOT NULL DEFAULT 1,
  body             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- what the message says; never a credential
  status           text NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'FAILED', 'SUPERSEDED')),
  attempts         integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_error       text,
  delivered_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX notifications_hold_seq ON notifications (purchase_id, kind, seq) WHERE purchase_id IS NOT NULL;
CREATE INDEX notifications_due ON notifications (status, next_attempt_at);
CREATE INDEX notifications_guardian ON notifications (tenant_id, guardian_id);

CREATE TABLE demo_inboxes (
  address      text PRIMARY KEY,
  tenant_id    text NOT NULL,
  secret_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payee_history (
  tenant_id      text NOT NULL,
  shopper_id     text NOT NULL,
  payee_key      text NOT NULL,
  first_paid_at  timestamptz NOT NULL,
  purchase_id    text,
  source         text NOT NULL CHECK (source IN ('captured', 'imported', 'backfill')),
  PRIMARY KEY (tenant_id, shopper_id, payee_key)
);

ALTER TABLE holds
  ADD COLUMN approver text NOT NULL DEFAULT 'principal' CHECK (approver IN ('principal', 'guardian', 'legacy')),
  ADD COLUMN guardian_id text,
  ADD COLUMN reason_classes text[] NOT NULL DEFAULT '{}',
  ADD COLUMN credential_hash text,
  ADD COLUMN credential_guardian_id text,
  ADD COLUMN credential_expires_at timestamptz,
  ADD COLUMN credential_seq integer,
  ADD COLUMN failed_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN last_notified_at timestamptz;
UPDATE holds SET approver = 'legacy';

ALTER TABLE holds DROP CONSTRAINT IF EXISTS holds_resolution_check;
ALTER TABLE holds ADD CONSTRAINT holds_resolution_check CHECK (resolution IN ('APPROVED', 'DENIED', 'TIMEOUT', 'REVOKED', 'CANCELLED'));

ALTER TABLE purchases ADD COLUMN protection jsonb;

-- Transfers already captured established a payment relationship.
INSERT INTO payee_history (tenant_id, shopper_id, payee_key, first_paid_at, purchase_id, source)
SELECT DISTINCT ON (p.tenant_id, i.shopper_id, k.payee_key)
       p.tenant_id, i.shopper_id, k.payee_key, p.updated_at, p.id, 'backfill'
FROM purchases p
JOIN intents i ON i.id = p.intent_id
CROSS JOIN LATERAL (
  SELECT CASE WHEN coalesce(i.policy->'payee'->>'email', '') <> '' THEN 'email:' || lower(trim(i.policy->'payee'->>'email')) || '#id:' || (i.policy->'payee'->>'id')
              ELSE 'id:' || (i.policy->'payee'->>'id') END AS payee_key
) k
WHERE p.state = 'CAPTURED' AND i.policy->>'kind' = 'transfer'
ORDER BY p.tenant_id, i.shopper_id, k.payee_key, p.updated_at
ON CONFLICT DO NOTHING;
