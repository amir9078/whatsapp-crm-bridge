# 01 — Feasibility & Legal Analysis

This is the document that decides what you are actually allowed to build, and on what
foundation. **Do not skip it.**

---

## 1. The two ways to talk to WhatsApp

WhatsApp does **not** offer a single "API" the way you might expect. There are two
completely separate technical realities.

### Path A — Official WhatsApp Business Platform (Cloud API)

Meta's sanctioned, supported, commercial API.

- You register a **Meta Business** account, create a **WhatsApp Business Account (WABA)**,
  and **onboard a phone number** to the platform.
- You either integrate **directly with Meta's Cloud API** (hosted by Meta) or go through a
  **BSP — Business Solution Provider** (Twilio, 360dialog, Meta-partner Gupshup, Wati,
  Respond.io, Vonage, Infobip, MessageBird/Bird, etc.).
- Incoming messages arrive via **webhooks**; you send via authenticated **Graph API**
  calls.

**What it gives you**

- Fully compliant, scalable, supported, with quality/throughput tiers.
- Webhooks for inbound messages, delivery/read receipts, and status.
- Rich features: templates, interactive buttons, lists, media, flows.

**What it deliberately does NOT give you (and this matters for your brief)**

- ❌ **No QR-code "link a device" login.** You migrate a *number* onto the platform.
- ❌ **Once a number is on the Cloud API, you can no longer use that number in the normal
  WhatsApp / WhatsApp Business phone app.** The number is effectively "claimed" by the API.
- ❌ **No access to historical chats.** You only ever see messages sent/received *after*
  the number goes live on the API. There is no "sync all my existing conversations."
- ❌ **No unrestricted free-form sending.** You can send free-form text **only within a
  24-hour "customer service window"** that opens when the customer messages you first.
  Outside that window you may only send **pre-approved message templates** (and
  marketing/utility templates are billed per conversation).
- Requires **Meta Business verification**, a display-name review, and opt-in handling.

**Cost model:** conversation-based pricing (Meta bills per 24h conversation, in
categories: marketing, utility, authentication, service), **plus** BSP platform fees if you
use one. Prices vary by country.

### Path B — Unofficial Web automation libraries

These reverse-engineer the **WhatsApp Web / multi-device** protocol. The mainstream
open-source options:

| Library | How it works | Notes |
|---|---|---|
| **Baileys** (`@whiskeysockets/baileys`) | Speaks the WhatsApp Web multi-device protocol **directly over WebSocket** — no browser | Lightweight, fast, most popular for servers; TypeScript |
| **whatsapp-web.js** | Drives a **headless Chromium (Puppeteer)** pointed at `web.whatsapp.com` | Heavier (a browser per session), simpler mental model |
| **WPPConnect / Venom / Open-WA** | Similar browser-automation lineage | Various maturity levels |

**What it gives you — this is *exactly* your brief**

- ✅ **QR-code login**, identical UX to linking WhatsApp Web / a companion device.
- ✅ Access to **existing chats**, contacts, and history (within multi-device limits).
- ✅ **Send and receive freely**, no 24h window, no templates.
- ✅ Works with a **normal personal number** or a **WhatsApp Business app** number.
- ✅ **No per-message fees.**

**What it costs you — the hard truths**

- ❌ **It violates WhatsApp's Terms of Service.** WhatsApp explicitly prohibits
  "non-personal" / automated / bulk use and the use of unauthorized (non-official)
  clients. You are operating an unofficial client.
- ❌ **Ban risk is real and is the central risk of this path.** Numbers — especially ones
  that send at volume, send to people who haven't messaged first, or get reported — can be
  **temporarily or permanently banned.** A ban can wipe out the number and its history.
- ❌ **Fragile.** When WhatsApp changes its web protocol, these libraries break until the
  open-source maintainers catch up. You inherit that maintenance treadmill.
