// Builds the running-thread note body (docs/03 §6.2): ONE note per conversation, rewritten
// on every flush — never one CRM note per WhatsApp message.

export interface TranscriptMessage {
  direction: 'in' | 'out';
  type: string;
  body?: string | null;
  senderName?: string | null;
  timestamp: Date;
}

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const fmtTime = (d: Date): string => d.toISOString().slice(0, 16).replace('T', ' ');

export function buildTranscriptHtml(opts: {
  contactName: string;
  phoneE164: string;
  /** Salesperson / inbox this conversation belongs to (M10) — stamped on the note. */
  inboxLabel?: string | null;
  messages: TranscriptMessage[];
  /** Cap so a years-long chat doesn't become a megabyte note. */
  limit?: number;
}): string {
  const limit = opts.limit ?? 200;
  const shown = opts.messages.slice(-limit);
  const truncated = opts.messages.length > shown.length;

  const via = opts.inboxLabel ? ` · via ${escapeHtml(opts.inboxLabel)}` : '';
  const header =
    `<p><b>WhatsApp conversation — ${escapeHtml(opts.contactName)} (${escapeHtml(opts.phoneE164)})${via}</b><br/>` +
    `Auto-logged by WhatsApp CRM Bridge${via} · ` +
    (truncated ? `last ${shown.length} of ${opts.messages.length} messages` : `${shown.length} messages`) +
    ` · times in UTC</p>`;

  const lines = shown.map((m) => {
    const who = m.direction === 'out' ? 'Me' : (m.senderName ?? opts.contactName);
    const arrow = m.direction === 'out' ? '→' : '←';
    const body =
      m.type === 'text'
        ? escapeHtml(m.body ?? '')
        : `[${escapeHtml(m.type)}]${m.body ? ` ${escapeHtml(m.body)}` : ''}`;
    return `${fmtTime(m.timestamp)} ${arrow} <b>${escapeHtml(who)}</b>: ${body}`;
  });

  return `${header}<p>${lines.join('<br/>')}</p>`;
}
