# Authentication runtime configuration

The Next.js build imports auth routes without initializing Better Auth or opening an SMTP transport. Runtime auth requests require `AUTH_SECRET` with at least 32 characters; when missing, the auth endpoint returns HTTP 503 `AUTH_CONFIGURATION_UNAVAILABLE`.

Email registration, password recovery, and verification resend require `AUTH_EMAIL_FROM`, `SMTP_HOST`, and a valid `SMTP_PORT` (default 587). `SMTP_USER` and `SMTP_PASSWORD` are used when the SMTP server requires authentication. If delivery configuration is incomplete, those email-triggering routes return HTTP 503 `AUTH_EMAIL_UNAVAILABLE` before creating an unverified account. No verification or recovery URL is written to logs.

Build-time environment is not proof that production auth or email delivery is configured. Set secrets in the runtime secret manager, then verify mail delivery from the deployed environment before enabling registration.
