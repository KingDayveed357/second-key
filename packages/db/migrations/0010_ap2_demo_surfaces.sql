-- AP2 agent demo (8 Nov): the public key of each demo payer's own device, which signs her open
-- mandates in the browser (AP2's Trusted Surface). The private key never leaves the browser. Runs are
-- verified against this enrolled key, never against a key sent with the run.
CREATE TABLE ap2_trusted_surfaces (
  shopper_id   text PRIMARY KEY REFERENCES shoppers(id),
  tenant_id    text NOT NULL REFERENCES tenants(id),
  jwk          jsonb NOT NULL,
  thumbprint   text NOT NULL,
  enrolled_at  timestamptz NOT NULL DEFAULT now()
);
