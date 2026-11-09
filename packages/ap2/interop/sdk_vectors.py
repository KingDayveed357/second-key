"""Interop gate between @witness/ap2 and Google's AP2 reference SDK (Python).

  generate <ap2-clone> <out.json>   build mandates with the reference SDK; the TS tests verify them
  verify   <ap2-clone> <in.json>    verify mandates built by @witness/ap2 with the reference SDK
  constraints <ap2-clone> <out.json>  the SDK's verdicts on the constraint cases in test/constraint-cases.json

<ap2-clone> is a checkout of https://github.com/google-agentic-commerce/AP2 at the commit recorded
in schemas/VERSION.md. Run with the SDK's pinned dependencies (see interop/README.md).
"""

from __future__ import annotations

import json
import sys
import time


def load_sdk(clone: str) -> None:
    sys.path.insert(0, f'{clone}/code/sdk/python')


def new_key(kid: str):
    from cryptography.hazmat.primitives.asymmetric import ec
    from jwcrypto.jwk import JWK

    d = json.loads(JWK.from_pyca(ec.generate_private_key(ec.SECP256R1())).export())
    d['kid'] = kid
    return JWK.from_json(json.dumps(d))


def public(key) -> dict:
    return json.loads(key.export_public())


def sign_checkout(merchant_key, payload: dict) -> str:
    from jwcrypto.jws import JWS

    jws = JWS(json.dumps(payload).encode('utf-8'))
    jws.add_signature(merchant_key, protected={'alg': 'ES256', 'typ': 'JWT', 'kid': 'merchant-1'})
    return jws.serialize(compact=True)


def join(tokens: list[str]) -> str:
    return '~~'.join(t[:-1] if i < len(tokens) - 1 and t.endswith('~') else t for i, t in enumerate(tokens))


