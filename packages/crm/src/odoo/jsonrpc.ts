// Minimal client for Odoo's External API over JSON-RPC (`POST /jsonrpc`). Two services:
// `common` (authenticate) and `object` (execute_kw → any model method). No SDK dependency;
// `fetchImpl` is injectable for tests.

export class OdooRpcError extends Error {
  constructor(
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = 'OdooRpcError';
  }
}

export interface OdooRpcOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface JsonRpcEnvelope {
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
    data?: { name?: string; message?: string; debug?: string };
  };
}

let nextRequestId = 1;

export async function odooRpc(
  baseUrl: string,
  service: 'common' | 'object',
  method: string,
  args: unknown[],
  opts: OdooRpcOptions = {},
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await fetchImpl(new URL('/jsonrpc', baseUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'call',
        id: nextRequestId++,
        params: { service, method, args },
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
    });
  } catch (err) {
    throw new OdooRpcError(
      `Odoo unreachable at ${baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw new OdooRpcError(`Odoo HTTP ${res.status} from ${baseUrl}/jsonrpc`);
  const payload = (await res.json()) as JsonRpcEnvelope;
  if (payload.error) {
    // Odoo puts the human-readable cause in error.data.message; error.message is generic.
    const detail = payload.error.data?.message ?? payload.error.message ?? 'unknown Odoo error';
    throw new OdooRpcError(`Odoo: ${detail}`, payload.error.data);
  }
  return payload.result;
}
