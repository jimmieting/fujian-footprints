import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRecordHandler } from '../cloud-functions/_lib/fujian-record-core.js';

const URL = 'https://jimmie.cn/api/fujian-record';
const makeCode = () => `FJ1-${randomBytes(24).toString('base64url')}`;

class MemoryStore {
  values = new Map();
  async get(key, options) {
    assert.equal(options.consistency, 'strong');
    assert.equal(options.type, 'json');
    return this.values.has(key) ? structuredClone(this.values.get(key)) : null;
  }
  async setJSON(key, value) { this.values.set(key, structuredClone(value)); }
  async list(options) {
    assert.equal(options.consistency, 'strong');
    return { blobs: [...this.values.keys()].filter(key => key.startsWith(options.prefix)).map(key => ({ key, etag: 'test' })) };
  }
  async delete(key) { this.values.delete(key); }
}

function setup(options = {}) {
  const store = new MemoryStore();
  let clock = 1800000000000;
  const handler = createRecordHandler({ store, now: () => ++clock, ...options });
  const send = async (method, code, body, extra = {}) => {
    const headers = new Headers(extra.headers);
    if (code !== null) headers.set('Authorization', `Bearer ${code}`);
    if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await handler(new Request(extra.url || URL, { method, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }));
    const text = await response.text();
    return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
  };
  return { store, handler, send };
}

test('creation is idempotent and only stores a namespaced hash of the code', async () => {
  const { store, send } = setup();
  const code = makeCode();
  const first = await send('POST', code, { visited: ['350527', '350102'] });
  assert.equal(first.status, 201);
  assert.equal(first.data.created, true);
  assert.deepEqual(first.data.visited, ['350102', '350527']);
  const retry = await send('POST', code, { visited: ['350128'] });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.created, false);
  assert.deepEqual(retry.data.visited, first.data.visited);
  assert.equal(retry.data.updatedAt, first.data.updatedAt);
  assert.equal(store.values.size, 1);
  for (const [key, value] of store.values) {
    assert.match(key, /^records\/[0-9a-f]{64}\/meta\.json$/);
    assert(!key.includes(code));
    assert(!JSON.stringify(value).includes(code));
  }
  assert.equal(first.headers.get('cache-control'), 'no-store');
});

test('tokens are isolated and neither missing auth nor another code can list records', async () => {
  const { send } = setup();
  const code = makeCode(), other = makeCode();
  await send('POST', code, { visited: ['350128'] });
  assert.equal((await send('GET', null)).status, 401);
  assert.equal((await send('GET', other)).status, 404);
  assert.equal((await send('PATCH', other, { operationId: randomUUID(), changes: [{ id: '350527', visited: true }] })).status, 404);
  await send('POST', other, { visited: ['350527'] });
  assert.deepEqual((await send('GET', code)).data.visited, ['350128']);
  assert.deepEqual((await send('GET', other)).data.visited, ['350527']);
});

test('operation retries confirm the original commit and content reuse is rejected', async () => {
  const { store, send } = setup();
  const code = makeCode(), operationId = randomUUID();
  await send('POST', code, { visited: [] });
  const first = await send('PATCH', code, { operationId, changes: [{ id: '350128', visited: true }, { id: '350527', visited: true }] });
  const retry = await send('PATCH', code, { operationId, changes: [{ id: '350527', visited: true }, { id: '350128', visited: true }] });
  assert.equal(first.status, 200);
  assert.equal(first.data.duplicate, false);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.duplicate, true);
  assert.equal(retry.data.committedAt, first.data.committedAt);
  assert.equal(store.values.size, 2);
  assert.equal((await send('PATCH', code, { operationId, changes: [{ id: '350128', visited: false }] })).status, 409);
  assert.deepEqual((await send('GET', code)).data.visited, ['350128', '350527']);
});

test('concurrent devices editing different counties merge instead of overwriting snapshots', async () => {
  const { send } = setup();
  const code = makeCode();
  await send('POST', code, { visited: ['350102'] });
  const responses = await Promise.all([
    send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350128', visited: true }] }),
    send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350527', visited: true }] }),
    send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350102', visited: false }] }),
  ]);
  assert(responses.every(response => response.status === 200));
  assert.deepEqual((await send('GET', code)).data.visited, ['350128', '350527']);
});

