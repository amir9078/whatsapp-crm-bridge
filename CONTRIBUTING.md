# Contributing

Thanks for your interest! This project is built in small, self-contained milestones — see
[`BUILD_PLAN.md`](BUILD_PLAN.md) and the project guide in [`CLAUDE.md`](CLAUDE.md).

## Setup

- Node ≥ 20 and pnpm (`corepack enable`).
- `pnpm install`
- `pnpm lint` and `pnpm test` should pass before you push.

## Workflow

- Branch from `main`: `feat/…`, `fix/…`, `docs/…`, `chore/…`.
- Keep changes small and focused — ideally one milestone or sub-task at a time.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
  `docs:`, `chore:`, `refactor:`, `test:`).
- Run `pnpm lint` and `pnpm format` before opening a PR against `main`.

## Ground rules

- This is an **unofficial-client** project (see the README disclaimer). **Do not** add
  features designed for spam, bulk/unsolicited messaging, or evading WhatsApp's safeguards.
  Such PRs will be declined.
- **Never commit** secrets, `.env`, databases, or WhatsApp `auth_state`.
- Don't introduce a per-message paid dependency — staying free-to-self-host is a core goal.
