-- AP2 in the Protection Desk (10 Nov): who asked for each verification, and, for demo runs, what the
-- run was (product, retailer, which check stopped it). Read-only context; verdicts stay in `response`.
ALTER TABLE ap2_verifications ADD COLUMN principal text;
ALTER TABLE ap2_verifications ADD COLUMN demo jsonb;
CREATE INDEX ap2_verifications_tenant_created ON ap2_verifications (tenant_id, created_at DESC);
