# WhatsApp ↔ CRM Bridge — Project Guide

Open-source, self-hostable app that links a WhatsApp number via **QR code** (like WhatsApp
Web), shows all chats in a web UI, lets you send/receive, and **auto-logs conversations to a
CRM**. No official WhatsApp API, **no per-message fees.**

> This file auto-loads every session. Keep it short. Detailed spec lives in `docs/`.

## Locked decisions — do NOT re-litigate
- **Path B (unofficial):** **Baileys** (WhatsApp multi-device over WebSocket). QR login, free, sees existing chats.
  - ⚠️ Breaks WhatsApp ToS → ban risk. Keep the disclaimer in README. Build for **normal reply-style use only — no mass-messaging/blast features.**
- **Open source, MIT license.**
- **Cost target:** free locally / ~$5–12/mo on a small VPS. Prefer **free/local infra (SQLite, local files)** until production; add Postgres/Docker only when needed.

## Stack — fixed, don't deliberate
- Monorepo: **pnpm workspaces** · **TypeScript (strict)** everywhere.
- WhatsApp: **Baileys** (`@whiskeysockets/baileys`).
- Backend: **Fastify** + **Socket.IO**. For self-host simplicity, **one process runs the connector + API + WebSocket.**
- DB: **Prisma** → **SQLite** (dev) → **Postgres** (prod). Same schema both.
- Frontend: **Next.js** + **TailwindCSS**. Reuse the design in `docs/interface-mockup.html`.
- Secrets: `.env`; encrypt stored creds with Node `crypto` + `APP_ENCRYPTION_KEY`.
- Deploy: **Docker + docker-compose**.

## Repo structure
```
apps/web         Next.js frontend (the mockup, made real)
apps/server      Fastify + Socket.IO; runs the connector, API, real-time
packages/shared  canonical types + WhatsAppConnector & CrmAdapter interfaces (zod)
packages/db      Prisma schema + client
packages/connector  Baileys wrapper (session, QR, send, events)
packages/crm     CrmAdapter interface + adapters (hubspot, ...)
docs/            01–07 specs + interface-mockup.html
```

## The spec
Design detail is in `docs/01…07`. **Read only the one doc relevant to the current step — don't re-derive.**
Architecture→`02`, data/API/CRM adapter→`03`, security→`04`, real-time flows→`05`, build order→`BUILD_PLAN.md`.

## How to work — token discipline
1. The build is a checklist in **`BUILD_PLAN.md`**. Do **ONE step per session.**
2. Session start: this file auto-loads; also read **only** that step + its referenced doc.
3. Step done → **tick its box**, update **"Current status"** in `BUILD_PLAN.md`, run `pnpm lint && pnpm test`, **commit** (conventional commits), then **`/clear`** before the next step.
4. Keep modules small. Never commit secrets, `.env`, or Baileys `auth_state`.
