import { z } from 'zod';

/** The other party in a conversation. Spec: docs/03 §1–2. */
export const ContactSchema = z.object({
  id: z.string().uuid(),
  /** WhatsApp id, e.g. "971501234567@s.whatsapp.net". */
  waId: z.string().optional(),
  /** Normalized phone in E.164, e.g. "+971501234567". */
  phoneE164: z.string().regex(/^\+[1-9]\d{6,15}$/, 'must be E.164 (e.g. +971501234567)'),
  displayName: z.string().optional(),
  createdAt: z.string().datetime(),
});
export type Contact = z.infer<typeof ContactSchema>;
