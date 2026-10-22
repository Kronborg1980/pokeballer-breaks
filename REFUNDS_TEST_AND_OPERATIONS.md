# Refund feature — staging-only release checklist

This branch introduces **FULL Stripe refunds only**, accessible from Admin's buyer/order manager and the Stock page's buyer popup. Streamlabs tips are **not** refunded through this feature. Refunds must be requested in the original payment provider for those orders.

## Safety and behavior
- Only a currently authenticated administrator may request a Stripe refund.
- Only a paid Stripe order with a stored Stripe PaymentIntent can be refunded.
- Confirm the exact PBM order reference before sending the full refund.
- Refund requests are claimed in the item-scoped Durable Object before calling Stripe, so two admins cannot initiate duplicate payouts. Stripe also receives a stable idempotency key.
- After an uncertain outcome, **do not retry by creating another refund**: inspect Stripe's dashboard, then reconcile manually. The order may remain in `refund_processing`.
- Stripe refund statuses are retained: `refund_processing`, `refund_pending`, `refunded`, `refund_failed`. Refund webhook events `refund.updated` and `refund.failed` update these states.
- Refunds **never automatically restock** the card/bundle. Manual physical inventory decisions remain separate.
- Clearing paid or refunded orders via the old reset/purge feature is blocked to preserve financial records.
- No partial refunds, fee reversals, cancellation of pending refunds, or automatic refund emails have been implemented.

## Required Stripe setup
- [ ] Add **Refunds: write** permission to the restricted Stripe API key in the PBM admin panel.
- [ ] Subscribe the signed Stripe webhook to `refund.updated` and `refund.failed` in addition to checkout events.
- [ ] Confirm the payment processing and receipt endpoint hardening in separate PR #13 before production deployment.
- [ ] Ensure `worker.js` in the actual deployed Cloudflare Worker comes from the expected repo. Another repo named `pbm-worker` also has its own copy; this branch does not deploy that copy.

## Tests before enabling
1. Test Stripe card payment for one sample pack; verify the PaymentIntent is recorded.
2. In Admin > Orders, initiate a refund, cancel one confirmation, then confirm it using the exact order code.
3. Verify the refund appears in Stripe and shows as refunded or refund pending; original inventory should not change.
4. In Stock > Buyers, check the status and absence of a repeat-refund button.
5. Attempt a second refund, including from two admins simultaneously; it must not initiate a second Stripe payout.
6. Verify the reset/purge button cannot delete a paid or refunded financial record.
7. Simulate a Stripe HTTP 5xx response/network failure and verify the UI instructs operator to check Stripe rather than blindly retry.
8. Test signed `refund.updated` / `refund.failed` webhook transitions.
9. Confirm manual Streamlabs orders show no Stripe refund button.

## Streamlabs on-screen alerts for Stripe payments
Stripe completion calls `confirmPaidOrder` and `fireAlert`. `fireAlert` pushes to the built-in overlay if enabled, and sends a **custom donation-type alert** to the Streamlabs Alerts API when `alertsEnabled`, `alertToStreamlabs`, and the Streamlabs OAuth access token are configured correctly. The alert is a **custom overlay event**, not a native Streamlabs payment or tip transaction.
- [ ] Turn on 'alerts enabled' and 'send to Streamlabs' in Admin.
- [ ] Enter a working access token with the Streamlabs alerts permission.
- [ ] Run the 'Test alert' button to confirm Mike sees an alert in the actual on-screen overlay.
- [ ] In Stripe **test mode**, complete a successful test card checkout and confirm only one expected on-screen notification appears.
- [ ] If the broadcast should instead use the PBM overlay, enable 'alert to overlay' and add the PBM overlay URL as a browser source.
- [ ] Do not rely on Streamlabs alerts alone as financial proof; use paid order status and Stripe dashboard for reconciliation.

**This branch is not deployed, and payment/refund flows have not been end-to-end tested.**
