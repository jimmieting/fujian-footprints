/* Anonymous record keys stay in fragments/local storage; requests use Authorization. */
(() => {
  'use strict';
  const bridge = window.FujianFootprints;
  const API = '/api/fujian-record';
  const ACTIVE = 'fujian-cloud-active-v1';
  const PROFILE = 'fujian-cloud-profile-v1:';
  const OUTBOX = 'fujian-cloud-outbox-v1:';
  const CACHE = 'fujian-cloud-cache-v1:';
  const CODE_RE = /^FJ1-[A-Za-z0-9_-]{32}$/;
  const el = id => document.getElementById(id);
  const memory = new Map();
  const queuedClocks = new Map();
  let active = '', profile = null, busy = false, switching = false, failure = '', storageOkay = true;
  let state = 'local';
  const bar = document.querySelector('.record-bar');
  const localRead = key => { try { return localStorage.getItem(key); } catch { return null; } };
  function localWrite(key, value) {
    try { localStorage.setItem(key, value); return true; }
    catch { storageOkay = false; return false; }
  }
  function readJSON(key) { try { return JSON.parse(localRead(key) || 'null'); } catch { return null; } }
  function validVisited(ids) { return Array.isArray(ids) && ids.length <= 84 && ids.every(id => typeof id === 'string' && bridge.isValidId(id)); }
  function saveProfile(p) { return localWrite(PROFILE + p.code, JSON.stringify(p)); }
  function outbox(code) {
    const merged = new Map();
    const prefix = OUTBOX + code + ':';
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const op = readJSON(key);
        if (validOperation(op)) merged.set(op.operationId, op);
      }
    } catch { storageOkay = false; }
    for (const [key, op] of memory) if (key.startsWith(prefix)) merged.set(op.operationId, op);
    return [...merged.values()].sort((a, b) => a.queuedAt - b.queuedAt || a.operationId.localeCompare(b.operationId));
  }
  function validOperation(op) {
    return op && typeof op.operationId === 'string' && Array.isArray(op.changes) && op.changes.length <= 84 &&
      op.changes.every(c => bridge.isValidId(c.id) && typeof c.visited === 'boolean');
  }
  function enqueue(code, changes) {
    const queuedAt = Math.max(Date.now(), (queuedClocks.get(code) || 0) + 1, ...outbox(code).map(op => op.queuedAt + 1));
    queuedClocks.set(code, queuedAt);
    const op = { operationId: crypto.randomUUID(), queuedAt, changes };
    const key = OUTBOX + code + ':' + op.operationId;
    memory.set(key, op);
    localWrite(key, JSON.stringify(op));
  }
  function acknowledge(code, id) {
    const key = OUTBOX + code + ':' + id;
    memory.delete(key);
    try { localStorage.removeItem(key); } catch { storageOkay = false; }
  }
  function overlay(ids, operations) {
    const next = new Set(ids);
    for (const op of operations) for (const c of op.changes) c.visited ? next.add(c.id) : next.delete(c.id);
    return [...next];
  }
  function update(status = state, reason = failure) {
    state = status; failure = reason;
    bar.dataset.status = status;
    el('cloudManage').textContent = active ? '我的保存码' : '生成保存码';
    el('cloudManage').disabled = switching;
    el('cloudRestore').disabled = switching;
    el('cloudRetry').hidden = status !== 'error';
    let title = '让足迹跟着你走';
    let desc = '生成一个保存码，换浏览器或手机也能继续记录。';
    if (active) {
      const pending = outbox(active).length;
      if (status === 'syncing') { title = '正在同步足迹…'; desc = '修改先保留在本地，服务器确认后显示已同步。'; }
      else if (status === 'saved') { title = '足迹已同步到云端'; desc = '无需登录 · 保存好你的码，换设备也能恢复。'; }
      else if (status === 'error') { title = '云端尚未同步，请重试'; desc = reason || '本地记录仍保留；网络恢复后可重试。'; }
      else { title = pending ? '有修改等待同步' : '正在读取你的足迹'; desc = '保存码已保存在此浏览器。'; }
    }
    if (!storageOkay) desc += ' 本地存储不可用，请立即复制保存码并导出备份。';
    el('cloudTitle').textContent = title;
    el('cloudDescription').textContent = desc;
    el('recordSyncNote').textContent = active ? (status === 'saved' ? '当前足迹已由服务器确认保存。' : status === 'error' ? '尚未确认云端保存成功，请保留此码并重试同步。' : '正在同步，服务器确认前请保留本地备份。') : '';
  }
  async function api(code, method, body) {
    const response = await fetch(API, {
      method, headers: { Authorization: 'Bearer ' + code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, cache: 'no-store', credentials: 'omit',
      signal: AbortSignal.timeout(20000)
    });
    let data;
    try { data = await response.json(); } catch { throw new Error('服务器响应暂不可用，请稍后重试。'); }
    if (!response.ok) {
      const error = new Error(response.status === 404 ? '未找到这份记录。请检查保存码是否完整、大小写是否正确。' : data.message || '云端保存暂时不可用，请稍后重试。');
      error.status = response.status; throw error;
    }
    return data;
  }
  function verifyRecord(data) {
    if (data?.version !== 1 || !validVisited(data.visited)) throw new Error('返回的足迹记录无效，当前本地记录未被替换。');
    return data;
  }
  async function flush() {
    if (!active || busy || switching) return;
    const code = active, p = profile;
    busy = true; update('syncing', '');
    let succeeded = false;
    try {
      if (!p.created) {
        verifyRecord(await api(code, 'POST', { visited: p.initialVisited }));
        p.created = true; saveProfile(p);
      }
      while (active === code) {
        const next = outbox(code)[0];
        if (!next) break;
        const ack = await api(code, 'PATCH', { operationId: next.operationId, changes: next.changes });
        if (ack?.version !== 1 || ack.operationId !== next.operationId || !Number.isFinite(ack.committedAt)) throw new Error('保存结果待确认，请保留本地记录并重试。');
        acknowledge(code, next.operationId);
      }
      if (active === code) {
        const remote = verifyRecord(await api(code, 'GET'));
        if (active === code) {
          bridge.setRecord(overlay(remote.visited, outbox(code)), CACHE + code, false);
          p.lastSyncedAt = remote.updatedAt; saveProfile(p);
          succeeded = true;
          update(outbox(code).length ? 'syncing' : 'saved', '');
        }
      }
    } catch (error) {
      if (active === code) update('error', error.name === 'TimeoutError' || error.name === 'AbortError' ? '同步超时，结果待确认；本地修改保留，点击重试即可。' : error.message === 'Failed to fetch' ? '网络暂不可用，本地修改保留。恢复网络后请重试。' : error.message);
    } finally {
      busy = false;
      if (succeeded && active === code && outbox(code).length) queueMicrotask(flush);
      else if (active && active !== code) queueMicrotask(flush);
    }
  }
  function setActive(p, ids) {
    profile = p; active = p.code;
    saveProfile(p); localWrite(ACTIVE, active);
    bridge.setRecord(ids, CACHE + active);
    update('pending', '');
  }
  function newCode() {
    const bytes = crypto.getRandomValues(new Uint8Array(24));
    return 'FJ1-' + btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function showCode() {
    if (!active) {
      const ids = bridge.getVisited();
      const p = { code: newCode(), created: false, initialVisited: ids, version: 1 };
      setActive(p, ids);
      void flush();
    }
    el('recordCode').value = active;
    el('recordDialog').showModal();
  }
  function parseCode(raw) {
    const text = raw.trim();
    if (CODE_RE.test(text)) return text;
    try { const url = new URL(text); const code = new URLSearchParams(url.hash.slice(1)).get('code'); if (CODE_RE.test(code || '')) return code; } catch {}
    return '';
  }
  function showRestore(value = '') {
    el('restoreCode').value = value;
    el('restoreError').textContent = '';
    el('restoreDialog').showModal();
    el('restoreCode').focus();
  }
  async function restore(raw) {
    if (switching) return false;
    const code = parseCode(raw);
    if (!code) { el('restoreError').textContent = '请粘贴完整保存码（FJ1-开头，区分大小写）或专属链接。'; return false; }
    switching = true;
    el('restoreCode').disabled = true;
    el('confirmRestore').disabled = true;
    el('confirmRestore').textContent = '正在读取…';
    el('restoreError').textContent = '';
    update();
    try {
      const data = verifyRecord(await api(code, 'GET'));
      const old = readJSON(PROFILE + code);
      const p = old?.code === code ? old : { code, version: 1, initialVisited: data.visited };
      p.created = true;
      setActive(p, overlay(data.visited, outbox(code)));
      el('restoreDialog').close();
      bridge.message('已恢复这份足迹');
      return true;
    } catch (error) {
      el('restoreError').textContent = error.name === 'TimeoutError' ? '读取超时，当前足迹未切换，请重试。' : error.message;
      return false;
    } finally {
      switching = false; el('restoreCode').disabled = false; el('confirmRestore').disabled = false; el('confirmRestore').textContent = '恢复这份足迹';
      update(); if (active) void flush();
    }
  }
  function link() { return location.origin + location.pathname + '#code=' + encodeURIComponent(active); }
  async function copy(text, label) {
    try { await navigator.clipboard.writeText(text); bridge.message(label + '已复制'); }
    catch { el('recordCode').focus(); el('recordCode').select(); bridge.message('复制受限，请长按或手动复制保存码。'); }
  }
  el('cloudManage').onclick = showCode;
  el('cloudRestore').onclick = () => showRestore();
  el('cloudRetry').onclick = () => void flush();
  el('closeRecordDialog').onclick = () => el('recordDialog').close();
  el('closeRestoreDialog').onclick = () => el('restoreDialog').close();
  el('confirmRestore').onclick = () => void restore(el('restoreCode').value);
  el('restoreCode').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); void restore(e.target.value); } });
  el('copyRecordCode').onclick = () => void copy(active, '保存码');
  el('copyRecordLink').onclick = () => void copy(link(), '专属链接');
  el('downloadRecordCode').onclick = () => {
    const url = URL.createObjectURL(new Blob(['福建足迹保存码\n\n' + active + '\n\n专属链接：\n' + link() + '\n\n拿到此码的人可以查看和修改足迹，请妥善保存。\n'], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = '福建足迹保存码.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  window.addEventListener('fujian:change', e => {
    if (!active || !validOperation({ operationId: 'local', changes: e.detail?.changes })) return;
    enqueue(active, e.detail.changes); update('pending', ''); void flush();
  });
  window.addEventListener('online', () => void flush());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void flush(); });
  window.addEventListener('storage', e => {
    if (active && (e.key?.startsWith(OUTBOX + active + ':') || e.key === CACHE + active)) {
      if (!busy && !switching) void flush();
    }
  });
  window.FujianCloud = { get active() { return !!active; } };
  const savedCode = localRead(ACTIVE);
  if (CODE_RE.test(savedCode || '')) {
    const stored = readJSON(PROFILE + savedCode);
    if (stored?.code === savedCode && validVisited(stored.initialVisited)) {
      const cached = readJSON(CACHE + savedCode);
      setActive(stored, overlay(validVisited(cached?.visited) ? cached.visited : stored.initialVisited, outbox(savedCode)));
    }
  }
  let fragmentCode = '';
  try { fragmentCode = new URLSearchParams(location.hash.slice(1)).get('code') || ''; } catch {}
  if (fragmentCode) {
    window.history.replaceState(null, '', location.pathname + location.search);
    if (CODE_RE.test(fragmentCode)) {
      if (!active || active === fragmentCode) { showRestore(fragmentCode); void restore(fragmentCode); }
      else showRestore(fragmentCode);
    } else { showRestore(); el('restoreError').textContent = '链接中的保存码不完整，请重新复制。'; }
  } else { update(); if (active) void flush(); }
})();
