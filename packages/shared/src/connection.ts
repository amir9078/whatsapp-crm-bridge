import { z } from 'zod';
import { ConnectionStatus, Provider } from './enums.js';

/**
 * A linked WhatsApp number. Sensitive `auth_state` is NOT part of this shared shape — it is
 * stored encrypted in the DB only (see docs/04 §3).
 */
export const WaConnectionSchema = z.object({
  id: z.string().uuid(),
  phoneE164: z.string(),
  provider: Provider,
  status: ConnectionStatus,
  createdAt: z.string().datetime(),
});
export type WaConnection = z.infer<typeof WaConnectionSchema>;
