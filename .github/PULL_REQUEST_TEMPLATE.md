## What & why

<!-- One or two sentences: what changes, and what problem it solves. Link issues: Fixes #123 -->

## How it was tested

<!-- New/updated tests, manual steps, screenshots for UI changes -->

## Checklist

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass locally
- [ ] New behaviour is covered by a test (adapters: against a fake server, like `packages/crm/src/odoo/adapter.test.ts`)
- [ ] No secrets, phone numbers, or chat content in code, tests, or fixtures
- [ ] No bulk-messaging features (out of scope by design — see README disclaimer)
- [ ] Docs updated if behaviour changed (`README.md`, `docs/`, `.env.example`)
