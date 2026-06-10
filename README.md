# WhatsApp ↔ CRM Bridge

> Link your WhatsApp number by scanning a QR code (just like WhatsApp Web), work your chats
> from a clean web inbox, and have every conversation **automatically logged to your CRM** —
> **no official WhatsApp API, no per-message fees.**

![version](https://img.shields.io/badge/version-0.1.0-brightgreen)
![license](https://img.shields.io/badge/license-MIT-blue)
![node](https://img.shields.io/badge/node-%E2%89%A520-339933)
<!-- After publishing to GitHub, add your CI badge:
![CI](https://github.com/YOUR_USERNAME/whatsapp-crm-bridge/actions/workflows/ci.yml/badge.svg) -->

---

## ⚠️ Important disclaimer — read before using

This project connects to WhatsApp using an **unofficial client** (the open-source
[Baileys](https://github.com/WhiskeySockets/Baileys) library, which speaks the WhatsApp
Web multi-device protocol). That means:

- Using it **may violate WhatsApp's Terms of Service**, and **your number could be banned** —
  the risk is highest if you send bulk or unsolicited messages.
- It is intended for **lawful, consent-based, reply-style use with your own number**. It is
  **not** a spam or mass-marketing tool, and it intentionally ships no bulk-sending features.
- It is provided **as-is, with no warranty**. You are solely responsible for how you use it
  and for complying with WhatsApp's terms and the data-protection laws that apply to you
  (e.g. GDPR, UAE PDPL).
- For a fully compliant alternative, see the official
  [WhatsApp Business Platform](https://business.whatsapp.com/products/business-platform)
  (paid; no QR login or chat history). The trade-offs are documented in
  [`docs/01-feasibility-and-legal.md`](docs/01-feasibility-and-legal.md).

**By using or self-hosting this software you accept these risks.**

---

## ✨ Features

- 🔗 **QR login** — link a WhatsApp / WhatsApp Business number exactly like WhatsApp Web.
- 💬 **Live inbox** — chat list, message threads, ✓/✓✓/read ticks, optimistic sending, all in
  real time over WebSocket. Existing chats appear via WhatsApp's history sync.
- 🧩 **CRM auto-logging** — each conversation becomes **one running note** on the matching
  CRM contact (matched by phone number, tolerant of human formatting), updated as new
  messages arrive. Unmatched numbers are flagged in the UI with one-click
  **create / link-existing** actions. Never one-note-per-message spam.
- 🗄 **Odoo support out of the box** (External API: URL + database + username + API key —
  configured entirely from the Settings screen, with a Test connection button). The
  `CrmAdapter` interface makes each additional CRM a single file — see
  [Adding a CRM adapter](#-adding-a-crm-adapter).
- 🔐 **Single-user login** (password → signed expiring token guarding the API and WebSocket)
  and **encryption at rest** for the WhatsApp session and CRM credentials (AES-256-GCM via
  `APP_ENCRYPTION_KEY`).
- 📤 **Your data stays yours** — one-click JSON export, per-contact erasure endpoint (GDPR),
  full wipe, and an optional auto-retention window.
- 🏠 **Self-hostable in one command** — `docker compose up -d --build` (Postgres + API +
  web UI), or run locally free on SQLite. Targets a ~$5–12/mo VPS.
- 🔓 **Open source (MIT).**

## 🚀 Quick start (local, 5 minutes)

Requires **Node ≥ 20** and **pnpm** (`corepack enable` once gets you pnpm).

```bash
git clone <your-repo-url> whatsapp-crm-bridge
cd whatsapp-crm-bridge
pnpm install
cp .env.example .env          # optional for local dev — defaults work

pnpm server:dev               # terminal 1 → API + WhatsApp connector on :4000
pnpm web:dev                  # terminal 2 → web UI on :3000
```

Open **http://localhost:3000**, scan the QR with your phone (WhatsApp → **Linked devices →
Link a device**), and your chats appear. Then open **⚙ Settings** to connect Odoo
(create an API key in Odoo under *Settings → My Profile → Account Security → New API Key*),
hit **Test connection**, and **Save** — new conversations start logging automatically.

## 🐳 Self-host (production)

```bash
cp .env.example .env   # set AUTH_PASSWORD, APP_ENCRYPTION_KEY, POSTGRES_PASSWORD, NEXT_PUBLIC_API_URL
docker compose up -d --build
```

Full guide — VPS sizing, HTTPS with Caddy, backups, updates, troubleshooting:
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

## 🛠 Tech stack

pnpm monorepo · TypeScript (strict) · Baileys · Fastify + Socket.IO · Prisma
(SQLite dev / Postgres prod) · Next.js + React · Docker. **305 KB of source, 32 tests, no
message bus or queue to operate** — one process runs the connector, API, sync worker, and
WebSocket hub.

## 📦 Repository structure

```
apps/web            Next.js web inbox + settings UI
apps/server         Fastify + Socket.IO API; runs the connector, CRM sync worker, auth
packages/shared     canonical types + WhatsAppConnector/CrmAdapter contracts (+ crypto)
packages/db         Prisma schema, idempotent ingest, sync ledger
packages/connector  Baileys session: QR, send, events, encrypted auth state
packages/crm        CRM adapters (Odoo) + transcript builder
docs/               design specs (01–07), DEPLOY.md, interactive mockup
```

## 🧩 Adding a CRM adapter

One interface, one file, zero changes elsewhere ([spec](docs/03-api-and-data-design.md)):

```ts
export interface CrmAdapter {
  readonly type: CrmType;                 // 'hubspot' | 'zoho' | ...
  readonly authKind: 'oauth2' | 'api_key';
  testConnection(creds): Promise<{ ok: boolean; detail?: string }>;
  findContactByPhone(phone, creds): Promise<CrmRecord[]>;
  createContact(input, creds): Promise<CrmRecord>;
  appendNote(recordId, note, creds): Promise<CrmNoteRef>;
  updateNote?(noteId, note, creds): Promise<void>;   // enables the running-thread note
}
```

Copy [`packages/crm/src/odoo/`](packages/crm/src/odoo/) as a template (including its
fake-server test), register the adapter in
[`packages/crm/src/index.ts`](packages/crm/src/index.ts), and add the type to `CrmType`.
PRs for HubSpot, Zoho, Pipedrive, and Salesforce are very welcome.

## 📚 Documentation

- [Master plan / index](docs/00-master-plan.md) ·
  [Feasibility & legal](docs/01-feasibility-and-legal.md) ·
  [Architecture](docs/02-architecture.md) ·
  [API & data](docs/03-api-and-data-design.md) ·
  [Security & privacy](docs/04-security-privacy-compliance.md) ·
  [Real-time sync](docs/05-realtime-sync.md) ·
  [Deploy](docs/DEPLOY.md)
- [BUILD_PLAN.md](BUILD_PLAN.md) — how this was built, milestone by milestone.
- [CHANGELOG.md](CHANGELOG.md) — release notes.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md).
`pnpm lint && pnpm typecheck && pnpm test` must be green — CI enforces all three.

## 🔐 Security

Never commit `.env` or the WhatsApp `auth_state/` folder (it is a full session credential —
set `APP_ENCRYPTION_KEY` so it is encrypted at rest). Report vulnerabilities per
[SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE) © 2026 Shaikh Amir Hussain