def generate(out_path: str) -> None:
    from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
    from ap2.sdk.generated.checkout_mandate import CheckoutMandate
    from ap2.sdk.generated.open_checkout_mandate import (
        AllowedMerchants,
        Item as AcceptableItem,
        LineItemRequirements,
        LineItems,
        OpenCheckoutMandate,
    )
    from ap2.sdk.generated.open_payment_mandate import (
        AllowedPayees,
        AmountRange,
        OpenPaymentMandate,
        PaymentReference,
    )
    from ap2.sdk.generated.payment_mandate import PaymentMandate
    from ap2.sdk.generated.types.amount import Amount
    from ap2.sdk.generated.types.merchant import Merchant
    from ap2.sdk.generated.types.payment_instrument import PaymentInstrument
    from ap2.sdk.mandate import MandateClient
    from ap2.sdk.payment_mandate_chain import PaymentMandateChain
    from ap2.sdk.sdjwt import common, kb_sd_jwt
    from ap2.sdk.utils import compute_sha256_b64url

    client = MandateClient()
    issuer, agent, sub_agent, merchant_key = (new_key(k) for k in ('issuer-1', 'agent-1', 'sub-agent-1', 'merchant-1'))
    now = int(time.time())
    merchant = Merchant(id='merchant_1', name='Demo Merchant', website='https://demo-merchant.example')
    price = 19900
    checkout = {
        'id': 'chk_1',
        'merchant': merchant.model_dump(exclude_none=True),
        'line_items': [{
            'id': 'li_1',
            'item': {'id': 'sku_gold_9', 'title': 'SuperShoe Gold, women\'s 9', 'price': price},
            'quantity': 1,
            'totals': [{'type': 'subtotal', 'amount': price}, {'type': 'total', 'amount': price}],
        }],
        'status': 'ready_for_complete',
        'currency': 'USD',
        'totals': [{'type': 'subtotal', 'amount': price}, {'type': 'total', 'amount': price}],
        'links': [{'type': 'terms_of_service', 'url': 'https://demo-merchant.example/tos'}],
    }
    checkout_jwt = sign_checkout(merchant_key, checkout)
    checkout_hash = compute_sha256_b64url(checkout_jwt)

    def open_checkout(holder_key) -> OpenCheckoutMandate:
        return OpenCheckoutMandate(
            constraints=[
                LineItems(items=[LineItemRequirements(id='line_1', acceptable_items=[AcceptableItem(id='sku_gold_9', title='SuperShoe Gold')], quantity=1)]),
                AllowedMerchants(allowed=[merchant]),
            ],
            cnf={'jwk': public(holder_key)},
            iat=now - 60,
            exp=now + 3600,
        )

    closed_checkout = CheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=checkout_hash)
    open_checkout_tok = client.create(payloads=[open_checkout(agent)], issuer_key=issuer)
    checkout_chain = client.present(holder_key=agent, mandate_token=open_checkout_tok, payloads=[closed_checkout], aud='merchant', nonce='n-checkout')
    checkout_loose = client.present(holder_key=agent, mandate_token=open_checkout_tok, payloads=[closed_checkout], aud='merchant', nonce='n-checkout', hash_mode='issuer_jwt_hash')

    # Three hops: the agent re-delegates the open checkout to a sub-agent, which closes it.
    hop1 = client.present(holder_key=agent, mandate_token=open_checkout_tok, payloads=[open_checkout(sub_agent)], aud='sub-agent', nonce='n-sub')
    hop1_token = hop1.split('~~')[1]
    hop2 = kb_sd_jwt.create(prev_token=common.parse_token(hop1_token), holder_key=sub_agent, payload=closed_checkout, aud='merchant', nonce='n-checkout').sd_jwt_issuance
    three_hop = join([open_checkout_tok, hop1_token, hop2])

    open_checkout_ref = common.compute_sd_hash(common.parse_token(open_checkout_tok))
    open_payment_tok = client.create(
        payloads=[OpenPaymentMandate(
            constraints=[
                AmountRange(currency='USD', max=20000, min=0),
                AllowedPayees(allowed=[merchant]),
                PaymentReference(conditional_transaction_id=open_checkout_ref),
            ],
            cnf={'jwk': public(agent)},
            iat=now - 60,
            exp=now + 3600,
        )],
        issuer_key=issuer,
    )
    payment_chain = client.present(
        holder_key=agent,
        mandate_token=open_payment_tok,
        payloads=[PaymentMandate(
            transaction_id=checkout_hash,
            payee=merchant,
            payment_amount=Amount(amount=price, currency='USD'),
            payment_instrument=PaymentInstrument(id='pi_1', type='paypal'),
        )],
        aud='credential-provider',
        nonce='n-payment',
    )

    # The reference SDK must accept what it just built, or the vectors prove nothing.
    provider = lambda _t: public_jwk(issuer)  # noqa: E731
    for chain, aud, nonce in ((checkout_chain, 'merchant', 'n-checkout'), (checkout_loose, 'merchant', 'n-checkout'), (three_hop, 'merchant', 'n-checkout')):
        payloads = client.verify(chain, provider, expected_aud=aud, expected_nonce=nonce)
        violations = CheckoutMandateChain.parse([payloads[0], payloads[-1]]).verify(expected_checkout_hash=checkout_hash, checkout_jwt=checkout_jwt)
        assert violations == [], violations
    payloads = client.verify(payment_chain, provider, expected_aud='credential-provider', expected_nonce='n-payment')
    violations = PaymentMandateChain.parse(payloads).verify(expected_transaction_id=checkout_hash, expected_open_checkout_hash=open_checkout_ref)
    assert violations == [], violations

    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({
            'generator': 'interop/sdk_vectors.py generate (Google AP2 reference SDK, Python)',
            'created': now,
            'issuer_jwk': public(issuer),
            'merchant_jwk': public(merchant_key),
            'checkout_jwt': checkout_jwt,
            'checkout_hash': checkout_hash,
            'open_checkout': open_checkout_tok,
            'open_payment': open_payment_tok,
            'checkout_chain': checkout_chain,
            'checkout_chain_issuer_jwt_hash': checkout_loose,
            'checkout_three_hop': three_hop,
            'payment_chain': payment_chain,
        }, f, indent=2)
        f.write('\n')
    print(f'reference SDK built and self-verified 4 chains -> {out_path}')


