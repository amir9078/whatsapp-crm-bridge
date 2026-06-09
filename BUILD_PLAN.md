# BUILD PLAN — token-efficient, step-by-step

> **Current status: ▶ Next = M6 (CRM adapter — the actual product).** M0–M5 ✅ — full app works end-to-end: server (3/3 integration tests) + web UI verified rendering a real WhatsApp QR from the real backend. Run it: `pnpm server:dev` + `pnpm web:dev`, open http://localhost:3000, scan, chat.
> Update this line at the end of every session.

This plan is built so you never "run out of tokens." Each **Milestone (M)** is sized for
**one focused session**. You don't hold the whole project in your head (or mine) — you do one
box at a time.

---

## How to run a build session (the protocol)

**Say to Claude Code, at the start of a fresh session:**
> "Work on **M3**." *(or whichever step is next)*

Claude will then:
1. Auto-load `CLAUDE.md` (stack + decisions — no re-explaining).
2. Read **only** that milestone below + the one `docs/` file it references.
3. Build it, run `pnpm lint && pnpm test`.
4. **Tick the boxes**, bump **Current status**, and **commit**.

**You then:** run `/clear` to wipe context before the next milestone. ← *the key habit.*

### The 6 token-saving rules
1. **One milestone per session**, then `/clear`. Long sessions are what burn tokens.
2. **Never re-explain the plan** — it's in `CLAUDE.md` + `docs/`. Just give the M-number.
3. **Reference, don't restate.** "Per `docs/03` §2" beats pasting the schema.
4. **Small files.** If a file gets big, split it — big files cost tokens to read/edit.
5. **Acceptance criteria = stop condition.** When the check passes, the step is done. No gold-plating.
6. **Commit every milestone.** A commit is a safe restart point if a session goes sideways.

---

## Open-source setup (decided)
- **License: MIT** (max adoption). *Alternative: AGPL-3.0 if you want to stop others running a closed commercial SaaS off your code — switch in M0 if you prefer.*
- **Repo name suggestion:** `whatsapp-crm-bridge`.
- **Must-have OSS files:** `LICENSE`, `README.md` (with the ToS/ban-risk **disclaimer**), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.env.example`, `.github/` (CI + issue templates).
- ⚠️ **README disclaimer is mandatory:** state plainly this uses an unofficial WhatsApp client, may violate WhatsApp's Terms, can get numbers banned, and is provided as-is for lawful, consent-based use. Protects you and your users.

---

## Milestones

> Vertical-slice strategy: **M0–M5 give you a working personal WhatsApp web client.**
> **M6 makes it the actual product** (CRM logging). **M7–M9 make it shareable/releasable.**

### ✅ M0 — Repo & open-source foundation · ~1 session · DONE
**Goal:** an installable, lintable monorepo on GitHub.
- [x] `git init` (branch `main`); moved `01..07` + `interface-mockup.html` into `docs/` (old README → `docs/00-master-plan.md`).
- [x] pnpm workspace + root `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, ESLint (flat) + Prettier, `.gitignore`, `.gitattributes`, `.nvmrc`.
- [x] `apps/{web,server}` + `packages/{shared,db,connector,crm}` stubs (install + lint clean).
- [x] OSS files: `LICENSE` (MIT), `README.md` (+ disclaimer), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `.env.example`.
- [ ] **Push to GitHub (public). ← your step** — no `gh`/account on this machine; see commands below.
**Acceptance:** ✅ `pnpm install` and `pnpm lint` pass locally (verified). Public-repo step pending your push.

> **To publish (once you have a GitHub account):**
> ```bash
> # with the GitHub CLI:
> gh repo create whatsapp-crm-bridge --public --source=. --push
> # — or manually —
> git remote add origin https://github.com/<your-username>/whatsapp-crm-bridge.git
> git push -u origin main
> ```

### ✅ M1 — Shared types & interfaces · ~1 session · DONE · _spec `docs/03`_
**Goal:** one source of truth for data shapes and the two key interfaces.
- [x] `packages/shared`: zod schemas + types for `Contact`, `Conversation`, `Message`, `MediaMeta`, `WaConnection`, enums, and the `WhatsAppEvent` discriminated-union envelope.
- [x] `WhatsAppConnector` interface (connect, status/QR events, `sendMessage`, `on()` subscription).
- [x] `CrmAdapter` interface (auth, `findContactByPhone`, `createContact`, `appendNote`, capabilities).
- [x] Wired TS project references; `@wcb/connector` imports the interface from `@wcb/shared` to prove cross-package resolution.
**Acceptance:** ✅ `pnpm typecheck` (tsc -b) builds `shared` + `connector`; `dist` emits `.d.ts`; `pnpm lint` clean.

### ✅ M2 — WhatsApp connector + console test · DONE · _spec `docs/05` §1–3_
**Goal:** prove Baileys works on YOUR number (the big de-risk).
- [x] `packages/connector`: `BaileysConnector` — session, QR rendered to terminal, multi-file auth state persisted to `auth_state/` (gitignored), auto-reconnect.
- [x] Emits connector events (`qr`, `connection`, inbound `message`, `message-status`) + `sendMessage`. (Maps Baileys → `ConnectorEvent`; server maps these to canonical `WhatsAppEvent` in M4.)
- [x] CLI harness `pnpm connector:dev` (`/send +<E164> <msg>`, `/quit`) + self-terminating smoke via `WA_SMOKE_MS`.
**Acceptance:** ✅ verified — typecheck + lint clean, and a live smoke run **connected to WhatsApp and rendered a real, scannable QR**. ⏳ Final hands-on step is yours: run `pnpm connector:dev`, scan with your phone, watch messages stream in, then `/send` a reply.

