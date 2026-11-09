# Vendored AP2 schemas

- Source: https://github.com/google-agentic-commerce/AP2, `code/sdk/schemas/` (`ap2/` and `ucp/`)
- Commit: `e1ea56db72a6385bce3e5c1112b3a56ce60acb43` (29 Apr 2026), AP2 v0.2
- Licence: Apache-2.0 (upstream `LICENSE`)
- Files are unchanged. To update, copy the directory from a newer commit, record it here and run the tests.

## Known upstream issue

`ap2/types/receipt_status.json` declares `$id` `https://ap2-protocol.org/schemas/receipt-status.json`, but both receipt
schemas reference it as `types/receipt_status.json`. `src/schemas.ts` therefore registers every schema under the URL its
path implies instead of its declared `$id`.