def public_jwk(key):
    from jwcrypto.jwk import JWK

    return JWK.from_json(key.export_public())


def verify(in_path: str) -> None:
    from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
    from ap2.sdk.mandate import MandateClient
    from ap2.sdk.payment_mandate_chain import PaymentMandateChain
    from jwcrypto.jwk import JWK

    with open(in_path, encoding='utf-8') as f:
        v = json.load(f)
    client = MandateClient()
    issuer = JWK.from_json(json.dumps(v['issuer_jwk']))
    provider = lambda _t: issuer  # noqa: E731
    t = v['now']
    failures = 0

    def check(name, fn):
        nonlocal failures
        try:
            result = fn()
            ok = result == []
            print(f'{"PASS" if ok else "FAIL"} {name}{"" if ok else f": {result}"}')
            failures += 0 if ok else 1
        except Exception as e:  # noqa: BLE001  (report every failure, keep going)
            print(f'FAIL {name}: {type(e).__name__}: {e}')
            failures += 1

    def checkout(chain_key):
        payloads = client.verify(v[chain_key], provider, expected_aud='merchant', expected_nonce='n-checkout', current_time=t)
        return CheckoutMandateChain.parse([payloads[0], payloads[-1]]).verify(expected_checkout_hash=v['checkout_hash'], checkout_jwt=v['checkout_jwt'])

    def payment():
        payloads = client.verify(v['payment_chain'], provider, expected_aud='credential-provider', expected_nonce='n-payment', current_time=t)
        return PaymentMandateChain.parse(payloads).verify(expected_transaction_id=v['checkout_hash'], expected_open_checkout_hash=v['open_checkout_ref'])

    for key in ('checkout_chain', 'checkout_chain_issuer_jwt_hash', 'checkout_three_hop'):
        check(key, lambda key=key: checkout(key))
    check('payment_chain', payment)

    def must_reject(name, chain, aud='merchant', nonce='n-checkout'):
        def run():
            try:
                client.verify(chain, provider, expected_aud=aud, expected_nonce=nonce, current_time=t)
            except Exception:  # noqa: BLE001
                return []
            return ['accepted a chain it should reject']
        check(name, run)

    must_reject('tampered: forged KB hop', v['forged_checkout_chain'])
    must_reject('tampered: aud', v['checkout_chain'], aud='another-merchant')

    from ap2.sdk.receipt_wrapper import ReceiptClient

    receipt_key = JWK.from_json(json.dumps(v['receipt_jwk']))
    receipts = ReceiptClient()
    for name, is_payment in (('checkout_receipt', False), ('payment_receipt', True)):
        def run(name=name, is_payment=is_payment):
            r = receipts.verify_receipt(v[name], receipt_key, lambda ref, name=name: ref == v[f'{name}_reference'], is_payment_receipt=is_payment)
            return [] if r == {'verified': True} else [r]
        check(f'{name} (signed by @witness/ap2)', run)
    sys.exit(1 if failures else 0)


