// M8 acceptance for the auth_state credential: files are sealed on disk, sessions survive
// reloads, pre-M8 plaintext folders migrate in place, and a wrong key fails loudly instead
// of silently re-pairing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import { useEncryptedMultiFileAuthState } from './auth-state.js';

const KEY = randomBytes(32).toString('hex');

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wcb-auth-state-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('creds are encrypted on disk and identical after reload', async () => {
  const dir = tmp();
  const first = await useEncryptedMultiFileAuthState(dir, KEY);
  await first.saveCreds();

  const raw = await readFile(join(dir, 'creds.json'), 'utf8');
  assert.ok(raw.startsWith('enc:v1:'), 'creds.json must not be plaintext');
  assert.ok(!raw.includes('"private"'), 'no key material visible');

  const second = await useEncryptedMultiFileAuthState(dir, KEY);
  assert.deepEqual(
    second.state.creds.noiseKey.public,
    first.state.creds.noiseKey.public,
    'session identity survives the reload',
  );
});

test('signal key store round-trips Buffers through encryption', async () => {
  const dir = tmp();
  const { state } = await useEncryptedMultiFileAuthState(dir, KEY);
  const keyPair = { public: randomBytes(32), private: randomBytes(32) };
  await state.keys.set({ 'pre-key': { '7': keyPair } });

  const files = await readdir(dir);
  assert.ok(files.includes('pre-key-7.json'));
  assert.ok((await readFile(join(dir, 'pre-key-7.json'), 'utf8')).startsWith('enc:v1:'));

  const got = await state.keys.get('pre-key', ['7', 'missing']);
  assert.deepEqual(got['7']?.public, keyPair.public);
  assert.deepEqual(got['7']?.private, keyPair.private);
  assert.equal(got['missing'], null);

  await state.keys.set({ 'pre-key': { '7': null } }); // deletion path
  assert.ok(!(await readdir(dir)).includes('pre-key-7.json'));
});

test('pre-M8 plaintext folder migrates in place without losing the session', async () => {
  const dir = tmp();
  const creds = initAuthCreds();
  await writeFile(join(dir, 'creds.json'), JSON.stringify(creds, BufferJSON.replacer), 'utf8');

  const { state } = await useEncryptedMultiFileAuthState(dir, KEY);
  assert.deepEqual(state.creds.noiseKey.public, creds.noiseKey.public, 'session preserved');
  const raw = await readFile(join(dir, 'creds.json'), 'utf8');
  assert.ok(raw.startsWith('enc:v1:'), 'file upgraded to encrypted at rest');
});

test('wrong key fails loudly — never a silent re-pair', async () => {
  const dir = tmp();
  const { saveCreds } = await useEncryptedMultiFileAuthState(dir, KEY);
  await saveCreds();
  await assert.rejects(
    () => useEncryptedMultiFileAuthState(dir, randomBytes(32).toString('hex')),
    /APP_ENCRYPTION_KEY/,
  );
  await assert.rejects(() => useEncryptedMultiFileAuthState(dir), /APP_ENCRYPTION_KEY/);
});

test('no key → plaintext, fully backwards compatible', async () => {
  const dir = tmp();
  const { saveCreds } = await useEncryptedMultiFileAuthState(dir);
  await saveCreds();
  const raw = await readFile(join(dir, 'creds.json'), 'utf8');
  assert.ok(raw.startsWith('{'), 'plaintext JSON when no key configured');
  JSON.parse(raw); // and it is valid JSON
});