- ❌ **No SLA, no support, no guarantees.** If it breaks at 2am, it's your problem.
- ❌ Session management is real ops work: the linked device must stay connected; sessions
  drop and need re-linking.

> **Consultant's verdict on the brief as literally written:** Points 1–3 of your brief
> (QR login + sync *all existing* chats + unrestricted send/receive) are achievable **only
> on Path B**, which is **non-compliant** with WhatsApp's terms. There is no way to get
> that precise experience from the official API. Any honest vendor who tells you otherwise
> is selling you Path B in a trench coat.

---

## 2. Side-by-side decision matrix

| Dimension | Path A (Official Cloud API) | Path B (Unofficial) |
|---|---|---|
| Matches your described UX | Partially (no QR, no history, no free-form) | **Fully** |
| WhatsApp ToS compliant | ✅ | ❌ |
| Ban / number-loss risk | Very low | **High** |
| Existing chat history | ❌ | ✅ |
| Free-form outbound anytime | ❌ (24h window + templates) | ✅ |
| Per-message cost | Yes (conversation pricing) | No |
| Setup friction | High (verification, BSP) | Low (scan a QR) |
| Engineering stability | High | Low–medium (breaks on updates) |
| Scales to millions of msgs | ✅ | Risky / against policy |
| Official support & SLA | ✅ | ❌ |
| Multi-number / multi-tenant | Clean (each WABA/number) | Each number = a stateful session you babysit |
| Good fit | Enterprise, regulated, marketing at scale | SMB inbox tools, MVPs, internal sales desks |

---

## 3. Recommended strategy — abstract the provider, don't marry one

Do **not** hard-code your product to either path. Instead:

> **Build a `WhatsAppConnector` interface** (a clean internal contract: `connect()`,
> `sendMessage()`, event stream for inbound messages/status) and implement it **twice**:
> one `UnofficialConnector` (Baileys) and one `CloudApiConnector` (Meta/BSP).

This lets you choose strategy per customer/tenant and migrate later **without rewriting
the app**. Concretely:

- **For an MVP, internal tool, or SMB product where the WhatsApp-Web UX is the whole point:**
  start on **Path B (Baileys)**. Accept and *document* the ban risk. Use dedicated
  numbers, never the founder's personal number. This is how a large share of "WhatsApp
  CRM" SMB tools actually work today.
- **For enterprise, regulated industries, marketing/notification volume, or anything you'll
  sell with an SLA:** use **Path A**. Set customer expectations: no history import, 24h
  window, templates.
- **Hybrid / migration path:** launch on B to validate the product and get the UX right,
  then offer A as a "compliant / enterprise" tier. Because the connector is abstracted, the
  CRM-sync engine, UI, and data model don't change.

The rest of these documents are written to be **path-agnostic** wherever possible, and call
out where the two diverge.

### A note on "risk reduction" for Path B (it does not make it compliant)

If you go Path B, you can *reduce* — not eliminate — ban risk:

