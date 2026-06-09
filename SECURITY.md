# Security Policy

## Reporting a vulnerability

Please report security issues **privately to the maintainer** (add your contact email here)
rather than opening a public issue. You'll get an acknowledgement within a few days.

## Sensitive data this app handles

- **WhatsApp session credentials** (`auth_state`) — equivalent to a logged-in WhatsApp
  session. Treat as a password.
- **CRM tokens** (OAuth access/refresh).

Both are **encrypted at rest** using `APP_ENCRYPTION_KEY` (see `.env.example`), and are
**gitignored**. Never commit `.env`, `auth_state/`, or any database file.

If you suspect a key was exposed: rotate `APP_ENCRYPTION_KEY`, revoke CRM tokens, and
re-link the WhatsApp number.

## Your responsibilities as an operator

You are the data controller for the chats you store. Honour applicable privacy laws
(e.g. GDPR, UAE PDPL): inform the people you message that conversations are recorded, and
support data export/erasure. See [`docs/04-security-privacy-compliance.md`](docs/04-security-privacy-compliance.md).
