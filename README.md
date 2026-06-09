# WhatsApp ↔ CRM Bridge

> Link your WhatsApp number by scanning a QR code (just like WhatsApp Web), work your chats
> from a clean web inbox, and have every conversation **automatically logged to your CRM** —
> **no official WhatsApp API, no per-message fees.**

![status](https://img.shields.io/badge/status-early%20development-orange)
![license](https://img.shields.io/badge/license-MIT-blue)

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

## ✨ What it does

- 🔗 **QR login** — link a WhatsApp / WhatsApp Business number like WhatsApp Web.
- 💬 **Live inbox** — see chats and send/receive in real time from a web UI.
- 🧩 **CRM auto-logging** — conversations are written to the matching lead/contact as notes
  (HubSpot first; a pluggable adapter layer makes adding more CRMs a single file).
- 🏠 **Self-hostable** — runs free on your own machine, or on a ~$5–12/mo VPS. SQLite by
  default; Postgres optional.
- 🔓 **Open source (MIT).**

## 🚧 Status

Early development, built in small milestones — see [`BUILD_PLAN.md`](BUILD_PLAN.md).
**Current: M0 — project scaffold.**

## 🛠 Tech stack

pnpm monorepo · TypeScript · Baileys · Fastify + Socket.IO · Prisma (SQLite → Postgres) ·
Next.js + Tailwind · Docker.

## 📦 Repository structure

```
apps/web            Next.js web inbox                         (M5)
apps/server         Fastify + Socket.IO API; runs connector   (M4)
packages/shared     canonical types + connector/CRM interfaces (M1)
packages/db         Prisma schema + client                    (M3)
packages/connector  Baileys session, QR, send, events         (M2)
packages/crm        CRM adapter interface + adapters           (M6)
docs/               design specs (01–07) + interactive mockup
```

## 🚀 Quick start (development)

Requires **Node ≥ 20** and **pnpm** (run `corepack enable` once to get pnpm).

```bash
git clone <your-repo-url> whatsapp-crm-bridge
cd whatsapp-crm-bridge
pnpm install
cp .env.example .env     # then fill in the values
# Per-feature dev commands arrive as milestones land — see BUILD_PLAN.md
```

## 📚 Documentation

- [Master plan / index](docs/00-master-plan.md)
- [Feasibility & legal](docs/01-feasibility-and-legal.md) ·
  [Architecture](docs/02-architecture.md) ·
  [API & data](docs/03-api-and-data-design.md) ·
  [Security & privacy](docs/04-security-privacy-compliance.md) ·
  [Real-time sync](docs/05-realtime-sync.md) ·
  [Roadmap](docs/06-development-roadmap.md) ·
  [Design & costs](docs/07-predictive-design-and-costs.md)
- [Interactive UI mockup](docs/interface-mockup.html) — open in a browser.

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Please also read the
[Code of Conduct](CODE_OF_CONDUCT.md).

## 🔐 Security

Never commit `.env` or WhatsApp `auth_state`. Report vulnerabilities per
[SECURITY.md](SECURITY.md).

## 📄 License

[MIT](LICENSE) © 2026 Shaikh Amir Hussain
