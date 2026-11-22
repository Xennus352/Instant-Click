# Credit and billing API

All balances are integer credits. User requests use the Better Auth session cookie; internal job settlement uses a server-only `INTERNAL_API_KEY`. Responses use `{ "data": ... }` or the shared `{ "error": { "code", "message", "details? } }` format. Authenticated balance and ledger responses are `Cache-Control: private, no-store`.

## User endpoints

### `GET /api/v1/credits/packages`

Requires a verified, active Better Auth session. Returns only enabled, admin-managed packages with `currency: "MMK"`; amounts are decimal strings in MMK (not a hardcoded bundle or price). Dinger's documented limits are 500 through 999,999,999 MMK.

### `GET /api/v1/credits/wallet`

Returns `balance` (settled credits), `reserved` (held credits), `available` (`balance - reserved`), wallet `version`, and `legacy`. If no wallet exists, the read reports `User.credits` without changing it. A user with legacy credits receives `legacy: true`; billing mutations return `409 WALLET_BACKFILL_REQUIRED` until the separately approved backfill runs.

### `GET /api/v1/credits/transactions?limit=25&cursor=<ObjectId>`

Returns the authenticated user's ledger entries in reverse chronological order and a `nextCursor` when another page exists. The query always scopes records to the authenticated user.

### `POST /api/v1/credits/reservations`

This is an internal job API, not a browser endpoint. It requires `x-internal-api-key`, `x-user-id`, and `Idempotency-Key`, with JSON `{ "projectId": "<ObjectId>", "amount": 20 }`. The project must belong to that user and must not be completed or failed. Creates an open reservation and returns its `reservationId`. Repeating the same key and payload returns the same ledger operation; reusing a key for a different payload returns `409 IDEMPOTENCY_KEY_REUSED`.

## Internal job settlement

The capture/release routes require `x-internal-api-key` and `x-user-id`. Configure the same random `INTERNAL_API_KEY` in Next.js and trusted worker environments; keep it out of browser code. Both require an `Idempotency-Key`, the reservation ObjectId in the path, and the original `projectId` in the body.

- `POST /api/v1/credits/reservations/{reservationId}/capture` settles a positive integer amount. It can include a usage record (`feature`, `metric`, `quantity`, `unit`) which is committed atomically with the ledger entry.
- `POST /api/v1/credits/reservations/{reservationId}/release` releases a positive integer remainder.

Captures and releases may be partial, but their total cannot exceed the open reservation. The service closes a reservation after it is fully captured or released. A stale reservation or invalid amount returns `409 INVALID_CREDIT_RESERVATION`.

## Admin endpoints

- `GET /api/v1/admin/credit-packages` and `PUT /api/v1/admin/credit-packages` expose audited package administration. Writes are restricted to MMK and Dinger's documented integer amount range. Package/credit amounts remain editable by authorized finance/admin users.

- `POST /api/v1/admin/credits/balance-changes` requires an admin session, an idempotency header, and `{ "userId", "type": "GRANT|ADJUSTMENT|EXPIRY", "amount", "reason", "sourceRecordId?" }`.
- `POST /api/v1/admin/credits/refunds` requires an admin session, an idempotency header, and `{ "userId", "captureId", "amount", "reason" }`. Refund amounts are capped by the referenced capture; a refund is a linked compensating ledger entry.

## Operational boundary

This milestone does not run the legacy-credit backfill, database migration, or deployment. The backfill remains dry-run-first and must be approved separately before it touches a database. Capture/release routes return `503 INTERNAL_AUTH_UNCONFIGURED` until `INTERNAL_API_KEY` is configured.

`POST /api/webhooks/dinger` is a settlement receiver, gated off unless `DINGER_CALLBACKS_ENABLED=true` and `DINGER_CALLBACK_KEY` is configured. It validates the Dinger AES-256-ECB/PKCS7 callback, constant-time compares the SHA-256 checksum, validates the signed order ID/provider/method/amount against the immutable order snapshot, and posts a purchase ledger entry with a stable per-order idempotency key. Browser return URLs are never settlement evidence. This endpoint has not been enabled or exercised against a merchant account.

Dinger checkout initiation is not implemented, and no production merchant credentials are configured. No checkout route creates orders or calls Dinger; the callback is therefore inert until a reviewed checkout adapter, merchant credentials, callback URL registration, and explicit rollout approval exist. Supported signed methods are KBZ Pay QR/PWA, Wave Pay PIN, and UAB Pay PIN. No payment has been accepted and no user credits were granted by this work.

The free-recap entitlement uses an admin-configured `free-recaps` campaign with a count from 0–20; new users receive a wallet snapshot of the configured count. Retries use a new run ID for a new idempotency key; terminal failures release their reservation. The final render callback captures the reservation only after S3 size, MP4 signature, and streamed checksum verification, and commits the render, private gallery entry, project completion, and capture in one transaction. Processing still fails closed while Gemini is unavailable from the configured region or no verified clean asset is available. Paid balance checkout/settlement is not enabled.

The existing reservation/capture/release routes are not connected to a completed final-media pipeline. Do not enable processing or grant purchased credits until checkout, verified provider callbacks, and final-output settlement have been reviewed together.
