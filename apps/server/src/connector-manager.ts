// ConnectorManager (M10): runs ONE WhatsApp session per salesperson. Each WaConnection row
// gets its own BaileysConnector with its own auth_state subfolder, and every event it emits
// is tagged with that connection's id so the server ingests/sends under the right inbox.
import { rename, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  createWaConnection,
  deleteWaConnection,
  listWaConnections,
  updateWaConnection,
  type PrismaClient,
} from '@wcb/db';
import type { ConnectionStatus, ConnectorEvent, WhatsAppConnector } from '@wcb/shared';

export interface ConnectionState {
  id: string;
  label: string | null;
  phoneE164: string | null;
  status: ConnectionStatus;
  qr?: string;
}

/** Builds a connector for one connection id (real = BaileysConnector; tests inject a fake). */
export type ConnectorFactory = (connectionId: string) => WhatsAppConnector;

export interface ConnectorManagerDeps {
  prisma: PrismaClient;
  connectorFactory: ConnectorFactory;
  /** Per-connection events are forwarded here, tagged with the connection id. */
  onEvent: (connectionId: string, event: ConnectorEvent) => void;
  /** Root auth_state folder; each connection lives in `<baseAuthDir>/<id>`. */
  baseAuthDir: string;
  log?: (msg: string, err?: unknown) => void;
}

interface Entry {
  connector: WhatsAppConnector;
  label: string | null;
  phoneE164: string | null;
  status: ConnectionStatus;
  qr?: string;
}

export class ConnectorManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: ConnectorManagerDeps) {}

  /** Migrate a pre-M10 flat auth_state into the first connection's subfolder, then start all. */
  async init(): Promise<void> {
    await mkdir(this.deps.baseAuthDir, { recursive: true });
    let rows = await listWaConnections(this.deps.prisma);

    // Pre-M10: a single flat `auth_state/creds.json`. Move it under the existing connection so
    // the live session is preserved instead of forcing a re-scan.
    const flatCreds = join(this.deps.baseAuthDir, 'creds.json');
    if (await exists(flatCreds)) {
      const target = rows[0] ?? (await createWaConnection(this.deps.prisma));
      if (!rows.length) rows = [target];
      await this.migrateFlatAuthState(target.id);
    }
    if (rows.length === 0) {
      // Fresh install: create the first inbox so a QR shows up.
      rows = [await createWaConnection(this.deps.prisma)];
    }

    for (const row of rows) {
      await this.startEntry(row.id, row.label, row.phoneE164);
    }
  }

  private async migrateFlatAuthState(connectionId: string): Promise<void> {
    const dest = join(this.deps.baseAuthDir, connectionId);
    await mkdir(dest, { recursive: true });
    const names = await readdir(this.deps.baseAuthDir);
    for (const name of names) {
      const src = join(this.deps.baseAuthDir, name);
      if (name === connectionId) continue; // the dest folder itself
      if (!(await stat(src)).isFile()) continue; // skip other connection subfolders
      await rename(src, join(dest, name)).catch((err: unknown) => this.deps.log?.('migrate', err));
    }
    this.deps.log?.(`migrated flat auth_state → ${connectionId}`);
  }

  private authDirFor(connectionId: string): string {
    return join(this.deps.baseAuthDir, connectionId);
  }

  private async startEntry(
    id: string,
    label: string | null,
    phoneE164: string | null,
  ): Promise<void> {
    const connector = this.deps.connectorFactory(id);
    const entry: Entry = { connector, label, phoneE164, status: 'disconnected' };
    this.entries.set(id, entry);

    connector.on((event) => {
      this.trackState(id, event);
      this.deps.onEvent(id, event);
    });
    try {
      await connector.connect();
    } catch (err) {
      this.deps.log?.(`connector ${id} failed to connect`, err);
    }
  }

  /** Keep per-connection status/qr current from the connector's own events. */
  private trackState(id: string, event: ConnectorEvent): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (event.type === 'qr') {
      entry.status = 'qr_pending';
      entry.qr = event.qr;
    } else if (event.type === 'connection') {
      entry.status = event.status;
      if (event.status === 'connected') entry.qr = undefined;
    }
  }

  /** Add a salesperson: new connection row + connector → its own QR. */
  async add(label?: string): Promise<ConnectionState> {
    const row = await createWaConnection(this.deps.prisma, label);
    await this.startEntry(row.id, row.label, row.phoneE164);
    return this.state(row.id)!;
  }

  /** Remove a salesperson: stop the session, delete its auth folder + all its data. */
  async remove(id: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    try {
      await entry.connector.disconnect();
    } catch (err) {
      this.deps.log?.(`disconnect ${id}`, err);
    }
    this.entries.delete(id);
    await rm(this.authDirFor(id), { recursive: true, force: true }).catch(() => undefined);
    await deleteWaConnection(this.deps.prisma, id);
    return true;
  }

  getConnector(id: string): WhatsAppConnector | undefined {
    return this.entries.get(id)?.connector;
  }

  state(id: string): ConnectionState | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    return { id, label: e.label, phoneE164: e.phoneE164, status: e.status, qr: e.qr };
  }

  list(): ConnectionState[] {
    return [...this.entries.entries()].map(([id, e]) => ({
      id,
      label: e.label,
      phoneE164: e.phoneE164,
      status: e.status,
      qr: e.qr,
    }));
  }

  /** Record a learned phone number for a connection (from its own connection event). */
  async setPhone(id: string, phoneE164: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry || entry.phoneE164 === phoneE164) return;
    entry.phoneE164 = phoneE164;
    await updateWaConnection(this.deps.prisma, id, { phoneE164 }).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    for (const entry of this.entries.values()) {
      await entry.connector.disconnect().catch(() => undefined);
    }
    this.entries.clear();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