### ✅ M3 — Database & persistence · DONE · _spec `docs/03` §2_
**Goal:** messages survive restarts.
- [x] `packages/db`: Prisma schema (WaConnection, Contact, Conversation, Message) on SQLite; initial migration `20260609190209_init` committed.
- [x] Idempotent ingest (`ingestInboundMessage`: unique on `conversationId+waMessageId`, P2002 → no-op; counters bumped only on real insert), `ensureConnection`, `updateMessageStatus`, query helpers.
- [x] `scripts/wa-dev.ts` harness (`pnpm wa:dev`): connector → DB; prints restored conversations on startup; `/send` works.
- [x] Tests (node:test, throwaway SQLite): duplicate ingest → 1 row & no unread double-count; reply lands in same conversation; fresh-client "restart" reads all back ordered.
**Acceptance:** ✅ 3/3 tests pass; typecheck + lint green. (Live phone run: `pnpm wa:dev`.)

### ✅ M4 — Server: API + real-time · DONE · _spec `docs/03` §3–4, `docs/05`_
**Goal:** backend the UI can talk to.
- [x] `apps/server`: Fastify v5 + Socket.IO on one HTTP server; connector runs in-process (injected, so tests use a fake).
- [x] REST `/api/v1`: health, connection (status+QR), conversations, messages, send (202 + optimistic-UI contract), mark-read.
- [x] Connector events → DB (idempotent ingest) → WS broadcast (`connection.status`, `message.created`, `message.status`); own-echo dedupe; new WS clients get current state on connect.
- [x] Bonus: connector now handles WhatsApp **history sync** (existing chats appear after pairing; no unread inflation).
**Acceptance:** ✅ 3/3 integration tests (real HTTP + real Socket.IO client): live WS delivery, POST→send→202 echo w/ status, duplicate echo = no extra row, read receipts broadcast.

### ✅ M5 — Frontend: the real UI · DONE · _design from `docs/interface-mockup.html`_
**Goal:** the mockup, made real and wired to the server.
- [x] `apps/web`: Next.js 15 + React 19; mockup's CSS ported directly (plain CSS instead of Tailwind — pixel-faithful, one less moving part).
- [x] QR-login screen (live QR via socket + 5s polling safety net per docs/05 §6), chat list (search, unread badges, avatars), conversation view (bubbles, ticks ✓/✓✓/blue), composer with optimistic send reconciled by `clientMessageId`.
- [x] Socket.IO live updates + catch-up refetch on socket (re)connect.
**Acceptance:** ✅ `next build` clean; **verified live in a browser: real backend served a real scannable WhatsApp QR rendered in the UI** (screenshot-verified). ⏳ Hands-on step yours: scan with your phone → chats appear → send/receive. **(You now have a working WhatsApp web client.)**

### ☐ M6 — CRM adapter + HubSpot + sync worker · ~1–2 sessions · _read `docs/03` §5–6_
**Goal:** the actual product — chats auto-logged to CRM.
- [ ] `packages/crm`: HubSpot adapter (OAuth, find/create contact, append note).
- [ ] Lead matching (phone → record, or flag `unmatched`); sync worker with **running-thread note** + debounce + `sync_log` idempotency.
- [ ] UI: CRM context panel shows matched record + sync status; "unmatched → create/link" action.
**Acceptance:** a conversation appears as (and keeps updating) a note on the right HubSpot contact; unmatched numbers are flagged in the UI.

### ☐ M7 — Auth & settings · ~1–2 sessions · _read `docs/04` §2_
**Goal:** safe to actually use; connect CRM from the UI.
- [ ] Simple login (single-user password or JWT; pluggable for Clerk later).
- [ ] Settings screen: connect WhatsApp, connect CRM via OAuth, choose note strategy.
**Acceptance:** log in, link WhatsApp and HubSpot entirely from the UI.

### ☐ M8 — Hardening & one-command self-host · ~1–2 sessions · _read `docs/04`_
**Goal:** anyone can run it cheaply and safely.
- [ ] Encrypt Baileys `auth_state` + CRM creds at rest (`APP_ENCRYPTION_KEY`).
- [ ] Postgres option; `Dockerfile` + `docker-compose.yml` (web + server + db).
- [ ] Data export + delete endpoints (`docs/04` §5.3); basic retention setting.
- [ ] `docs/DEPLOY.md`: run on a $5–12/mo VPS.
**Acceptance:** `docker compose up` runs the whole stack from a clean machine, documented.

### ☐ M9 — Open-source release polish · ~1 session
**Goal:** a repo a stranger can star and run.
- [ ] README: screenshots/GIF, quick-start, the disclaimer, features.
- [ ] GitHub Actions CI (lint + test + build); issue/PR templates; `v0.1.0` tag + release notes.
**Acceptance:** fresh clone → follow README → running app. Tagged release published.

---

## Backlog (after v0.1.0 — only if you want)
- More CRM adapters (Zoho, Pipedrive, Salesforce) — each is *just one adapter* (`docs/03` §6).
- AI summaries / suggested replies (`docs/02` §8).
- Multi-tenant SaaS mode (`docs/04` §4) — only if you sell it to other businesses.

## Definition of done — v0.1.0
☐ QR login ☐ live chat sync (send/receive) ☐ HubSpot note logging ☐ login + settings
☐ Docker self-host ☐ export/delete ☐ README + disclaimer + CI ☐ public, tagged release.
