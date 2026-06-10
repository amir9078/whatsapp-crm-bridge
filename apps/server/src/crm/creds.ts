// CRM credential sealing (M8): with APP_ENCRYPTION_KEY the DB column holds an enc:v1
// AES-256-GCM payload; without it, plain JSON (local dev). Reads accept both, so a pre-M8
// row keeps working and gets encrypted on its next save.
import { decryptString, encryptString, isEncrypted } from '@wcb/shared/crypto';
import type { CrmCredentials } from '@wcb/shared';

export function sealCreds(creds: CrmCredentials, encryptionKey?: string): string {
  const json = JSON.stringify(creds);
  return encryptionKey ? encryptString(json, encryptionKey) : json;
}

export function openCreds(stored: string, encryptionKey?: string): CrmCredentials {
  if (isEncrypted(stored)) {
    if (!encryptionKey) {
      throw new Error('CRM credentials are encrypted but APP_ENCRYPTION_KEY is not set');
    }
    return JSON.parse(decryptString(stored, encryptionKey)) as CrmCredentials;
  }
  return JSON.parse(stored) as CrmCredentials;
}