- Use **dedicated business numbers**, warmed up gradually; never a personal number.
- **Never cold-blast.** Only message people who messaged you, or who explicitly opted in.
- Respect human-like sending rates; no bulk loops.
- Honor opt-outs immediately; monitor for "reported/blocked" signals.
- Keep one number per tenant isolated (a ban shouldn't cascade).

None of this makes it ToS-compliant. It only lowers the odds and blast radius. **Put this
in writing for whoever signs off on the project.**

---

## 4. Encryption — what's actually true

WhatsApp uses the **Signal protocol** for end-to-end encryption (E2EE). People assume E2EE
makes this project impossible. It does not — but understand precisely why:

- **Path B:** Your service connects as a **legitimate linked/companion device.** It
  performs the same key exchange the WhatsApp Web client does, so it **legitimately holds
  the keys and sees plaintext.** Encryption is *not* a barrier to reading messages here —
  **but** it means **you are now storing decrypted personal conversations** on your
  servers. That is a privacy and security responsibility, not a technical blocker.
- **Path A:** Messages are decrypted in **Meta's Cloud** (Cloud API) and delivered to your
  webhook over TLS in plaintext (JSON). Again you end up holding plaintext.

**Conclusion:** On *either* path, the moment a message reaches your system it is plaintext
and you are its custodian. The hard problem isn't decrypting — it's **protecting** what you
store (see [04-security-privacy-compliance.md](04-security-privacy-compliance.md)).

---

## 5. Legal & compliance considerations

> ⚠️ This is engineering guidance, **not legal advice.** Engage a qualified lawyer before
> launch — especially for Path B and for any cross-border data flows.

### 5.1 WhatsApp / Meta policy
- **Path B violates the WhatsApp Terms of Service and Business Messaging Policy.** Risks:
  number bans, and potentially account/legal action from Meta. This is a business risk to
  accept explicitly, in writing, by leadership.
- **Path A** must follow Meta's Commerce & Messaging policies, opt-in rules, and template
  approval. Sending without opt-in or sending prohibited content damages your **quality
  rating** and can get the WABA restricted.

### 5.2 Data-protection law (you are in the UAE — both regimes likely apply)
You will store the **content of private conversations** = sensitive personal data.

- **UAE PDPL** — Federal Decree-Law No. 45 of 2021 on Personal Data Protection. Applies to
  processing personal data of individuals in the UAE. Requires lawful basis, consent for
  many cases, data-subject rights, breach notification, and controls on cross-border
  transfer. If you host customers in **DIFC** or **ADGM** free zones, those have their own
  data-protection regulations (DIFC DP Law, ADGM DPR) that are GDPR-aligned.
- **GDPR** — applies if you process data of people in the EU/EEA (very likely for any
  customer with European contacts). Lawful basis, data-subject rights (access, erasure,
  portability), DPA agreements, records of processing, possibly a DPIA given you're
  processing message content.
- **Other regions** as your customers expand (CCPA/US, etc.).

**Practical obligations this imposes on the build:**
1. A **lawful basis** for storing each contact's messages (consent or legitimate interest)
   — and a way to record it.
2. **Inform the contacts** whose chats you log (privacy notice). Many businesses add a line
   to their WhatsApp greeting: *"Messages may be recorded and stored in our CRM."*
3. **Data-subject rights**: be able to **export and delete** all data for a given person on
   request → design deletion workflows from day one, not retrofitted.
4. **Data residency**: some UAE/GCC customers contractually require data hosted in-region
   (e.g., UAE or DIFC). Choose cloud regions accordingly; make region configurable per
   tenant if you sell to enterprise.
5. **Data Processing Agreements (DPAs)** with your customers — you're a *processor* acting
   on their behalf; they're the *controller* of their contacts' data.
6. **Retention policy** — don't keep messages forever; define and enforce TTLs.

### 5.3 Regional connectivity note (UAE-specific)
In the UAE, WhatsApp **voice/video calling** has historically been restricted at the ISP
level. **Text/media messaging works**, and the **Business Cloud API works normally** since
it runs through Meta's servers. This doesn't block the project, but factor it into testing
if you ever add calling features, and into how you test Path B sessions from inside the UAE
(you may need a server in a region without the restriction).

---

## 6. Feasibility verdict

| Question | Answer |
|---|---|
| Is the system buildable? | **Yes.** |
| Can it match your exact described UX (QR + all chats + free-form)? | **Yes — but only on the non-compliant Path B.** |
| Can it be built compliantly? | **Yes — on Path A, with a different UX and constraints.** |
| Recommended approach | **Abstract the connector; choose path per use-case; likely start on B for the UX, design for A.** |
| Biggest blockers | Not technical — they're **policy/ban risk** and **data-privacy liability.** |
| Show-stoppers | None, *if* leadership accepts the Path-B risk in writing, or accepts Path-A constraints. |

➡️ Next: **[02-architecture.md](02-architecture.md)** for how the system is actually built.