test('a concurrent duplicate delayed until after undo cannot move the old edit after undo', async () => {
  const { store, send } = setup();
  const code = makeCode();
  await send('POST', code, { visited: [] });
  const operation = { operationId: randomUUID(), changes: [{ id: '350128', visited: true }] };
  let resume, reached;
  const blocked = new Promise(resolve => { resume = resolve; });
  const atCapacityRead = new Promise(resolve => { reached = resolve; });
  let pauseNextCapacityRead = true;
  const originalList = store.list.bind(store);
  store.list = async options => {
    const snapshot = await originalList(options);
    // The late duplicate has already observed no receipt for this UUID, but has
    // not allocated its server timestamp or written anything yet.
    if (pauseNextCapacityRead && options.prefix.endsWith('/ops/')) {
      pauseNextCapacityRead = false;
      reached();
      await blocked;
    }
    return snapshot;
  };

  const lateDuplicate = send('PATCH', code, operation);
  await atCapacityRead;
  const first = await send('PATCH', code, operation);
  assert.equal(first.status, 200);
  const undo = await send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350128', visited: false }] });
  assert.equal(undo.status, 200);
  assert.deepEqual((await send('GET', code)).data.visited, []);
  resume();
  const late = await lateDuplicate;
  assert.equal(late.status, 200);
  assert.equal(late.data.duplicate, true);
  assert.equal(late.data.committedAt, first.data.committedAt);
  assert.deepEqual((await send('GET', code)).data.visited, []);
  const receipts = [...store.values.keys()].filter(key => key.includes(`/ops/${operation.operationId}/`));
  assert.equal(receipts.length, 2);
  assert(receipts.every(key => /\/\d+-[0-9a-f-]{36}\.json$/.test(key)));
});

test('same county uses the latest server commit and deterministic UUID ties', async () => {
  const { send } = setup();
  const code = makeCode();
  await send('POST', code, { visited: [] });
  await send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350128', visited: true }] });
  await send('PATCH', code, { operationId: randomUUID(), changes: [{ id: '350128', visited: false }] });
  assert.deepEqual((await send('GET', code)).data.visited, []);

  const tied = setup({ now: () => 1800000000000 });
  const tieCode = makeCode();
  await tied.send('POST', tieCode, { visited: [] });
  await Promise.all([
    tied.send('PATCH', tieCode, { operationId: '00000000-0000-4000-8000-000000000002', changes: [{ id: '350128', visited: false }] }),
    tied.send('PATCH', tieCode, { operationId: '00000000-0000-4000-8000-000000000001', changes: [{ id: '350128', visited: true }] }),
  ]);
  assert.deepEqual((await tied.send('GET', tieCode)).data.visited, []);
});