def constraints(out_path: str) -> None:
    """Run the shared constraint cases through the SDK's evaluators and record each verdict."""
    import os

    from ap2.sdk.constraints import MandateContext, check_checkout_constraints, check_payment_constraints
    from ap2.sdk.generated.open_checkout_mandate import OpenCheckoutMandate
    from ap2.sdk.generated.open_payment_mandate import OpenPaymentMandate
    from ap2.sdk.generated.payment_mandate import PaymentMandate
    from ap2.sdk.generated.types.checkout import Checkout

    cases_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'test', 'constraint-cases.json')
    with open(cases_path, encoding='utf-8') as f:
        cases = json.load(f)['cases']
    out = {}
    for c in cases:
        try:
            if c['kind'] == 'checkout':
                violations = check_checkout_constraints(OpenCheckoutMandate.model_validate(c['open']), Checkout.model_validate(c['checkout']))
            else:
                u = c.get('usage') or {}
                ctx = MandateContext(total_amount=u.get('totalMinor', 0), total_uses=u.get('uses', 0), last_used_date=u.get('lastUsedAt'))
                violations = check_payment_constraints(OpenPaymentMandate.model_validate(c['open']), PaymentMandate.model_validate(c['closed']), open_checkout_hash=c.get('open_checkout_hash'), mandate_context=ctx)
            out[c['name']] = {'result': 'fail' if violations else 'pass', 'violations': violations}
        except Exception as e:  # noqa: BLE001
            out[c['name']] = {'result': 'error', 'violations': [f'{type(e).__name__}: {e}']}
    out['e2e: holder withholds acceptable_items, buys another SKU'] = withheld_items_end_to_end()
    with open(out_path, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, indent=2)
        f.write('\n')
    print(f'reference SDK evaluated {len(out)} constraint cases -> {out_path}')


def withheld_items_end_to_end() -> dict:
    """Through the SDK's own create/present/verify: the agent drops the acceptable-item disclosure
    from the open checkout it presents and closes it for a different product."""
    from ap2.sdk.checkout_mandate_chain import CheckoutMandateChain
    from ap2.sdk.generated.checkout_mandate import CheckoutMandate
    from ap2.sdk.generated.open_checkout_mandate import Item as AcceptableItem, LineItemRequirements, LineItems, OpenCheckoutMandate
    from ap2.sdk.mandate import MandateClient
    from ap2.sdk.utils import b64url_decode, compute_sha256_b64url

    client = MandateClient()
    issuer, agent, merchant_key = (new_key(k) for k in ('issuer-1', 'agent-1', 'merchant-1'))
    open_tok = client.create(
        payloads=[OpenCheckoutMandate(
            constraints=[LineItems(items=[LineItemRequirements(id='line_1', acceptable_items=[AcceptableItem(id='sku_gold_9', title='SuperShoe Gold')], quantity=1)])],
            cnf={'jwk': public(agent)},
        )],
        issuer_key=issuer,
    )
    parts = open_tok.split('~')
    kept = [d for d in parts[1:-1] if 'sku_gold_9' not in b64url_decode(d).decode('utf-8')]
    withheld = '~'.join([parts[0], *kept]) + '~'
    price = 25000
    checkout = {
        'id': 'chk_x', 'currency': 'USD', 'status': 'ready_for_complete', 'links': [],
        'line_items': [{'id': 'li_1', 'item': {'id': 'sku_white_9', 'title': 'Cloud White', 'price': price}, 'quantity': 1, 'totals': [{'type': 'total', 'amount': price}]}],
        'totals': [{'type': 'subtotal', 'amount': price}, {'type': 'total', 'amount': price}],
    }
    checkout_jwt = sign_checkout(merchant_key, checkout)
    chain = client.present(
        holder_key=agent, mandate_token=withheld,
        payloads=[CheckoutMandate(checkout_jwt=checkout_jwt, checkout_hash=compute_sha256_b64url(checkout_jwt))],
        aud='merchant', nonce='n-checkout',
    )
    payloads = client.verify(chain, lambda _t: public_jwk(issuer), expected_aud='merchant', expected_nonce='n-checkout')
    violations = CheckoutMandateChain.parse([payloads[0], payloads[-1]]).verify(checkout_jwt=checkout_jwt)
    return {'result': 'fail' if violations else 'pass', 'violations': violations, 'disclosures_dropped': len(parts) - 2 - len(kept)}


if __name__ == '__main__':
    mode, clone, path = sys.argv[1:4]
    load_sdk(clone)
    {'generate': generate, 'verify': verify, 'constraints': constraints}[mode](path)
