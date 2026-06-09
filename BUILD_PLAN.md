# BUILD PLAN — token-efficient, step-by-step

> **Current status: ▶ Next = M2.** M0–M1 ✅ — scaffold + shared types/interfaces build clean (`pnpm typecheck` + `pnpm lint` green).
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

### ☐ M2 — WhatsApp connector + console test · ~1–2 sessions · _read `docs/05` §1–3_
**Goal:** prove Baileys works on YOUR number (the big de-risk).
- [ ] `packages/connector`: Baileys session, QR output (print to terminal), auth-state persisted to a local file.
- [ ] Emit canonical inbound `message.created` + status events; implement `sendMessage`.
- [ ] Tiny CLI harness: `pnpm connector:dev` → scan QR, log incoming messages, send a test message by command.
**Acceptance:** you scan the QR with your phone, see your incoming messages in the terminal, and send one back from the CLI.

### ☐ M3 — Database & persistence · ~1 session · _read `docs/03` §2_
**Goal:** messages survive restarts.
- [ ] `packages/db`: Prisma schema (trimmed from `docs/03`: contact, conversation, message, wa_connection). SQLite datasource.
- [ ] Migrations + client; connector writes contacts/conversations/messages (idempotent on `wa_message_id`).
**Acceptance:** receive messages, restart, query them back — no duplicates.

### ☐ M4 — Server: API + real-time · ~1–2 sessions · _read `docs/03` §3–4, `docs/05`_
**Goal:** backend the UI can talk to.
- [ ] `apps/server`: Fastify; run the connector in-process; Socket.IO gateway.
- [ ] REST: list conversations, list messages, send message, connection status/QR.
- [ ] Wire connector events → DB → Socket.IO push.
**Acceptance:** with a WS test client, new messages arrive live; `POST /messages` sends and echoes back with status.

### ☐ M5 — Frontend: the real UI · ~2–3 sessions · _reuse `docs/interface-mockup.html`_
**Goal:** the mockup, made real and wired to the server.
- [ ] `apps/web`: Next.js + Tailwind; port the mockup's layout/styles.
- [ ] QR-login screen ↔ server; chat list + conversation from API; composer sends; Socket.IO live updates; optimistic send + status ticks.
**Acceptance:** in the browser: scan QR → see your chats → send/receive in real time. **(You now have a working WhatsApp web client.)**

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