test('strict schemas reject arbitrary data, old district codes, and oversized bodies', async () => {
  const { send } = setup();
  const code = makeCode();
  for (const body of [null, [], {}, { visited: [], code }, { visited: ['350403'] }, { visited: [350128] }, { visited: ['350128', '350128'] }]) {
    assert.equal((await send('POST', code, body)).status, 400);
  }
  assert.equal((await send('POST', code, '{')).status, 400);
  assert.equal((await send('POST', code, { visited: [] }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await send('POST', code, ' '.repeat(8193))).status, 413);
  await send('POST', code, { visited: [] });
  const id = randomUUID();
  for (const body of [
    { operationId: '../../secret', changes: [{ id: '350128', visited: true }] },
    { operationId: id, changes: [] },
    { operationId: id, changes: [{ id: '350128', visited: 1 }] },
    { operationId: id, changes: [{ id: '350128', visited: true, extra: 1 }] },
    { operationId: id, changes: [{ id: '350128', visited: true }, { id: '350128', visited: false }] },
    { operationId: id, changes: [{ id: '350128', visited: true }], visited: [] },
  ]) assert.equal((await send('PATCH', code, body)).status, 400);
  assert.deepEqual((await send('GET', code)).data.visited, []);
});

test('Origin validation, credential placement and method restrictions are enforced', async () => {
  const { send } = setup();
  const code = makeCode();
  assert.equal((await send('POST', code, { visited: [] }, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const preflight = await send('OPTIONS', null, undefined, { headers: { Origin: 'https://jimmie.cn' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://jimmie.cn');
  assert(!preflight.headers.has('access-control-allow-credentials'));
  assert.equal((await send('GET', code, undefined, { url: `${URL}?code=${code}` })).status, 400);
  assert.equal((await send('PUT', code, { visited: [] })).status, 405);
  assert.equal((await send('GET', 'FJ1-short')).status, 401);
  assert.equal((await send('POST', code, { visited: [] }, { headers: { Origin: 'https://jimmie.cn' } })).status, 201);
  assert.equal((await send('GET', code, undefined, { url: 'https://fork.example/api/fujian-record', headers: { Origin: 'https://jimmie.cn' } })).status, 403);
  assert.equal((await send('POST', makeCode(), { visited: [] }, { url: 'https://fork.example/api/fujian-record', headers: { Origin: 'https://fork.example' } })).status, 201);
});

test('capacity guard does not prevent acknowledgment of an already-saved retry', async () => {
  const { send } = setup({ maxOperations: 1 });
  const code = makeCode(), operation = { operationId: randomUUID(), changes: [{ id: '350128', visited: true }] };
  await send('POST', code, { visited: [] });
  assert.equal((await send('PATCH', code, operation)).status, 200);
  assert.equal((await send('PATCH', code, operation)).data.duplicate, true);
  assert.equal((await send('PATCH', code, { ...operation, operationId: randomUUID() })).status, 507);
  assert.deepEqual((await send('GET', code)).data.visited, ['350128']);
});

test('authorized deletion removes footmarks, isolates other tokens and revokes late retries', async () => {
  const { store, send } = setup();
  const code = makeCode(), other = makeCode();
  await send('POST', code, { visited: ['350128'] });
  const operation = { operationId: randomUUID(), changes: [{ id: '350527', visited: true }] };
  await send('PATCH', code, operation);
  await send('POST', other, { visited: ['350102'] });
  assert.equal((await send('DELETE', code)).status, 200);
  assert.equal((await send('GET', code)).status, 410);
  assert.equal((await send('POST', code, { visited: [] })).status, 410);
  assert.equal((await send('PATCH', code, operation)).status, 410);
  assert.deepEqual((await send('GET', other)).data.visited, ['350102']);
  assert.equal([...store.values.keys()].filter(key => key.endsWith('deleted.json')).length, 1);
  assert.equal(store.values.size, 2);
});

test('storage failures are explicitly uncertain and never disclose credentials or adapter details', async () => {
  const code = makeCode();
  const store = new MemoryStore();
  store.get = async () => { throw new Error(`private SDK failure ${code}`); };
  const handler = createRecordHandler({ store });
  const response = await handler(new Request(URL, { headers: { Authorization: `Bearer ${code}` } }));
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.match(text, /暂时无法确认/);
  assert(!text.includes(code));
  assert(!text.includes('private SDK'));
});

test('Makers buffered and pre-parsed Node request bodies obey the same schema and byte cap', async () => {
 const store=new MemoryStore(); const handler=createRecordHandler({store});
 const code=makeCode(); const headers=new Headers({'authorization':'Bearer '+code,'content-type':'application/json'});
 const nodeRequest=body=>({url:'https://jimmie.cn/api/fujian-record',method:'POST',headers,body});
 assert.equal((await handler(nodeRequest(Buffer.from(JSON.stringify({visited:['350128']}))))).status,201);
 const otherHeaders=new Headers(headers);otherHeaders.set('authorization','Bearer '+makeCode());
 assert.equal((await handler({...nodeRequest({visited:['350527']}),headers:otherHeaders})).status,201);
 assert.equal((await handler(nodeRequest(Buffer.from('x'.repeat(9000))))).status,413);
 assert.equal((await handler(nodeRequest(Buffer.from('{bad json')))).status,400);
});
