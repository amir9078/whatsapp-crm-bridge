// @wcb/connector — Baileys session: QR linking, send, inbound/status events.
// The Baileys implementation lands in M2 (see docs/05-realtime-sync.md).
//
// For now this re-exports the contract it will implement, which verifies that types resolve
// cleanly across workspace packages (@wcb/shared -> @wcb/connector).
import type { WhatsAppConnector } from '@wcb/shared';

export type { WhatsAppConnector };
