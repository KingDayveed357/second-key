-- AP2 delegated verification (strategy doc §5, Horizon 1): the mandate ledger and verification records.
-- The ledger is global, not per tenant: one open mandate presented at two merchants must count against
-- one budget. Keys are hashes of issuer-signed JWTs (see packages/ap2/src/ledger.ts).

CREATE TABLE ap2_verifications (
  id               text PRIMARY KEY,
  tenant_id        text NOT NULL REFERENCES tenants(id),
  idempotency_key  text NOT NULL,
  request_hash     text NOT NULL,
  decision         text NOT NULL CHECK (decision IN ('CONFORMS', 'NONCONFORMING', 'CANNOT_CONFIRM', 'COSIGN_REQUIRED')),
  response         jsonb NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- One row per open mandate that has conformed at least once.
CREATE TABLE ap2_open_mandates (
  ref           text PRIMARY KEY,
  uses          integer NOT NULL CHECK (uses >= 0),
  total_minor   bigint NOT NULL CHECK (total_minor >= 0),
  currency      text,
  first_used_at timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz NOT NULL
);

-- A closed mandate is consumed once, by the verification that accepted it.
CREATE TABLE ap2_presentations (
  closed_ref       text PRIMARY KEY,
  verification_id  text NOT NULL REFERENCES ap2_verifications(id) DEFERRABLE INITIALLY DEFERRED,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE ap2_presentation_opens (
  verification_id  text NOT NULL REFERENCES ap2_verifications(id) DEFERRABLE INITIALLY DEFERRED,
  open_ref         text NOT NULL REFERENCES ap2_open_mandates(ref),
  amount_minor     bigint,
  currency         text,
  PRIMARY KEY (verification_id, open_ref)
);
