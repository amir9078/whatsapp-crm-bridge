// Encrypted drop-in for Baileys' useMultiFileAuthState (M8, docs/04 §2.3 + §3.2): the
// auth_state folder IS a credential — anyone holding it owns the WhatsApp session. With an
// APP_ENCRYPTION_KEY every file is sealed with AES-256-GCM; existing plaintext folders are
// migrated in place on first open. Without a key it behaves exactly like the original.
import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';
import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataSet,
  SignalDataTypeMap,
} from '@whiskeysockets/baileys';
import { decryptString, encryptString, isEncrypted } from '@wcb/shared/crypto';

// `proto` is re-exported by Baileys via __exportStar, which Node's CJS named-export
// detection can't see — a named ESM import works for types but is undefined at runtime.
const require = createRequire(import.meta.url);
const { proto } = require('@whiskeysockets/baileys') as {
  proto: { Message: { AppStateSyncKeyData: { fromObject(obj: unknown): unknown } } };
};

const fixFileName = (file: string): string => file.replace(/\//g, '__').replace(/:/g, '-');

export interface EncryptedAuthState {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

export async function useEncryptedMultiFileAuthState(
  folder: string,
  encryptionKey?: string,
): Promise<EncryptedAuthState> {
  await mkdir(folder, { recursive: true });
  if (encryptionKey) await migratePlaintextFiles(folder, encryptionKey);

  const writeData = async (data: unknown, file: string): Promise<void> => {
    let payload = JSON.stringify(data, BufferJSON.replacer);
    if (encryptionKey) payload = encryptString(payload, encryptionKey);
    await writeFile(join(folder, fixFileName(file)), payload, 'utf8');
  };

  const readData = async (file: string): Promise<unknown> => {
    try {
      let raw = await readFile(join(folder, fixFileName(file)), 'utf8');
      if (isEncrypted(raw)) {
        if (!encryptionKey) {
          throw new Error('auth_state is encrypted but APP_ENCRYPTION_KEY is not set');
        }
        raw = decryptString(raw, encryptionKey);
      }
      return JSON.parse(raw, BufferJSON.reviver) as unknown;
    } catch (err) {
      // A key problem must fail loudly — returning null here would silently drop the
      // session and force a re-pair. Missing/corrupt single files are recoverable.
      if (err instanceof Error && err.message.includes('APP_ENCRYPTION_KEY')) throw err;
      return null;
    }
  };

  const removeData = async (file: string): Promise<void> => {
    try {
      await unlink(join(folder, fixFileName(file)));
    } catch {
      /* already gone */
    }
  };

  const creds = ((await readData('creds.json')) as AuthenticationCreds | null) ?? initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const data: { [id: string]: SignalDataTypeMap[T] } = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}.json`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value as SignalDataTypeMap[T];
            }),
          );
          return data;
        },
        set: async (data: SignalDataSet) => {
          const tasks: Promise<void>[] = [];
          for (const category of Object.keys(data) as (keyof SignalDataTypeMap)[]) {
            const entries = data[category];
            if (!entries) continue;
            for (const id of Object.keys(entries)) {
              const value: unknown = entries[id];
              const file = `${category}-${id}.json`;
              tasks.push(value ? writeData(value, file) : removeData(file));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds.json'),
  };
}

/** One-shot in-place upgrade of a pre-M8 plaintext auth folder. */
async function migratePlaintextFiles(folder: string, key: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(folder);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const path = join(folder, name);
    try {
      const raw = await readFile(path, 'utf8');
      if (isEncrypted(raw)) continue;
      JSON.parse(raw); // only migrate things that really are plaintext JSON
      await writeFile(path, encryptString(raw, key), 'utf8');
    } catch {
      /* unreadable/non-JSON file — leave it alone */
    }
  }
}
