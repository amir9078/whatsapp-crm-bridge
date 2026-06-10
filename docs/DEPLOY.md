# DEPLOY — self-host on a small VPS (~$5–12/mo)

Runs the whole stack (Postgres + API/connector + web UI) with one command via Docker
Compose. Locally (dev) the app still runs without Docker on SQLite: `pnpm server:dev` +
`pnpm web:dev`.

> ⚠ **Read the README disclaimer first.** This project drives an unofficial WhatsApp client
> (Baileys). It can violate WhatsApp's Terms of Service and numbers can be banned. Use a
> number you can afford to lose, reply-style traffic only.

## 1. What you need

- A VPS with **Docker + Docker Compose v2** (any $5–12/mo box works: Hetzner CX22,
  DigitalOcean basic, Lightsail, racknerd…). 2 GB RAM recommended (Next.js build needs it;
  add swap on 1 GB boxes).
- Your **Odoo** URL + database + API user + API key (Settings → My Profile → Account
  Security → New API Key).
- A phone with the WhatsApp account you'll link.

## 2. Configure

```bash
git clone <your-fork-or-this-repo> && cd whatsapp-crm-bridge
cp .env.example .env
```

Edit `.env` — the four values that matter in production:

| Variable | Set it to |
|---|---|
| `AUTH_PASSWORD` | A strong password — the UI/API login. **Never leave empty on a public host.** |
| `APP_ENCRYPTION_KEY` | 64 hex chars: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` — encrypts the WhatsApp session + CRM credentials at rest. Generate once, **back it up**; losing it = re-pair + re-enter CRM key. |
| `POSTGRES_PASSWORD` | Any strong password (internal to the compose network). |
| `NEXT_PUBLIC_API_URL` | The URL the **browser** uses to reach the API: `http://YOUR_SERVER_IP:4000` (or `https://api.your-domain.com` behind a proxy). Baked at build time — changing it requires `--build`. |

Optional: `RETENTION_DAYS=180` auto-purges messages older than N days (docs/04 §5.5).

## 3. Run

```bash
docker compose up -d --build
```

First boot: the server container creates the tables (`prisma db push`), then starts the
API + WhatsApp connector; the web UI comes up on port 3000.

- Open `http://YOUR_SERVER_IP:3000`, log in with `AUTH_PASSWORD`, scan the QR with
  WhatsApp (**Linked devices → Link a device**).
- Settings (⚙) → connect Odoo → **Test connection** → Save.

## 4. HTTPS (recommended)

Put Caddy (or nginx + certbot) in front — example Caddyfile:

```caddyfile
chat.your-domain.com {
    reverse_proxy localhost:3000
}
api.your-domain.com {
    reverse_proxy localhost:4000
}
```

Then rebuild the web bundle against the public API URL:
`NEXT_PUBLIC_API_URL=https://api.your-domain.com docker compose up -d --build`
and firewall ports 3000/4000 so only Caddy reaches them.

## 5. Operate

| Task | Command |
|---|---|
| Logs | `docker compose logs -f server` |
| Update to a new version | `git pull && docker compose up -d --build` |
| Backup database | `docker compose exec db pg_dump -U wcb wcb > backup.sql` |
| Backup WhatsApp session | the `wa_auth` volume (encrypted at rest with your key) |
| Export all chat data | Settings → "Download export (JSON)" or `GET /api/v1/data/export` |
| Wipe chat data | Settings → "Delete all chat data…" or `DELETE /api/v1/data?confirm=ALL` |
| Erase one contact (GDPR) | `DELETE /api/v1/contacts/:id` |

**What lives where:** Postgres data → `pg_data` volume; WhatsApp session credential →
`wa_auth` volume; CRM credentials → encrypted column in Postgres. Secrets (`.env`) never
enter the image (see `.dockerignore`).

## 6. Troubleshooting

- **Web loads but "server offline"** → `NEXT_PUBLIC_API_URL` is wrong for the browser
  (it must be reachable from the *user's* machine, not just inside Docker). Rebuild.
- **`auth_state is encrypted but APP_ENCRYPTION_KEY is not set`** → you changed/lost the
  key. Restore it, or delete the `wa_auth` volume and re-pair.
- **WhatsApp keeps reconnecting** → the linked phone must be online occasionally; check
  `docker compose logs -f server` for the disconnect reason.
