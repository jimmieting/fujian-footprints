import { createHash, randomUUID } from 'node:crypto';
import { COUNTY_IDS } from './fujian-counties.js';

const VALID_IDS = new Set(COUNTY_IDS);
const CODE_PATTERN = /^FJ1-[A-Za-z0-9_-]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_BODY_BYTES = 8192;
const ALLOWED_METHODS = 'GET, POST, PATCH, DELETE, OPTIONS';
const READ_OPTIONS = Object.freeze({ type: 'json', consistency: 'strong' });

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const digest = value => createHash('sha256').update(value).digest('hex');
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timeIsValid = value => Number.isSafeInteger(value) && value >= 0;
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function exactKeys(value, required) {
  return isObject(value) && Object.keys(value).length === required.length && required.every(key => Object.hasOwn(value, key));
}

function normalizeVisited(value) {
  if (!Array.isArray(value) || value.length > COUNTY_IDS.length || value.some(id => typeof id !== 'string' || !VALID_IDS.has(id)) || new Set(value).size !== value.length) {
    fail(400, 'invalid_visited', '足迹必须是84个有效县区代码内的去重列表。');
  }
  return [...value].sort();
}

function normalizeChanges(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > COUNTY_IDS.length) {
    fail(400, 'invalid_changes', '每次修改需要1至84个有效县区。');
  }
  const ids = new Set();
  const changes = value.map(change => {
    if (!exactKeys(change, ['id', 'visited']) || typeof change.id !== 'string' || !VALID_IDS.has(change.id) || typeof change.visited !== 'boolean' || ids.has(change.id)) {
      fail(400, 'invalid_changes', '县区修改格式不正确，或包含重复县区。');
    }
    ids.add(change.id);
    return { id: change.id, visited: change.visited };
  });
  return changes.sort((a, b) => compareText(a.id, b.id));
}

async function readJsonBody(request) {
  if ((request.headers.get('content-type') || '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    fail(415, 'json_required', '请使用JSON格式提交记录。');
  }
  const declaredLength = request.headers.get('content-length');
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_BODY_BYTES) {
    fail(413, 'body_too_large', '请求超过8KB限制。');
  }
  // Makers Node handlers can expose a buffered/parsed body instead of a Web
  // ReadableStream. Keep the byte cap and schemas identical for both adapters.
  if (request.body && typeof request.body.getReader !== 'function') {
    let value = request.body;
    if (typeof request.text === 'function') value = await request.text();
    else if (!(typeof value === 'string' || value instanceof Uint8Array || value instanceof ArrayBuffer || isObject(value))) {
      if (typeof request.json === 'function') value = await request.json();
      else fail(400, 'invalid_json', '请求不是有效的JSON。');
    }
    let text;
    try {
      text = typeof value === 'string' ? value : value instanceof Uint8Array || value instanceof ArrayBuffer ? new TextDecoder('utf-8', { fatal: true }).decode(value) : JSON.stringify(value);
    } catch { fail(400, 'invalid_json', '请求不是有效的JSON。'); }
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) fail(413, 'body_too_large', '请求超过8KB限制。');
    try { return JSON.parse(text); } catch { fail(400, 'invalid_json', '请求不是有效的JSON。'); }
  }
  const chunks = [];
  let length = 0;
  if (request.body) {
    const reader = request.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > MAX_BODY_BYTES) {
          await reader.cancel();
          fail(413, 'body_too_large', '请求超过8KB限制。');
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
  }
  try {
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail(400, 'invalid_json', '请求不是有效的JSON。');
  }
}

async function mapLimit(values, concurrency, action) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await action(values[index]);
    }
  }));
  return results;
}

function assertMeta(meta) {
  if (!isObject(meta) || meta.version !== 1 || !timeIsValid(meta.createdAt)) throw new Error('Invalid record metadata');
  try { normalizeVisited(meta.visited); } catch { throw new Error('Invalid record metadata'); }
  return meta;
}

function assertOperation(operation, key) {
  const receipt = /\/ops\/([^/]+)\/(\d+)-([^/]+)\.json$/.exec(key);
  if (!isObject(operation) || operation.version !== 1 || !UUID_PATTERN.test(operation.operationId) || !timeIsValid(operation.committedAt) || !receipt || receipt[1] !== operation.operationId || Number(receipt[2]) !== operation.committedAt || !UUID_PATTERN.test(receipt[3])) throw new Error('Invalid record operation');
  let changes;
  try { changes = normalizeChanges(operation.changes); } catch { throw new Error('Invalid record operation'); }
  if (operation.hash !== digest(JSON.stringify(changes))) throw new Error('Invalid record operation');
  return { ...operation, changes, receiptKey: key };
}

