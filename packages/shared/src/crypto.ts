// At-rest encryption for secrets (M8): AES-256-GCM keyed by APP_ENCRYPTION_KEY (32-byte
// hex). Used for CRM credentials in the DB and the Baileys auth_state files. Self-host
// simplification of docs/04 §3.2 — single key instead of KMS envelope encryption.
//
// NOT exported from the package index on purpose: this module needs node:crypto and must
// never end up in the browser bundle. Import via the subpath `@wcb/shared/crypto`.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Validate and decode APP_ENCRYPTION_KEY (64 hex chars = 32 bytes). */
export function decodeKey(keyHex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(keyHex)) {
    throw new Error(
      'APP_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: ' +
        `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return Buffer.from(keyHex, 'hex');
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** plaintext → "enc:v1:<iv b64>:<ciphertext|tag b64>" */
export function encryptString(plain: string, keyHex: string): string {
  const key = decodeKey(keyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const sealed = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return `${PREFIX}${iv.toString('base64')}:${sealed.toString('base64')}`;
}

export function decryptString(payload: string, keyHex: string): string {
  if (!isEncrypted(payload)) throw new Error('not an enc:v1 payload');
  const key = decodeKey(keyHex);
  const [ivB64, sealedB64] = payload.slice(PREFIX.length).split(':');
  if (!ivB64 || !sealedB64) throw new Error('malformed enc:v1 payload');
  const iv = Buffer.from(ivB64, 'base64');
  const sealed = Buffer.from(sealedB64, 'base64');
  const ciphertext = sealed.subarray(0, sealed.length - TAG_BYTES);
  const tag = sealed.subarray(sealed.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    // GCM auth failure — wrong key or tampered data. Don't leak which.
    throw new Error('decryption failed — wrong APP_ENCRYPTION_KEY or corrupted data');
  }
}
