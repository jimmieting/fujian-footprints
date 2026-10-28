import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createRecordHandler } from '../cloud-functions/_lib/fujian-record-core.js';

const source = readFileSync(new URL('../fujian/cloud-sync.js', import.meta.url), 'utf8');
const ACTIVE = 'fujian-cloud-active-v1';
const OUTBOX = 'fujian-cloud-outbox-v1:';
const CODE_B = 'FJ1-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CODE_C = 'FJ1-CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const validIds = new Set(['350102', '350103', '350104', '350128', '350527']);
class Storage {
  data = new Map();
  get length() { return this.data.size; }
  key(i) { return [...this.data.keys()][i] ?? null; }
  getItem(k) { return this.data.get(k) ?? null; }
  setItem(k, v) { this.data.set(k, String(v)); }
  removeItem(k) { this.data.delete(k); }
}
class Target {
  listeners = new Map();
  addEventListener(type, callback) { const list = this.listeners.get(type) || []; list.push(callback); this.listeners.set(type, list); }
  dispatchEvent(event) { event.target ??= this; for (const fn of this.listeners.get(event.type) || []) fn(event); }
}
class Element extends Target {
  value = ''; textContent = ''; disabled = false; hidden = false; open = false; dataset = {};
  showModal() { this.open = true; }
  close() { this.open = false; }
  focus() {}
  select() {}
}
function service() {
  const data = new Map();
  const store = {
    async get(k) { return data.has(k) ? structuredClone(data.get(k)) : null; },
    async setJSON(k, v) { data.set(k, structuredClone(v)); },
    async list({ prefix }) { return { blobs: [...data.keys()].filter(k => k.startsWith(prefix)).map(key => ({ key })) }; },
    async delete(k) { data.delete(k); },
  };
  let serverClock = Date.now();
  const handler = createRecordHandler({ store, now: () => serverClock++ });
  const send = (code, method, body) => handler(new Request('https://jimmie.cn/api/fujian-record', {
    method, headers: { Authorization: 'Bearer ' + code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  }));
  return { send };
}
function harness({ storage = new Storage(), remote = service(), initial = [], intercept, cryptoImpl = webcrypto, dateImpl = Date } = {}) {
  const elements = new Map(), window = new Target(), document = new Target(), calls = [], assignments = [], messages = [];
  let visited = new Set(initial);
  const element = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const bridge = {
    getVisited: () => [...visited],
    isValidId: id => validIds.has(String(id)),
    setRecord(ids, key, resetHistory) {
      visited = new Set(ids); assignments.push({ ids: [...ids], key, resetHistory });
      storage.setItem(key, JSON.stringify({ visited: ids }));
    },
    message(text) { messages.push(text); },
  };
  window.FujianFootprints = bridge; window.history = { replaceState() {} };
  document.hidden = false; document.getElementById = element; document.querySelector = () => element('bar');
  const fetch = async (url, init) => {
    const code = init.headers.Authorization.slice(7);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url, code, method: init.method, body, init }; calls.push(call);
    const next = () => remote.send(code, init.method, body);
    return intercept ? intercept(call, next) : next();
  };
  vm.runInNewContext(source, {
    window, document, localStorage: storage, crypto: cryptoImpl, fetch,
    navigator: { clipboard: { async writeText() {} } },
    location: { origin: 'https://jimmie.cn', pathname: '/fujian/', search: '', hash: '' },
    URL, URLSearchParams, Blob, AbortSignal, btoa, Date: dateImpl, setTimeout, queueMicrotask,
  }, { filename: 'cloud-sync.js' });
  return {
    element, window, storage, remote, calls, assignments, messages,
    get visited() { return [...visited].sort(); },
    get code() { return storage.getItem(ACTIVE); },
    pending() { return [...storage.data.keys()].filter(k => k.startsWith(OUTBOX)); },
    click(id) { return element(id).onclick?.(); },
    change(changes) {
      for (const c of changes) c.visited ? visited.add(c.id) : visited.delete(c.id);
      window.dispatchEvent({ type: 'fujian:change', detail: { changes } });
    },
    beginRestore(code) { element('restoreCode').value = code; element('confirmRestore').onclick(); },
  };
}
async function until(predicate, label = 'condition') {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Timed out: ' + label);
}
const saved = h => until(() => h.element('cloudTitle').textContent === '足迹已同步到云端', 'saved');
async function create(h) { h.click('cloudManage'); await saved(h); return h.code; }
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

test('random recovery code creates a record and credentials stay out of URLs and cookies', async () => {
  const h = harness({ initial: ['350128'] });
  const code = await create(h);
  assert.match(code, /^FJ1-[A-Za-z0-9_-]{32}$/);
  const record = await (await h.remote.send(code, 'GET')).json();
  assert.deepEqual(record.visited, ['350128']);
  assert(h.calls.every(c => c.url === '/api/fujian-record' && c.init.credentials === 'omit' && c.init.cache === 'no-store'));
  h.change([{ id: '350527', visited: true }]); await saved(h);
  assert.deepEqual(h.visited, ['350128', '350527']);
  assert.equal(h.pending().length, 0);
  assert.equal(h.assignments.at(-1).resetHistory, false, 'ordinary sync preserves undo history');
});

