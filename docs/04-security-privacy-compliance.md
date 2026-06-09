# 04 — Security, Privacy & Compliance

You are storing **decrypted private conversations** plus **CRM credentials** for multiple
businesses. That makes this a high-value target and a high-liability dataset. Security is not
a phase — it's a property of every component.

---

## 1. Threat model (what we're defending against)

| Asset | Threat | Primary defense |
|---|---|---|
| Stored message content (PII) | Breach, insider access, accidental exposure | Encryption at rest, RBAC, audit, minimization, retention TTL |
| WhatsApp session credentials (Path B) | Theft → account takeover of customer's number | Per-tenant envelope encryption, KMS, no plaintext at rest |
| CRM OAuth tokens / API keys | Theft → write access to customer's CRM | Same as above + scoped tokens + rotation |
| Cross-tenant leakage | Bug serves Tenant A's data to Tenant B | Tenant scoping everywhere + Postgres RLS + tests |
| Inbound webhooks (Path A) | Forged/replayed messages | Meta signature verification + replay window |
| The app surface | Standard web attacks (XSS, CSRF, SSRF, injection) | OWASP controls, CSP, parameterized queries |
| Account access | Credential stuffing, session hijack | MFA, short-lived JWTs, secure cookies, rate limiting |

---

## 2. Authentication & authorization

### 2.1 End-user auth (your customers' staff)
- **Short-lived access JWT (≈15 min) + rotating refresh token.** Store refresh tokens in
  **HttpOnly, Secure, SameSite** cookies — never in `localStorage` (XSS-exfiltratable).
- **MFA/2FA** (TOTP at minimum) — these accounts can read everyone's customer chats.
- **RBAC:** `owner` / `admin` / `agent` / `viewer`. Enforce in a gateway guard *and* at the
  data layer (RLS). Agents typically see only conversations they're assigned/own.
- Consider a managed identity provider (**Clerk / Auth0 / Supabase Auth**) to get MFA, SSO,
  and session management for free at MVP, rather than hand-rolling.
- **SSO (SAML/OIDC)** becomes a hard requirement for enterprise buyers — design the user
  model to allow it later.

### 2.2 Machine/service auth
- Service-to-service via **mTLS** or signed internal JWTs; never trust the network alone.
- **CRM access via OAuth2** wherever the CRM supports it (HubSpot, Salesforce, Zoho,
  Pipedrive all do). Store **refresh tokens encrypted**; auto-refresh; handle revocation.

### 2.3 WhatsApp connection auth
- **Path B:** the QR link *is* the auth. The resulting **Baileys auth state is a
  credential** — treat it like a password (encrypt at rest, never log it, never return it to
  the client).
- **Path A:** verify every inbound webhook with Meta's **`X-Hub-Signature-256`** HMAC using
  your app secret; reject unsigned/expired requests.

---

## 3. Encryption

### 3.1 In transit
- **TLS 1.2+ everywhere** — browser↔edge, service↔service, ↔CRM, ↔WhatsApp. HSTS on. No
  plaintext internal hops.

### 3.2 At rest — envelope encryption for secrets
Don't just rely on disk encryption. Use **envelope encryption** for the crown jewels
(WhatsApp `auth_state`, CRM `credentials`):

```
Cloud KMS root key  →  per-tenant Data Encryption Key (DEK)  →  encrypts the secret
```

- Root key in **Cloud KMS** (AWS KMS / GCP KMS / Azure Key Vault) or **HashiCorp Vault** —
  never in code, env files, or the DB.
- **Per-tenant DEKs** so a single leaked key can't unlock everyone, and so a tenant's data
  can be cryptographically shredded on offboarding (drop their DEK).
- Application-level encryption for the `bytea` secret columns; the database never sees
  plaintext secrets.
- Full-disk / transparent DB encryption as a baseline underneath all of the above.

### 3.3 Media
- Store in object storage **encrypted (SSE)**; serve only via **short-lived signed URLs**;
  never make the bucket public.

---

## 4. Multi-tenant isolation

Cross-tenant leakage is the most damaging bug class for a SaaS like this.

- **Every** table carries `tenant_id`; **every** query is scoped to it.
- **Defense in depth: PostgreSQL Row-Level Security (RLS).** Set `app.tenant_id` per request
  (transaction-local) and define RLS policies so the DB itself refuses cross-tenant rows even
  if application code forgets a `WHERE`.
- **Bus/cache namespacing:** prefix Redis keys and bus topics/partitions with `tenant_id`.
- **The WhatsApp connector is the sharpest edge** — a session belongs to exactly one tenant;
  the ownership lease (see [02 §5](02-architecture.md)) must encode tenant + connection and
  never cross-wire events. Tag every emitted event with its `tenant_id` at the source.
- **Automated tests** that assert isolation (Tenant B token can never read Tenant A rows) in
  CI — treat a failure as release-blocking.

---

## 5. Data privacy & regulatory compliance

