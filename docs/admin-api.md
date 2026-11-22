# Admin API surface

All routes require an authenticated, email-verified account with `ADMIN` or `SUPER_ADMIN` role. Responses are private/no-store. Only `accountStatus=ACTIVE` passes the shared session gate; `null`/missing legacy status fails closed until explicitly backfilled. User role/status changes require a reason and write an `AdminAuditLog` row in the same MongoDB transaction; only `SUPER_ADMIN` can change roles, and self-change/last-active-admin changes are rejected.

## First super-administrator bootstrap

There is intentionally no public or unauthenticated bootstrap route. The project owner must nominate an existing account whose email is verified and status is `ACTIVE`. Before deploying the fail-closed session gate, review the legacy-status count and, only when authorized, backfill null/missing status to `ACTIVE`:

```sh
npm run backfill:account-status
npm run backfill:account-status -- --apply
```

The first command is read-only and reports the count. `--apply` updates only records still matching null/missing status, so reruns are safe. In production, also pass `--confirm-production`; verify the selected `DATABASE_URL`, backup, and expected count first. It leaves explicitly suspended or banned users unchanged.

Then verify that `DATABASE_URL` targets the intended environment and run this one-time bootstrap from `services/nextjs`:

```sh
node scripts/bootstrap-super-admin.mjs --email verified-admin@example.com --confirm
```

In production also pass `--confirm-production`.

The command refuses unverified, missing, or non-active accounts. A rerun succeeds without another audit entry only if the marker identifies the same account and that account remains `SUPER_ADMIN`; a different account is rejected. The marker uses the existing unique `AdminConfig.key`, so concurrent attempts cannot both succeed; role change, marker, and audit entry are in one transaction. It prints the target user ID, not the email. The audit event uses `actorRole=SYSTEM_BOOTSTRAP` and records `actorSource=operator_cli`; `actorId` is the nominated account because the current audit schema requires a user ID. Do not run this against production until the owner has nominated the account and the operator has verified the target database.

## Available endpoints

- `GET /api/v1/admin/overview` — persisted counts for users, projects, assets, jobs, failed jobs, paid/open payment orders, and audit records. Counts are live database aggregates, not sample metrics.
- `GET /api/v1/admin/users?limit=50&page=1&q=...` — user directory projection (email, name, email verification, role, account status, timestamps).
- `PATCH /api/v1/admin/users/{userId}` — set `accountStatus` and/or `role`, with `reason` (8–500 chars). Example: `{ "accountStatus": "SUSPENDED", "reason": "..." }`.
- `GET /api/v1/admin/jobs?limit=50&status=FAILED` — real job status fields; raw job payloads and failure details are omitted.
- `GET /api/v1/admin/audit-logs?limit=50&targetType=User&action=USER_ACCOUNT_UPDATED` — append-only admin changes with redacted before/after records.
- `GET /api/v1/admin/credit-packages` and `PUT /api/v1/admin/credit-packages` — list or upsert an explicitly priced catalog item. Monetary minor units are strings in JSON; writes require an audit reason. No checkout is implied.
- `GET /api/v1/admin/promo-campaigns` and `PUT /api/v1/admin/promo-campaigns` — list or configure a campaign key, enable window, and free recap count. This edits campaign configuration only; no per-user entitlement is granted.
- `GET /api/v1/admin/payments?limit=50&status=PAID` — read real payment orders with BigInt amounts serialized as decimal strings; provider references and raw payloads are omitted.
- Existing `POST /api/v1/admin/credits/balance-changes` and `/api/v1/admin/credits/refunds` now append audit entries atomically with ledger mutation. They change credits only; they do not invoke a payment processor.

## Controls still unavailable

Payment order rows remain read-only for admins. A Dinger callback verifier/ledger settlement path is present but feature-gated; checkout initiation is not implemented and no merchant account or credentials are configured. It is not production-ready or enabled. Credit packages are editable through the audited MMK-only package endpoint. Narration, measured subtitles, render persistence, and final-output entitlement capture are wired in code; actual processing remains blocked by Gemini's unsupported runtime region and absent clean-scan path. `AdminConfig` is untyped and is not exposed for arbitrary edits; provider/model secrets stay outside this API. Durable reports, admin notification/announcement writes, and operational job retry/cancel APIs remain unavailable. The existing billing console covers credit adjustments/refunds; Pixel owns full dashboard UI.

The `free-recaps` campaign count is admin-configurable from 0–20. A user's `PromoEntitlementWallet.granted` value snapshots the count when first initialized; later campaign edits do not alter that existing grant. New wallets use the current campaign count. Initialize the default enabled campaign explicitly with `npm run bootstrap:free-recaps` (read-only dry run) and then `npm run bootstrap:free-recaps -- --apply` from `services/nextjs`. If the key already exists with a valid count, the script preserves current settings. In production, pass `--confirm-production`; application startup never seeds campaign data. Per-user wallets are not bulk-created: first eligible reservation lazily creates the wallet and grant event. The setup script was not applied during this implementation.
