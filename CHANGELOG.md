# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[SemVer](https://semver.org/).

## [0.1.0] — 2026-06-10

First public release — a complete, self-hostable WhatsApp → CRM bridge.

### Added

**WhatsApp client**
- QR-code login (like WhatsApp Web) via Baileys multi-device; auto-reconnect; history sync
  brings in existing chats after pairing.
- Real-time web inbox: chat list with unread badges and search, message threads with
  ✓/✓✓/read ticks, optimistic sending reconciled over WebSocket.

**CRM sync (the product)**
- Pluggable `CrmAdapter` contract (OAuth2 and API-key CRMs); **Odoo** adapter included
  (External API over JSON-RPC: `res.partner` matching, chatter notes).
- Phone → contact lead matching tolerant of human number formats; `unmatched`/`ambiguous`
  flagged in the UI with one-click create / link-existing actions (never guesses).
- Sync worker: per-conversation debounce, **one running-thread note per conversation**
  (updated in place, no note flooding), idempotent `sync_log` ledger, exponential-backoff
  retries with a dead-letter state.
- CRM context panel in the inbox: matched record, open-in-CRM link, live sync status.

**Security & privacy**
- Single-user login: `AUTH_PASSWORD` → signed expiring bearer token guarding the REST API
  and the WebSocket handshake.
- Encryption at rest (AES-256-GCM, `APP_ENCRYPTION_KEY`) for CRM credentials and the
  WhatsApp `auth_state` session, with transparent migration of pre-existing plaintext.
- Data rights endpoints: JSON export, per-contact erasure, full wipe (with confirmation),
  optional `RETENTION_DAYS` auto-purge. Export/wipe also available from the Settings UI.

**Self-hosting**
- Settings screen: connect WhatsApp + Odoo entirely from the browser (test + save).
- One-command deployment: `docker compose up -d --build` (Postgres + API + web), volumes
  for data and session, `docs/DEPLOY.md` VPS guide. Local dev runs on SQLite, no Docker.

**Project**
- pnpm/TypeScript monorepo, 32 tests across 5 packages, GitHub Actions CI
  (lint + typecheck + test + build), design docs (`docs/01–07`).

### Known limitations
- Text messages only in the UI; media messages show as type placeholders (media sync is on
  the roadmap).
- One WhatsApp number and one CRM integration per instance (single-tenant by design).
- Uses an unofficial WhatsApp client — see the README disclaimer for ToS/ban risk.

[0.1.0]: https://github.com/YOUR_USERNAME/whatsapp-crm-bridge/releases/tag/v0.1.0
