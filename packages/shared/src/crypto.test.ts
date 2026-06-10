import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { decryptString, encryptString, isEncrypted } from './crypto.js';

const KEY = randomBytes(32).toString('hex');

test('round-trip: encrypt → prefix-detectable → decrypt', () => {
  const secret = JSON.stringify({ accessToken: 'odoo-api-key', meta: { db: 'prod' } });
  const sealed = encryptString(secret, KEY);
  assert.ok(isEncrypted(sealed));
  assert.ok(!sealed.includes('odoo-api-key')); // no plaintext leakage
  assert.notEqual(encryptString(secret, KEY), sealed); // fresh IV every call
  assert.equal(decryptString(sealed, KEY), secret);
});

test('wrong key and tampering both fail closed', () => {
  const sealed = encryptString('top secret', KEY);
  assert.throws(
    () => decryptString(sealed, randomBytes(32).toString('hex')),
    /decryption failed/,
  );
  const tampered = sealed.slice(0, -6) + 'AAAAAA';
  assert.throws(() => decryptString(tampered, KEY), /decryption failed/);
});

test('bad keys are rejected with a helpful message', () => {
  assert.throws(() => encryptString('x', 'not-hex'), /64 hex characters/);
  assert.throws(() => encryptString('x', 'abcd'), /64 hex characters/);
  assert.throws(() => decryptString('plain text', KEY), /not an enc:v1 payload/);
});
