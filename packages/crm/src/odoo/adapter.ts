// Odoo CrmAdapter (docs/03 §6). Canonical → Odoo mapping:
//   Contact      → res.partner (searched by phone/mobile)
//   Note         → chatter note: res.partner.message_post(subtype mail.mt_note)
//   Note update  → mail.message.write (running-thread note rewritten in place)
// Auth is api_key: Odoo's External API takes db + username + API key (no OAuth).
import { z } from 'zod';
import type {
  ContactInput,
  CrmAdapter,
  CrmCapabilities,
  CrmCredentials,
  CrmNoteRef,
  CrmRecord,
  NoteInput,
} from '@wcb/shared';
import { odooRpc, type OdooRpcOptions } from './jsonrpc.js';

/** Instance coordinates kept in `CrmCredentials.meta`; the API key rides in `accessToken`. */
export const OdooConnectionSchema = z.object({
  baseUrl: z.string().url(),
  db: z.string().min(1),
  username: z.string().min(1),
});
export type OdooConnection = z.infer<typeof OdooConnectionSchema>;

interface OdooConfig extends OdooConnection {
  apiKey: string;
}

/** Build the canonical CrmCredentials envelope from an Odoo settings form. */
export function odooCredentials(input: OdooConnection & { apiKey: string }): CrmCredentials {
  return {
    accessToken: input.apiKey,
    meta: { baseUrl: input.baseUrl, db: input.db, username: input.username },
  };
}

function configFromCreds(creds: CrmCredentials): OdooConfig {
  const parsed = OdooConnectionSchema.safeParse(creds.meta ?? {});
  if (!parsed.success || !creds.accessToken) {
    throw new Error('Odoo credentials incomplete: need baseUrl, db, username and an API key');
  }
  return { ...parsed.data, apiKey: creds.accessToken };
}

const digitsOf = (s: string): string => s.replace(/\D/g, '');

/**
 * Same subscriber if the trailing 8 digits agree — Odoo stores phones in arbitrary human
 * formats ("+971 50 123 4567", "050-1234567"), so exact compare is hopeless (docs/03 §5).
 */
function samePhone(a: string, b: string): boolean {
  const da = digitsOf(a);
  const db = digitsOf(b);
  if (da.length < 7 || db.length < 7) return false;
  const n = Math.min(8, da.length, db.length);
  return da.slice(-n) === db.slice(-n);
}

/** Odoo returns `false` (not null) for empty char fields. */
const odooStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.length > 0 ? v : undefined;

type PartnerRow = Record<string, unknown>;

export class OdooAdapter implements CrmAdapter {
  readonly type = 'odoo' as const;
  readonly authKind = 'api_key' as const;
  readonly capabilities: CrmCapabilities = {
    supportsNoteUpdate: true,
    supportsActivities: false,
    rateLimitPerMin: 60,
  };

  // authenticate() costs a round trip; the uid is stable per (instance, db, user).
  private readonly uidCache = new Map<string, number>();

  constructor(private readonly opts: OdooRpcOptions = {}) {}

  private async uid(cfg: OdooConfig, forceReauth = false): Promise<number> {
    const key = `${cfg.baseUrl}|${cfg.db}|${cfg.username}`;
    if (forceReauth) this.uidCache.delete(key);
    const cached = this.uidCache.get(key);
    if (cached !== undefined) return cached;
    const result = await odooRpc(
      cfg.baseUrl,
      'common',
      'authenticate',
      [cfg.db, cfg.username, cfg.apiKey, {}],
      this.opts,
    );
    if (typeof result !== 'number' || result <= 0) {
      throw new Error('Odoo authentication failed — check database name, username, and API key');
    }
    this.uidCache.set(key, result);
    return result;
  }

  private async execKw(
    cfg: OdooConfig,
    model: string,
    method: string,
    args: unknown[],
    kwargs: Record<string, unknown> = {},
  ): Promise<unknown> {
    const uid = await this.uid(cfg);
    return odooRpc(
      cfg.baseUrl,
      'object',
      'execute_kw',
      [cfg.db, uid, cfg.apiKey, model, method, args, kwargs],
      this.opts,
    );
  }

