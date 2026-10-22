# PBM Breaks — Payment launch gate (test mode first)

**Status: NOT APPROVED FOR LIVE CHARGES.** This branch is a focused hardening pass, not proof of production readiness.
Do not change the admin payment mode to `stripe` until the merchant is approved and these checks pass.

## Merchant and compliance prerequisites

- [ ] The seller/fulfillment entity, bank account, country, legal name, support email, and payout identity match the Stripe account.
- [ ] Get Stripe's **written eligibility decision for the exact products**: fixed-count physical booster bundles opened on YouTube, plus any random team/spot breaks, prize wheels or drawings.
- [ ] Publish accurate shipping timelines, who receives which cards, refund/cancellation rules, privacy terms, merchant contact details, and tax/consumer disclosures.
- [ ] Run the same product-policy review if choosing Shopify Payments; Shopify does not provide an automatic exception for paid games of chance.

## Cloudflare / Stripe configuration

- [ ] Verify the production Worker is deployed from the intended authoritative GitHub repo (`pokeballer-breaks` and `pbm-worker` both contain a `worker.js`).
- [ ] Configure **test-mode** restricted API key and webhook signing secret in the Worker environment or admin.
- [ ] Set the admin payment mode to Stripe **only on a separate test/staging environment** initially.
- [ ] Use the admin's generated webhook URL and enable `checkout.session.completed`, `checkout.session.expired`, `checkout.session.async_payment_succeeded`, and `checkout.session.async_payment_failed`.
- [ ] Verify Stripe-signature failures return 400 and do not change order stock/status.
- [ ] Verify backend `/api/settings` reports `stripeReady` correctly, restricted API key check passes, and no API credentials appear in public settings.

## Payment test matrix — automate where possible

1. Successful card payment: exact amount/currency; order becomes PAID once, stock falls once, owner receives correct break name and order reference.
2. Webhook redelivery: repeat the signed `checkout.session.completed` event; no extra stock deduction, confirmation, or duplicate paid order.
3. Simultaneous last-pack purchases: no overselling; losing customer receives actionable error, not a charge.
4. Abandoned checkout: after Stripe's session expires, stock returns to inventory and the email restriction clears.
5. Webhook delivery outage: emulate transient Durable Object error; Worker sends 500, Stripe retries and PAID status appears after recovery.
6. Boundary timing: late paid event around checkout expiration should not release a paid reservation.
7. Declined card and async payment failures: no PAID status, released holds, customer sees consistent state.
8. Success page opened without payment: querying status must never falsely indicate PAID.
9. Attempt to alter quantities/prices in browser payload: server uses its own item price and stock restrictions.
10. Admin re-stock, refund, chargeback, partial refund, dispute, and fulfillment: operational procedures documented and tested.

## Known gaps — do not claim bulletproof

- Confirmation emails/alerts are **best-effort** downstream of the durable paid transition. Add a durable notification outbox/reconciliation worker before large-scale sales.
- Stripe webhooks and Worker alarms are asynchronous. Reconcile Stripe sessions and OrderDesk records periodically; alert for paid-in-Stripe but missing/mismatched in PBM.
- No automated refund/dispute/partial-refund synchronization or tax engine is implemented in this branch.
- The Worker uses live server-side secrets; do not paste keys into GitHub or the chat.
- Stripe `expires_at` and the OrderDesk expiration now include a five-minute webhook grace buffer, but no delay can be proved impossible.
- Enabling live mode still requires staging tests, payment-provider approval, monitoring/alerts, and an operator rollback plan.

## Release and rollback

- Deploy this branch only to test/staging with Stripe test credentials; check Cloudflare logs and Stripe Events after each scenario.
- Merge/deploy to production only after tests, code review, payment approval and documentation have passed.
- Start with a low-value approved product and reconcile every transaction manually during rollout.
- Roll back by selecting Streamlabs in the admin; keep Stripe webhooks active for previously opened sessions until all reconcile.
