-- AP2 settlement binding (strategy doc §5, POST /v2/settlements). A CONFORMS verification is bound to
-- one PayPal order, which must hold exactly the verified checkout. Only the worker's executor moves
-- the money; the settlement row is its single-use capability (MATCHED -> CAPTURING, once).

-- What a conforming verification with a payment mandate allows PayPal to hold: currency, total,
-- line items, and the closed-mandate references the receipts bind to. Null when nothing may settle.
ALTER TABLE ap2_verifications ADD COLUMN settlement jsonb;

CREATE TABLE ap2_settlements (
  id                       text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants(id),
  verification_id          text NOT NULL UNIQUE REFERENCES ap2_verifications(id),
  idempotency_key          text NOT NULL,
  request_hash             text NOT NULL,
  paypal_order_id          text NOT NULL UNIQUE,
  paypal_authorization_id  text UNIQUE,
  payee_merchant_id        text NOT NULL,
  amount_minor             bigint NOT NULL CHECK (amount_minor >= 0),
  currency                 text NOT NULL,
  expectation              jsonb NOT NULL,
  state                    text NOT NULL CHECK (state IN ('MATCHED', 'REFUSED', 'CAPTURING', 'CAPTURED', 'CAPTURE_DECLINED', 'NEEDS_RECONCILE', 'VOIDING', 'VOIDED')),
  diffs                    jsonb NOT NULL DEFAULT '[]',
  paypal_capture_id        text UNIQUE,
  network_reference        text,
  consumed_at              timestamptz,
  settled_at               timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, idempotency_key)
);

-- Every money call is journaled before it is sent (as paypal_calls does for purchases).
CREATE TABLE ap2_settlement_calls (
  id             bigserial PRIMARY KEY,
  settlement_id  text NOT NULL REFERENCES ap2_settlements(id),
  op             text NOT NULL CHECK (op IN ('capture', 'void')),
  request_id     text NOT NULL,
  status         text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  http_status    integer,
  debug_id       text,
  response       jsonb,
  error          text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