  async testConnection(creds: CrmCredentials): Promise<{ ok: boolean; detail?: string }> {
    try {
      const cfg = configFromCreds(creds);
      await this.uid(cfg, true); // force re-auth so a changed key is actually exercised
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }

  private recordUrl(cfg: OdooConfig, id: number | string): string {
    const base = cfg.baseUrl.replace(/\/+$/, '');
    return `${base}/web#id=${id}&model=res.partner&view_type=form`;
  }

  private toRecord(cfg: OdooConfig, row: PartnerRow): CrmRecord {
    const id = String(row.id as number);
    return {
      id,
      type: 'contact',
      displayName: odooStr(row.name),
      url: this.recordUrl(cfg, id),
      properties: {
        phone: odooStr(row.phone),
        mobile: odooStr(row.mobile),
        email: odooStr(row.email),
      },
    };
  }

  async findContactByPhone(phone: string, creds: CrmCredentials): Promise<CrmRecord[]> {
    const cfg = configFromCreds(creds);
    const digits = digitsOf(phone);
    const tail = digits.slice(-9);
    // Odoo `like` is substring match. The %-spread variant ("5%0%1…") survives any separator
    // formatting; over-matches are culled by the samePhone post-filter below.
    const variants = [...new Set([phone, digits, tail, tail.split('').join('%')])].filter(
      (v) => digitsOf(v).length >= 5,
    );
    const leaves = variants.flatMap((v) => [
      ['phone', 'like', v],
      ['mobile', 'like', v],
    ]);
    const domain = [...Array<string>(leaves.length - 1).fill('|'), ...leaves];
    const rows = (await this.execKw(cfg, 'res.partner', 'search_read', [domain], {
      fields: ['id', 'name', 'phone', 'mobile', 'email'],
      limit: 10,
    })) as PartnerRow[];
    return rows
      .filter(
        (r) =>
          samePhone(phone, odooStr(r.phone) ?? '') || samePhone(phone, odooStr(r.mobile) ?? ''),
      )
      .map((r) => this.toRecord(cfg, r));
  }

  async searchContacts(query: string, creds: CrmCredentials): Promise<CrmRecord[]> {
    const cfg = configFromCreds(creds);
    const domain = [
      '|',
      '|',
      ['name', 'ilike', query],
      ['phone', 'ilike', query],
      ['mobile', 'ilike', query],
    ];
    const rows = (await this.execKw(cfg, 'res.partner', 'search_read', [domain], {
      fields: ['id', 'name', 'phone', 'mobile', 'email'],
      limit: 10,
    })) as PartnerRow[];
    return rows.map((r) => this.toRecord(cfg, r));
  }

  async createContact(input: ContactInput, creds: CrmCredentials): Promise<CrmRecord> {
    const cfg = configFromCreds(creds);
    const id = (await this.execKw(cfg, 'res.partner', 'create', [
      {
        name: input.displayName ?? input.phoneE164,
        phone: input.phoneE164,
        ...(input.email ? { email: input.email } : {}),
        comment: 'Created by WhatsApp CRM Bridge',
      },
    ])) as number;
    return {
      id: String(id),
      type: 'contact',
      displayName: input.displayName ?? input.phoneE164,
      url: this.recordUrl(cfg, id),
    };
  }

  async appendNote(
    recordId: string,
    note: NoteInput,
    creds: CrmCredentials,
  ): Promise<CrmNoteRef> {
    const cfg = configFromCreds(creds);
    const result = await this.execKw(cfg, 'res.partner', 'message_post', [[Number(recordId)]], {
      body: note.body,
      message_type: 'comment',
      subtype_xmlid: 'mail.mt_note', // internal note, not a customer-visible message
    });
    // message_post returns the mail.message id on modern Odoo; tolerate other shapes — an
    // empty id just means future flushes append a fresh note instead of updating in place.
    return { id: typeof result === 'number' ? String(result) : '' };
  }

  async updateNote(noteId: string, note: NoteInput, creds: CrmCredentials): Promise<void> {
    const cfg = configFromCreds(creds);
    await this.execKw(cfg, 'mail.message', 'write', [[Number(noteId)], { body: note.body }]);
  }
}