> Engineering controls below; pair with legal review (see [01 §5](01-feasibility-and-legal.md)).
> Applicable regimes for a Dubai-based product with global contacts: **UAE PDPL**, **DIFC/
> ADGM DP laws** (if hosted there), and **GDPR** (EU contacts).

### 5.1 Roles
- Your **customer = data controller** (they decide to log their contacts' chats).
- **You = data processor.** ⇒ You need a **Data Processing Agreement (DPA)** with each
  customer, and **sub-processor** disclosures (your cloud, BSP, AI provider, etc.).

### 5.2 Lawful basis & consent
- Record a **lawful basis** per contact (consent / legitimate interest). Store it; make it
  auditable.
- Support **contact notification** — e.g., an automated first-reply: *"Messages with us may
  be recorded and stored in our CRM."* Make the text configurable per tenant/region.

### 5.3 Data-subject rights — build these on day one
- **Right of access / portability:** `GET /contacts/:id/export` → machine-readable bundle of
  all messages + metadata.
- **Right to erasure:** `DELETE /contacts/:id` → hard-delete or crypto-shred messages, media,
  mappings; propagate a delete request to the CRM where required; log the action in
  `audit_log`. Retrofitting deletion later is painful — design it in now.
- **Rectification & objection** handled via the same contact-management surface.

### 5.4 Data residency
- Make **storage region configurable per tenant** (`tenant.data_region`). GCC/UAE enterprise
  buyers may contractually require in-region (UAE / DIFC) hosting; EU customers may require
  EU. Pick cloud regions accordingly and don't hardcode one.
- Mind **cross-border transfer rules** (PDPL transfer conditions; GDPR SCCs) for any data
  leaving its region — including to AI providers.

### 5.5 Retention & minimization
- Define **retention TTLs** (e.g., purge messages after N months unless the tenant opts to
  keep) and enforce with scheduled jobs.
- **Minimize**: don't store more than the product needs; redact obvious secrets (e.g., card
  numbers) where feasible; consider field-level redaction before AI processing.

### 5.6 AI feature caveat
If you add AI summarization (see [02 §8](02-architecture.md)), sending message content to an
LLM provider is a **cross-border transfer + new sub-processor**. Use providers with **zero-
retention / no-training** terms, disclose them in the DPA, and let tenants opt out.

---

## 6. Application & infrastructure security

- **OWASP Top 10** discipline: parameterized queries (no string-built SQL), output encoding +
  strict **CSP** (XSS), **CSRF** tokens / SameSite cookies, **SSRF** guards on any
  URL-fetching (media download, webhooks), strict input validation (zod/class-validator).
- **Rate limiting & abuse controls** at the gateway (per-IP, per-user, per-tenant).
- **Secrets management:** no secrets in repo or images; inject from KMS/Vault at runtime; scan
  for leaked secrets in CI (gitleaks).
- **Dependency & container hygiene:** SCA (Dependabot/Snyk), image scanning (Trivy), minimal
  base images, non-root containers. *(Especially relevant for Path B — you're pulling
  fast-moving open-source WhatsApp libraries; watch their advisories.)*
- **Network:** private subnets for data stores, security groups/network policies,
  WAF + DDoS protection at the edge.
- **Audit logging:** append-only `audit_log` for sensitive actions (login, connect/disconnect
  number, view/export/delete contact, change CRM config). Ship logs to a tamper-evident sink.
- **Backups:** encrypted, tested restores, with the **same** access controls as prod — a
  backup is a copy of all the PII.
- **Observability without leaking PII:** never log message bodies, tokens, or `auth_state`.
  Redact in log pipelines; alert on anomalies (mass export, spike in failed logins).

---

## 7. Incident response & resilience
- **Breach runbook** mapped to legal timelines (PDPL/GDPR breach-notification windows).
- **Key compromise runbook:** rotate KMS keys, invalidate sessions, force CRM token refresh.
- **Path-B specific:** monitor for **number bans**; if a tenant's number is banned, fail
  gracefully, alert the tenant, and **don't cascade** to other numbers.
- **Least privilege** for staff access to prod data; just-in-time, audited, MFA-gated.

---

## 8. Security checklist (gate before production)
- [ ] MFA enforced; JWT short-lived; refresh in HttpOnly cookies
- [ ] RBAC + Postgres RLS, with automated cross-tenant isolation tests in CI
- [ ] Envelope encryption (KMS + per-tenant DEK) for `auth_state` & CRM creds
- [ ] TLS everywhere; HSTS; webhook signature verification (Path A)
- [ ] Signed, short-lived media URLs; no public buckets
- [ ] Export + erasure endpoints working; retention jobs running
- [ ] DPA + sub-processor list + per-tenant data region
- [ ] Secrets out of repo/images; SCA + container + secret scanning in CI
- [ ] No PII/tokens in logs; audit log append-only; alerting live
- [ ] Independent **penetration test** passed
- [ ] (Path B) ban-detection + isolation; documented ToS-risk sign-off

➡️ Next: **[05-realtime-sync.md](05-realtime-sync.md)**.
