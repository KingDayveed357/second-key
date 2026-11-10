-- Stage 5: disputes on Second Key captures (ADR-0010). Extends the (so far unused) table from 0001
-- rather than replacing it. A buyer opens the dispute in PayPal; ops attaches it; Second Key verifies it
-- is against this tenant's capture; evidence is submitted only after a reviewer approves the text.
-- `id` and `paypal_dispute_id` both hold PayPal's dispute_id. No money moves through this table.
ALTER TABLE disputes
  ADD COLUMN tenant_id             text REFERENCES tenants(id),
  ADD COLUMN reason                text,
  ADD COLUMN amount_cents          integer,
  ADD COLUMN currency              text,
  ADD COLUMN allowed_actions       jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN outcome               text,
  ADD COLUMN evidence_text         text,
  ADD COLUMN evidence_submitted_by text,
  ADD COLUMN evidence_submitted_at timestamptz,
  ADD COLUMN simulated_verdict     boolean NOT NULL DEFAULT false;
CREATE INDEX disputes_tenant_idx ON disputes (tenant_id, created_at DESC);
