// OdooAdapter against a fake in-process Odoo JSON-RPC server: auth, phone matching across
// human formats, contact creation, and the running-note append/update cycle.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { CrmCredentials } from '@wcb/shared';
import { OdooAdapter, odooCredentials } from './adapter.js';

const API_KEY = 'good-key';
const UID = 7;

interface FakePartner {
  id: number;
  name: string;
  phone: string | false;
  mobile: string | false;
  email: string | false;
}

const partners: FakePartner[] = [
  // Stored the way humans type numbers into Odoo — spaces and dashes.
  { id: 1, name: 'Sarah Mensah', phone: '+971 50 123 4567', mobile: false, email: 'sarah@x.com' },
  { id: 2, name: 'Omar Khan', phone: false, mobile: '050-765 4321', email: false },
  { id: 3, name: 'No Phone Co', phone: false, mobile: false, email: 'info@nophone.com' },
];
const notes = new Map<number, { resId: number; body: string }>();
let nextNoteId = 100;
let nextPartnerId = 50;
let authCalls = 0;

// Odoo `like` is substring match; pattern may contain % wildcards.
function likeMatch(value: string | false, pattern: string): boolean {
  if (value === false) return false;
  const re = new RegExp(
    pattern
      .split('%')
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*'),
  );
  return re.test(value);
}

type DomainLeaf = [string, string, string];

function matchesDomain(p: FakePartner, domain: unknown[]): boolean {
  // Our fake only sees OR-chains, so any-leaf-matches is the correct evaluation.
  const leaves = domain.filter((d): d is DomainLeaf => Array.isArray(d));
  return leaves.some(([field, op, pattern]) => {
    const value = p[field as 'phone' | 'mobile' | 'name'];
    if (op === 'like') return likeMatch(value, pattern);
    if (op === 'ilike')
      return typeof value === 'string' && value.toLowerCase().includes(pattern.toLowerCase());
    return false;
  });
}

function executeKw(args: unknown[]): unknown {
  const [, , apiKey, model, method, posArgs, kwargs] = args as [
    string,
    number,
    string,
    string,
    string,
    unknown[],
    Record<string, unknown> | undefined,
  ];
  if (apiKey !== API_KEY) throw new Error('Access Denied');

  if (model === 'res.partner' && method === 'search_read') {
    const domain = (posArgs[0] ?? []) as unknown[];
    const fields = (kwargs?.fields ?? []) as string[];
    return partners
      .filter((p) => matchesDomain(p, domain))
      .map((p) => Object.fromEntries([['id', p.id], ...fields.map((f) => [f, p[f as keyof FakePartner] ?? false])]));
  }
  if (model === 'res.partner' && method === 'create') {
    const vals = posArgs[0] as { name: string; phone?: string; email?: string };
    const partner: FakePartner = {
      id: nextPartnerId++,
      name: vals.name,
      phone: vals.phone ?? false,
      mobile: false,
      email: vals.email ?? false,
    };
    partners.push(partner);
    return partner.id;
  }
  if (model === 'res.partner' && method === 'message_post') {
    const [ids] = posArgs as [number[]];
    const id = nextNoteId++;
    notes.set(id, { resId: ids[0]!, body: String(kwargs?.body ?? '') });
    return id;
  }
  if (model === 'mail.message' && method === 'write') {
    const [ids, vals] = posArgs as [number[], { body: string }];
    const note = notes.get(ids[0]!);
    if (!note) throw new Error(`mail.message ${ids[0]} not found`);
    note.body = vals.body;
    return true;
  }
  throw new Error(`fake odoo: unhandled ${model}.${method}`);
}

let server: Server;
let creds: CrmCredentials;
const adapter = new OdooAdapter();

before(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const { id, params } = JSON.parse(raw) as {
        id: number;
        params: { service: string; method: string; args: unknown[] };
      };
      let body: object;
      try {
        let result: unknown;
        if (params.service === 'common' && params.method === 'authenticate') {
          authCalls++;
          result = params.args[2] === API_KEY ? UID : false;
        } else if (params.service === 'object' && params.method === 'execute_kw') {
          result = executeKw(params.args);
        } else {
          throw new Error(`unhandled ${params.service}.${params.method}`);
        }
        body = { jsonrpc: '2.0', id, result };
      } catch (err) {
        body = {
          jsonrpc: '2.0',
          id,
          error: { code: 200, message: 'Odoo Server Error', data: { message: String(err) } },
        };
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  creds = odooCredentials({
    baseUrl: `http://127.0.0.1:${addr.port}`,
    db: 'testdb',
    username: 'api@user.com',
    apiKey: API_KEY,
  });
});

after(() => server.close());

test('testConnection: ok with valid key, helpful failure with a bad one', async () => {
  assert.deepEqual(await adapter.testConnection(creds), { ok: true });
  const bad = await adapter.testConnection({ ...creds, accessToken: 'wrong' });
  assert.equal(bad.ok, false);
  assert.match(bad.detail ?? '', /authentication failed/i);
});

test('findContactByPhone matches human-formatted numbers, exactly one record', async () => {
  // E.164 input vs "+971 50 123 4567" stored with spaces
  const found = await adapter.findContactByPhone('+971501234567', creds);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.displayName, 'Sarah Mensah');
  assert.equal(found[0]?.type, 'contact');
  assert.match(found[0]?.url ?? '', /web#id=1&model=res\.partner/);

  // mobile field, national format with dash/space stored
  const mobile = await adapter.findContactByPhone('+971507654321', creds);
  assert.equal(mobile.length, 1);
  assert.equal(mobile[0]?.displayName, 'Omar Khan');

  // unknown number → no match (and never a false positive)
  assert.equal((await adapter.findContactByPhone('+14155550000', creds)).length, 0);
});

test('createContact creates a res.partner and returns its record', async () => {
  const rec = await adapter.createContact(
    { phoneE164: '+971529998877', displayName: 'New Lead' },
    creds,
  );
  assert.equal(rec.displayName, 'New Lead');
  const refound = await adapter.findContactByPhone('+971529998877', creds);
  assert.equal(refound[0]?.id, rec.id);
});

test('appendNote posts a chatter note; updateNote rewrites it in place', async () => {
  const ref = await adapter.appendNote('1', { body: '<p>transcript v1</p>' }, creds);
  assert.ok(ref.id);
  assert.equal(notes.get(Number(ref.id))?.body, '<p>transcript v1</p>');
  assert.equal(notes.get(Number(ref.id))?.resId, 1);

  await adapter.updateNote(ref.id, { body: '<p>transcript v2 (running thread)</p>' }, creds);
  assert.equal(notes.get(Number(ref.id))?.body, '<p>transcript v2 (running thread)</p>');
});

test('searchContacts finds by name for the manual-link picker', async () => {
  const hits = await adapter.searchContacts('omar', creds);
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.displayName, 'Omar Khan');
});

test('uid is cached — repeated calls do not re-authenticate', async () => {
  const before = authCalls;
  await adapter.findContactByPhone('+971501234567', creds);
  await adapter.searchContacts('sarah', creds);
  assert.equal(authCalls, before);
});