const compareReceipts = (a, b) => a.committedAt - b.committedAt || compareText(a.receiptKey, b.receiptKey);

function canonicalOperations(receipts) {
  const earliest = new Map();
  for (const receipt of receipts) {
    const existing = earliest.get(receipt.operationId);
    if (!existing || compareReceipts(receipt, existing) < 0) earliest.set(receipt.operationId, receipt);
  }
  return [...earliest.values()];
}

/**
 * Blob has no compare-and-swap. Every attempted write therefore appends its own
 * immutable receipt. A logical operation is its earliest receipt, so a concurrent
 * duplicate retry can never rewrite its timestamp and move an old edit after an
 * undo. A retry reuses the UUID and changes; logical edits are ordered by their
 * earliest server time, then operation UUID for equal millisecond timestamps.
 */
export function createRecordHandler({ store, now = Date.now, maxOperations = 4000, readConcurrency = 12 }) {
  if (!store || !['get', 'setJSON', 'list', 'delete'].every(method => typeof store[method] === 'function')) throw new TypeError('A private Blob store adapter is required');

  const read = key => store.get(key, READ_OPTIONS);
  const isDeleted = async prefix => (await read(`${prefix}deleted.json`)) !== null;

  async function listOperations(prefix, operationId) {
    const scope = `${prefix}ops/${operationId ? `${operationId}/` : ''}`;
    const { blobs } = await store.list({ prefix: scope, consistency: 'strong' });
    if (!Array.isArray(blobs)) throw new Error('Invalid storage listing');
    return blobs.map(blob => blob.key).filter(key => key.startsWith(scope) && key.endsWith('.json'));
  }

  async function readReceipts(keys) {
    return mapLimit(keys, readConcurrency, async key => {
      const operation = await read(key);
      if (operation === null) throw new Error('Operation disappeared during read');
      return assertOperation(operation, key);
    });
  }

  async function earliestReceipt(prefix, operationId) {
    const receipts = await readReceipts(await listOperations(prefix, operationId));
    receipts.sort(compareReceipts);
    return receipts[0] || null;
  }

  async function loadRecord(prefix, meta) {
    assertMeta(meta);
    const keys = await listOperations(prefix);
    if (keys.length > maxOperations + 100) fail(507, 'record_limit', '记录操作过多，请导出足迹后生成新的保存码。');
    const operations = canonicalOperations(await readReceipts(keys));
    operations.sort((a, b) => a.committedAt - b.committedAt || compareText(a.operationId, b.operationId));
    const visited = new Set(meta.visited);
    let updatedAt = meta.createdAt;
    for (const operation of operations) {
      for (const change of operation.changes) {
        if (change.visited) visited.add(change.id);
        else visited.delete(change.id);
      }
      updatedAt = Math.max(updatedAt, operation.committedAt);
    }
    return { version: 1, visited: [...visited].sort(), updatedAt: new Date(updatedAt).toISOString() };
  }

  function operationAck(operation, duplicate) {
    return {
      version: 1,
      operationId: operation.operationId,
      committedAt: operation.committedAt,
      updatedAt: new Date(operation.committedAt).toISOString(),
      duplicate,
    };
  }

  return async function handleRecordRequest(request) {
    let stage = 'authorization';
    const origin = request.headers.get('origin');
    const headers = new Headers({
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Vary': 'Origin',
    });
    const response = (payload, status = 200) => new Response(payload === null ? null : JSON.stringify(payload), { status, headers });

    try {
      const url = new URL(request.url);
      if (origin && origin !== url.origin) fail(403, 'origin_denied', '此来源不允许访问足迹记录。');
      if (origin) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
        headers.set('Access-Control-Allow-Methods', ALLOWED_METHODS);
      }
      if (request.method === 'OPTIONS') return response(null, 204);
      if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(request.method)) {
        headers.set('Allow', ALLOWED_METHODS);
        fail(405, 'method_not_allowed', '此请求方法不受支持。');
      }
      if (url.search) fail(400, 'query_not_allowed', '保存码只能通过授权请求头提交。');
      const match = /^Bearer[ \t]+(\S+)$/i.exec(request.headers.get('authorization') || '');
      if (!match || !CODE_PATTERN.test(match[1])) fail(401, 'invalid_code', '保存码格式不正确。');
      const prefix = `records/${digest(`fujian-footprints-v1:${match[1]}`)}/`;
      const metaKey = `${prefix}meta.json`;

      if (request.method === 'DELETE') {
        // A tiny tombstone permanently revokes this code and prevents an in-flight
        // write or a late create retry from bringing deleted footmarks back.
        await store.setJSON(`${prefix}deleted.json`, { deletedAt: now() });
        const keys = await listOperations(prefix);
        await mapLimit(keys, readConcurrency, key => store.delete(key));
        await store.delete(metaKey);
        return response({ deleted: true });
      }

      stage = 'read_record';
      if (await isDeleted(prefix)) fail(410, 'record_deleted', '这份记录已删除，请生成新的保存码。');
      let meta = await read(metaKey);

      if (request.method === 'POST') {
        stage = 'read_body';
        const body = await readJsonBody(request);
        if (!exactKeys(body, ['visited'])) fail(400, 'invalid_schema', '创建请求只接受visited字段。');
        const visited = normalizeVisited(body.visited);
        if (meta !== null) return response({ ...(await loadRecord(prefix, meta)), created: false });
        const createdAt = now();
        if (!timeIsValid(createdAt)) throw new Error('Invalid server clock');
        meta = { version: 1, visited, createdAt };
        stage = 'write_record';
        await store.setJSON(metaKey, meta);
        if (await isDeleted(prefix)) {
          await store.delete(metaKey);
          fail(410, 'record_deleted', '这份记录已删除，请生成新的保存码。');
        }
        return response({ version: 1, visited, updatedAt: new Date(createdAt).toISOString(), created: true }, 201);
      }

      if (meta === null) fail(404, 'record_not_found', '未找到这份记录，请检查保存码。');
      assertMeta(meta);
      if (request.method === 'GET') return response(await loadRecord(prefix, meta));

      const body = await readJsonBody(request);
      if (!exactKeys(body, ['operationId', 'changes']) || typeof body.operationId !== 'string' || !UUID_PATTERN.test(body.operationId)) {
        fail(400, 'invalid_schema', '修改请求需要有效的operationId和changes。');
      }
      const changes = normalizeChanges(body.changes);
      const hash = digest(JSON.stringify(changes));
      const existing = await earliestReceipt(prefix, body.operationId);
      if (existing !== null) {
        if (existing.hash !== hash) fail(409, 'operation_conflict', '操作编号已用于不同修改，请重新读取记录。');
        return response(operationAck(existing, true));
      }
      // This is a capacity guard, not an atomic counter. Concurrent new operations
      // may briefly exceed it; GET retains a small margin to keep those readable.
      if ((await listOperations(prefix)).length >= maxOperations) fail(507, 'record_limit', '这份记录已达到修改上限，请导出足迹后生成新的保存码。');
      const committedAt = now();
      if (!timeIsValid(committedAt)) throw new Error('Invalid server clock');
      const key = `${prefix}ops/${body.operationId}/${committedAt}-${randomUUID()}.json`;
      const operation = { version: 1, operationId: body.operationId, changes, committedAt, hash };
      if (await isDeleted(prefix)) fail(410, 'record_deleted', '这份记录已删除，请生成新的保存码。');
      await store.setJSON(key, operation);
      if (await isDeleted(prefix)) {
        await store.delete(key);
        fail(410, 'record_deleted', '这份记录已删除，请生成新的保存码。');
      }
      const canonical = await earliestReceipt(prefix, body.operationId);
      if (canonical === null) throw new Error('Operation receipt missing after write');
      if (canonical.hash !== hash) fail(409, 'operation_conflict', '操作编号已用于不同修改，请重新读取记录。');
      return response(operationAck(canonical, canonical.receiptKey !== key));
    } catch (error) {
      if (error instanceof HttpError) return response({ error: error.code, message: error.message }, error.status);
      // Never return storage exception details, authorization headers, or codes.
      const categories = new Set(['CREDENTIAL_ERROR', 'COS_ERROR', 'MISSING_ENVIRONMENT', 'MISSING_PROJECT_ID', 'RATE_LIMITED', 'QUOTA_EXCEEDED']);
      const category = categories.has(error?.code) ? error.code : 'INTERNAL';
      const statusMatch = /(?:returned|credential:)\s+(\d{3})/.exec(error?.message || '');
      const codeMatch = /code=(\d+)/.exec(error?.message || '');
      return response({ error: 'storage_unavailable', message: '云端暂时无法确认记录，请保留本地足迹并稍后重试。', diagnostic: { category, stage, runtimeType: ['Error', 'TypeError', 'ReferenceError', 'SyntaxError'].includes(error?.name) ? error.name : 'Error', upstreamStatus: statusMatch ? Number(statusMatch[1]) : null, upstreamCode: codeMatch ? Number(codeMatch[1]) : null } }, 503);
    }
  };
}
