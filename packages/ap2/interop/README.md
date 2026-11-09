# AP2 interop gate

`@witness/ap2` is checked against Google's AP2 reference SDK (Python) in both directions, at the commit recorded in
[`../schemas/VERSION.md`](../schemas/VERSION.md) (`e1ea56d`, AP2 v0.2).

| Direction | What | Where |
|---|---|---|
| Spec → us | The encoded example tokens in the AP2 docs: disclosures, KB-hop signatures under the open mandate's `cnf` key, `sd_hash`, `checkout_hash`, `payment.reference`, schemas | `test/spec-vectors.test.ts` |
| SDK → us | Chains the SDK built and verified itself: checkout (`sd_hash`), checkout (`issuer_jwt_hash`), three hops with a sub-agent, payment. All verify, the merchant signature included, and the payment cross-checks against the checkout | `test/interop.test.ts`, `test/vectors/python-sdk.json` |
| Us → SDK | The same four chain shapes built by `@witness/ap2`, verified by the SDK's `MandateClient.verify` plus `CheckoutMandateChain` / `PaymentMandateChain` (constraints included); the SDK rejects our forged and wrong-audience cases. Our Checkout and Payment Receipts pass the SDK's `ReceiptClient.verify_receipt` | `interop/sdk_vectors.py verify` |
| Constraints, both | 15 shared cases (`test/constraint-cases.json`) through our evaluators and the SDK's: 11 agree, 4 differ, each differing case citing the spec text we follow. Plus one end-to-end case through the SDK's own create/present/verify | `test/constraint-parity.test.ts`, `interop/sdk_vectors.py constraints` |

## Result (2 Nov 2026; constraints and receipts 5 Nov)

All directions pass. The supportable claim is: **verifies AP2 v0.2 mandates built by the reference SDK, and
builds mandates the reference SDK accepts, for the chain shapes above.** This is not certification. Not covered yet:

- root signatures of the spec examples, because the example issuer key isn't published;
- `x5c` root keys;
- receipts signed by the SDK and verified by us;
- any implementation other than the reference SDK.

## Where the reference SDK and the spec differ

We follow the spec text (`docs/ap2/checkout_mandate.md`, `payment_mandate.md` at the pinned commit):

| Case | Spec | Reference SDK |
|---|---|---|
| Cart misses a required item | Max flow must equal the total required and the total in the cart; "Item: Red Style" alone is listed as invalid | Passes: it only checks that the cart fits |
| Holder withholds the `acceptable_items` disclosures | An item matches only the *revealed* acceptable items | Empty list = wildcard. End to end through the SDK's own `present`/`verify`, dropping one disclosure lets the agent close the mandate for a different product with no violation |
| Budget of 0.29 | Spend ≤ max | `int(0.29 * 100)` = 28, so 29 cents is refused |
| Recurrence frequency | Presentations must be separated by the frequency | Frequency is not evaluated |

The canonical schemas are also stricter than the SDK's models: every Open Payment Mandate must contain
`payment.reference`, and the open-mandate schemas list the standard constraint types exhaustively. We validate the
standard ones against the schema and evaluate extension constraints (outside `checkout.`/`payment.`) on their own;
an unknown one is unresolved, as the spec requires.

## Re-run

```bash
git clone https://github.com/google-agentic-commerce/AP2.git ap2 && git -C ap2 checkout e1ea56db72a6385bce3e5c1112b3a56ce60acb43
python3.12 -m venv venv && venv/bin/pip install cryptography==46.0.5 jwcrypto==1.5.6 pydantic==2.12.5 sd-jwt==0.10.4

# SDK -> us: regenerate the vectors (new keys each run), then run the tests
venv/bin/python -I packages/ap2/interop/sdk_vectors.py generate ap2 packages/ap2/test/vectors/python-sdk.json
pnpm vitest run packages/ap2

# us -> SDK (chains and receipts)
pnpm tsx packages/ap2/test/interop-export.ts /tmp/ap2-ours.json
venv/bin/python -I packages/ap2/interop/sdk_vectors.py verify ap2 /tmp/ap2-ours.json

# constraints: the SDK's verdicts on the shared cases
venv/bin/python -I packages/ap2/interop/sdk_vectors.py constraints ap2 packages/ap2/test/vectors/python-sdk-constraints.json
```

The SDK's own dependencies are pinned in its `pyproject.toml`; Python 3.12 was used (3.15 lacks wheels for them).
