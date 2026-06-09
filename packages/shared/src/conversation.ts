import { z } from 'zod';

/** A 1:1 chat thread between a connected number and a contact. Spec: docs/03 §1–2. */
export const ConversationSchema = z.object({
  id: z.string().uuid(),
  contactId: z.string().uuid(),
  waConnectionId: z.string().uuid(),
  lastMessageAt: z.string().datetime().optional(),
  unreadCount: z.number().int().nonnegative().default(0),
  createdAt: z.string().datetime(),
});
export type Conversation = z.infer<typeof ConversationSchema>;
