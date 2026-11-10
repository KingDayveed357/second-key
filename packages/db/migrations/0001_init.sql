-- Second Key schema v1. See docs/architecture.md §7.
-- Money is integer cents. Every table that holds customer data carries tenant_id.

CREATE TABLE tenants (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  paypal_merchant_id  text NOT NULL,          -- the payee every order must pay
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE api_keys (
  id          text PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  principal   text NOT NULL,                  -- e.g. agent:demo, ops:dave, shopper:shp_x, admin
  scopes      text[] NOT NULL,
  key_hash    text NOT NULL UNIQUE,           -- sha256 of a 192-bit random key; key shown once
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz
);

CREATE TABLE shoppers (
  id            text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  display_name  text NOT NULL,
  vault_id      text,                         -- PayPal saved-wallet payment token (Gate 2)
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE intents (
  id             text PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  shopper_id     text NOT NULL REFERENCES shoppers(id),
  lineage_id     text NOT NULL,               -- all versions of one intent share this
  version        integer NOT NULL CHECK (version >= 1),
  status         text NOT NULL CHECK (status IN ('DRAFT', 'CONFIRMED', 'REVOKED', 'SUPERSEDED')),
  source_text    text,
  policy         jsonb NOT NULL,
  policy_digest  text,
  ambiguities    jsonb NOT NULL DEFAULT '[]',
  compiler       jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  confirmed_at   timestamptz,
  revoked_at     timestamptz,
  UNIQUE (lineage_id, version),
  CHECK (status = 'DRAFT' OR policy_digest IS NOT NULL)
);
CREATE INDEX intents_tenant ON intents (tenant_id);

-- A confirmed intent is frozen: its policy and digest can never change.
CREATE FUNCTION intents_freeze() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'DRAFT' AND (NEW.policy IS DISTINCT FROM OLD.policy OR NEW.policy_digest IS DISTINCT FROM OLD.policy_digest) THEN
    RAISE EXCEPTION 'intent % is % and immutable', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER intents_freeze BEFORE UPDATE ON intents FOR EACH ROW EXECUTE FUNCTION intents_freeze();

CREATE TABLE purchases (
  id                       text PRIMARY KEY,
  tenant_id                text NOT NULL REFERENCES tenants(id),
  intent_id                text NOT NULL REFERENCES intents(id),
  intent_version           integer NOT NULL,
  policy_digest            text NOT NULL,
  agent_principal          text NOT NULL,
  idempotency_key          text NOT NULL,
  request_hash             text NOT NULL,
  request                  jsonb NOT NULL,
  adapter                  text NOT NULL DEFAULT 'standard',
  state                    text NOT NULL CHECK (state IN (
                             'SCREENING','REJECTED','AUTHORIZING','AUTH_FAILED','VERIFYING','HELD',
                             'CAPTURE_APPROVED','CAPTURING','CAPTURE_PENDING','NEEDS_RECONCILE','CAPTURED',
                             'CAPTURE_DECLINED','VOIDING','VOIDED','DISPUTED','DISPUTE_RESOLVED','REFUNDED')),
  version                  integer NOT NULL DEFAULT 0,      -- optimistic lock for transitions
  outcome                  text CHECK (outcome IN ('REJECT', 'HOLD', 'CAPTURE', 'VOID')),
  reasons                  jsonb NOT NULL DEFAULT '[]',
  retailer                 text,
  cart                     jsonb,
  cart_digest              text,
  facts                    jsonb,
  amount_cents             integer CHECK (amount_cents >= 0),
  currency                 text,
  paypal_order_id          text UNIQUE,
  paypal_authorization_id  text UNIQUE,
  paypal_capture_id        text UNIQUE,
  authorized_at            timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, agent_principal, idempotency_key)
);
CREATE INDEX purchases_state ON purchases (state);
CREATE INDEX purchases_intent ON purchases (intent_id);

CREATE TABLE checks (
  id              bigserial PRIMARY KEY,
  purchase_id     text NOT NULL REFERENCES purchases(id),
  phase           text NOT NULL CHECK (phase IN ('SCREEN', 'VERIFY', 'RECHECK')),
  check_id        text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('deterministic', 'ai')),
  result          text NOT NULL CHECK (result IN ('pass', 'fail', 'unknown')),
  detail          text NOT NULL,
  line            text,
  model           text,
  prompt_version  text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checks_purchase ON checks (purchase_id);

CREATE TABLE decisions (
  id           bigserial PRIMARY KEY,
  purchase_id  text NOT NULL REFERENCES purchases(id),
  outcome      text NOT NULL CHECK (outcome IN ('REJECT', 'HOLD', 'CAPTURE', 'VOID')),
  reasons      jsonb NOT NULL,
  decided_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX decisions_purchase ON decisions (purchase_id);

-- The single-use capability to capture. Written only by the decision engine,
-- consumed only by the executor with one atomic UPDATE.
CREATE TABLE approvals (
  id                       text PRIMARY KEY,
  purchase_id              text NOT NULL UNIQUE REFERENCES purchases(id),
  tenant_id                text NOT NULL REFERENCES tenants(id),
  paypal_order_id          text NOT NULL,
  paypal_authorization_id  text NOT NULL,
  payee_merchant_id        text NOT NULL,
  amount_cents             integer NOT NULL CHECK (amount_cents > 0),
  currency                 text NOT NULL,
  cart_digest              text NOT NULL,
  policy_digest            text NOT NULL,
  intent_version           integer NOT NULL,
  request_id               text NOT NULL UNIQUE,   -- deterministic PayPal-Request-Id for the capture
  expires_at               timestamptz NOT NULL,
  used_at                  timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

-- Journal of every PayPal call that can move money, written BEFORE the call.
CREATE TABLE paypal_calls (
  id           bigserial PRIMARY KEY,
  purchase_id  text NOT NULL REFERENCES purchases(id),
  op           text NOT NULL CHECK (op IN ('create-order', 'capture', 'void')),
  request_id   text NOT NULL,
  status       text NOT NULL CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  http_status  integer,
  debug_id     text,
  request      jsonb,
  response     jsonb,
  error        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX paypal_calls_purchase ON paypal_calls (purchase_id);

CREATE TABLE webhook_events (
  event_id         text PRIMARY KEY,           -- PayPal's event id: duplicates are dropped here
  event_type       text NOT NULL,
  resource_type    text,
  resource_id      text,
  transmission_id  text,
  verified         boolean NOT NULL,
  payload          jsonb NOT NULL,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  outcome          text
);

CREATE TABLE holds (
  purchase_id       text PRIMARY KEY REFERENCES purchases(id),
  token_hash        text,
  token_expires_at  timestamptz,
  auto_void_at      timestamptz NOT NULL,
  notified_at       timestamptz,
  resolved_at       timestamptz,
  resolution        text CHECK (resolution IN ('APPROVED', 'DENIED', 'TIMEOUT', 'REVOKED'))
);

CREATE TABLE disputes (
  id                 text PRIMARY KEY,
  paypal_dispute_id  text NOT NULL UNIQUE,
  purchase_id        text REFERENCES purchases(id),
  status             text NOT NULL,
  evidence           jsonb,
  steps              jsonb NOT NULL DEFAULT '[]',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Append-only, hash-chained audit log. Each epoch is its own chain (a demo reset starts a new one).
CREATE TABLE audit_epochs (
  epoch       integer PRIMARY KEY,
  started_at  timestamptz NOT NULL DEFAULT now(),
  reason      text NOT NULL
);
INSERT INTO audit_epochs (epoch, reason) VALUES (1, 'initial');

CREATE TABLE audit_log (
  epoch        integer NOT NULL REFERENCES audit_epochs(epoch),
  seq          bigint NOT NULL,
  tenant_id    text,
  purchase_id  text,
  event_type   text NOT NULL,
  payload      jsonb NOT NULL,
  at           timestamptz NOT NULL,
  prev_hash    text NOT NULL,
  hash         text NOT NULL UNIQUE,
  PRIMARY KEY (epoch, seq)
);
CREATE INDEX audit_log_purchase ON audit_log (purchase_id);

CREATE FUNCTION audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only (% blocked)', TG_OP;
END $$;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();