test('failed save survives refresh in an individual outbox entry and later syncs', async () => {
  let offline = false;
  const remote = service();
  const h = harness({ remote, intercept: (c, next) => { if (offline && c.method === 'PATCH') throw new TypeError('Failed to fetch'); return next(); } });
  const code = await create(h); offline = true;
  h.change([{ id: '350128', visited: true }]);
  await until(() => h.element('bar').dataset.status === 'error');
  assert.equal(h.pending().length, 1); assert.deepEqual(h.visited, ['350128']);
  const reloaded = harness({ storage: h.storage, remote });
  await saved(reloaded);
  assert.equal(reloaded.code, code); assert.deepEqual(reloaded.visited, ['350128']); assert.equal(reloaded.pending().length, 0);
});

test('response loss retries the same operation identifier rather than inventing another edit', async () => {
  let loseOnce = true;
  const h = harness({ intercept: async (c, next) => {
    const response = await next();
    if (c.method === 'PATCH' && loseOnce) { loseOnce = false; throw new TypeError('Failed to fetch'); }
    return response;
  } });
  await create(h); h.change([{ id: '350527', visited: true }]);
  await until(() => h.element('bar').dataset.status === 'error');
  assert.equal(h.pending().length, 1);
  h.click('cloudRetry'); await saved(h);
  const patches = h.calls.filter(c => c.method === 'PATCH');
  assert.equal(patches.length, 2); assert.equal(patches[0].body.operationId, patches[1].body.operationId);
  assert.deepEqual(h.visited, ['350527']); assert.equal(h.pending().length, 0);
});

test('an older in-flight GET overlays new local edits and drains the next operation', async () => {
  const gate = deferred(); let hold = false, held = false;
  const h = harness({ intercept: async (c, next) => {
    const response = await next();
    if (hold && c.method === 'GET' && !held) { held = true; await gate.promise; }
    return response;
  } });
  await create(h); hold = true;
  h.change([{ id: '350128', visited: true }]); await until(() => held);
  const marker = h.assignments.length;
  h.change([{ id: '350527', visited: true }]); gate.resolve(); await saved(h);
  assert.deepEqual(h.visited, ['350128', '350527']);
  assert(h.assignments.slice(marker).every(a => a.ids.includes('350527')), 'stale GET never erases the pending edit');
  assert.equal(h.pending().length, 0);
});

test('a nonexistent recovery code leaves the active code and visited places intact', async () => {
  const h = harness({ initial: ['350102'] }); const code = await create(h);
  h.beginRestore(CODE_B);
  await until(() => h.element('restoreError').textContent.includes('未找到'));
  assert.equal(h.code, code); assert.deepEqual(h.visited, ['350102']);
});

test('a slow sync from the previous code cannot overwrite a newly recovered record', async () => {
  const gate = deferred(); let holdCode = '', held = false;
  const remote = service();
  await remote.send(CODE_B, 'POST', { visited: ['350527'] });
  const h = harness({ remote, initial: ['350102'], intercept: async (c, next) => {
    const response = await next();
    if (c.code === holdCode && c.method === 'GET' && !held) { held = true; await gate.promise; }
    return response;
  } });
  const oldCode = await create(h); holdCode = oldCode;
  h.window.dispatchEvent({ type: 'online' }); await until(() => held);
  h.beginRestore(CODE_B); await until(() => h.code === CODE_B);
  const marker = h.assignments.length; gate.resolve(); await saved(h);
  assert.deepEqual(h.visited, ['350527']);
  assert(h.assignments.slice(marker).every(a => a.key.endsWith(CODE_B)), 'late old-code response is ignored');
});

test('repeated Enter while recovery is pending does not start competing restores', async () => {
  const gate = deferred(); let hold = false;
  const remote = service(); await remote.send(CODE_B, 'POST', { visited: ['350128'] }); await remote.send(CODE_C, 'POST', { visited: ['350527'] });
  const h = harness({ remote, intercept: async (c, next) => { const r = await next(); if (hold && c.code === CODE_B && c.method === 'GET') await gate.promise; return r; } });
  await create(h); hold = true; h.beginRestore(CODE_B);
  assert.equal(h.element('restoreCode').disabled, true);
  h.element('restoreCode').value = CODE_C;
  h.element('restoreCode').dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.filter(c => c.code === CODE_C).length, 0);
  gate.resolve(); await until(() => h.code === CODE_B); await saved(h);
  assert.deepEqual(h.visited, ['350128']);
});


test('same-millisecond edits retain causal order while initial creation is in flight', async () => {
  const gate = deferred(); let held = false;
  const ids = ['ffffffff-ffff-4fff-bfff-ffffffffffff', '00000000-0000-4000-8000-000000000001'];
  class FixedDate extends Date { static now() { return 1000; } }
  const h = harness({
    dateImpl: FixedDate,
    cryptoImpl: { getRandomValues: webcrypto.getRandomValues.bind(webcrypto), randomUUID: () => ids.shift() },
    intercept: async (c, next) => { const response = await next(); if (c.method === 'POST') { held = true; await gate.promise; } return response; },
  });
  h.click('cloudManage'); await until(() => held);
  h.change([{ id: '350128', visited: true }]);
  h.change([{ id: '350128', visited: false }]);
  gate.resolve(); await saved(h);
  assert.deepEqual(h.calls.filter(c => c.method === 'PATCH').map(c => c.body.changes[0].visited), [true, false]);
  assert.deepEqual(h.visited, [], 'the later cancellation must win');
});
