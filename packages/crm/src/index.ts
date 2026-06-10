// @wcb/crm — CrmAdapter implementations + helpers. M6 ships Odoo; each further CRM is one
// more adapter file + a case in the factory. Spec: docs/03-api-and-data-design.md §5–6.
import type { CrmAdapter } from '@wcb/shared';
import { OdooAdapter } from './odoo/adapter.js';

export { OdooAdapter, odooCredentials, OdooConnectionSchema } from './odoo/adapter.js';
export type { OdooConnection } from './odoo/adapter.js';
export { OdooRpcError, odooRpc } from './odoo/jsonrpc.js';
export { buildTranscriptHtml, type TranscriptMessage } from './transcript.js';

/** Default adapter registry. The server lets tests inject fakes instead. */
export function createCrmAdapters(): Record<string, CrmAdapter> {
  return { odoo: new OdooAdapter() };
}
