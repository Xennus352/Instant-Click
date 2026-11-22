# Dinger payment integration status

## Implemented server-side safeguards

- `GET /api/v1/credits/packages` exposes only enabled packages configured by an authorized administrator. Values are read from `CreditPackage`; no bundle amount or credit price is hardcoded.
- Admin package writes accept only MMK integer amounts from 500 to 999,999,999. Existing audit records retain the before/after package snapshot and operator reason.
- `POST /api/webhooks/dinger` requires the explicit `DINGER_CALLBACKS_ENABLED=true` gate and a 32-byte callback key. It decrypts the provider's Base64 AES-256-ECB/PKCS7 payload, constant-time verifies SHA-256 of the exact plaintext, validates the signed callback schema, checks provider/method, and matches the order ID and amount to the server-side order snapshot.
- A verified success is credited through the immutable wallet ledger using the stable idempotency key `purchase:<paymentOrderId>` and links the transaction to that payment order. Duplicate callbacks reuse the ledger transaction; a browser redirect is never considered proof of payment.
- Invalid signatures, unknown order IDs, amount mismatches, unsupported payment method/provider, and terminal order status do not grant credits.

## Disabled / not completed

Checkout initiation is not implemented. The backend does not create payment orders for users and does not call Dinger's token or pay endpoints. The webhook receiver is disabled unless an operator deliberately configures its separate enable flag and callback secret. No merchant account or credentials were created, no provider call was made, and no payment/credit transaction was written.

Before enabling checkout, obtain Dinger merchant approval and credentials, register the production callback URL, confirm provider/method activation, and implement/review a bounded checkout client that consumes only admin-managed MMK packages. Then run provider sandbox tests and controlled settlement/replay/recovery tests. Do not use a return-page query parameter to mark an order paid.

The expected provider methods and callback format follow Dinger's [production Pay API](https://dinger.asia/production-payAPI/eng) and [production merchant callback](https://dinger.asia/production-merchant-callback/eng) documentation. Dinger documents KBZ Pay QR/PWA, Wave Pay PIN, and UAB Pay PIN; integer MMK range 500–999,999,999; and a callback with encrypted `paymentResult` plus a SHA-256 `checksum`.

## Pipeline relation

Payment acceptance is separate from processing. `PipelineService` still rejects start/retry with `MEDIA_PIPELINE_NOT_CONFIGURED`; narration/subtitle/final-render are not a persisted queue flow yet. Free entitlement capture must happen only inside the eventual final-render completion transaction after media output has been verified and stored. Failed runs release the reservation, and retries use a new run ID for a new `Idempotency-Key`.
