const test = require('node:test');
const assert = require('node:assert/strict');
const store = require('../translation-store.js');
const ai = require('../ai-translator.js');

// The translations a load returns (caption -> chinese).
const saved = async (s, ...args) => (await s.load(...args)).translations;

// In-memory stand-in for chrome.storage.local (values are copied like JSON).
function fakeArea(initial = {}) {
  const data = structuredClone(initial);
  const writes = [];
  const copy = (v) => (v === undefined ? v : structuredClone(v));
  return {
    data,
    writes,
    async get(keys) {
      if (keys === null) return copy(data);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => Object.hasOwn(data, k)).map((k) => [k, copy(data[k])]));
    },
    async set(items) {
      writes.push(Object.keys(items));
      Object.assign(data, copy(items));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    },
  };
}

// Timers that only fire when the test says so.
function manualTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn) => { pending.set(next, fn); return next++; },
    clearTimer: (id) => pending.delete(id),
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      fns.forEach((fn) => fn());
    },
    get size() { return pending.size; },
  };
}

function makeStore(area, options = {}) {
  let clock = 1000;
  const timers = manualTimers();
  const s = store.createTranslationStore({ area, now: () => clock++, ...timers, ...options });
  return { s, timers };
}

test('save then load returns the same lines for that video and model only', async () => {
  const area = fakeArea();
  const { s } = makeStore(area);
  s.save('vid1', 'openrouter/m', 'Hello.', '你好。');
  s.save('vid1', 'openrouter/m', 'Bye.', '再見。');
  await s.flush();
  assert.deepEqual([...await saved(s, 'vid1', 'openrouter/m')], [['Hello.', '你好。'], ['Bye.', '再見。']]);
  assert.equal((await saved(s, 'vid1', 'openrouter/other')).size, 0);
  assert.equal((await saved(s, 'vid2', 'openrouter/m')).size, 0);
});

test('a burst of saves is written once, after the delay', async () => {
  const area = fakeArea();
  const { s, timers } = makeStore(area);
  for (let i = 0; i < 20; i++) s.save('v', 'm', `line ${i}`, `第 ${i} 句`);
  assert.equal(area.writes.length, 0);
  assert.equal(timers.size, 1);
  timers.fire();
  await s.flush();
  assert.equal(area.writes.length, 1);
  assert.equal((await saved(s, 'v', 'm')).size, 20);
});

test('later saves merge into the stored record instead of replacing it', async () => {
  const area = fakeArea();
  const { s } = makeStore(area);
  s.save('v', 'm', 'a', '甲');
  await s.flush();
  s.save('v', 'm', 'b', '乙');
  s.save('v', 'm', 'a', '甲２');
  await s.flush();
  assert.deepEqual(Object.fromEntries(await saved(s, 'v', 'm')), { a: '甲２', b: '乙' });
});

test('caption text that looks like an object key survives', async () => {
  const area = fakeArea();
  const { s } = makeStore(area);
  s.save('v', 'm', '__proto__', '原型');
  s.save('v', 'm', 'constructor', '建構子');
  await s.flush();
  assert.deepEqual(Object.fromEntries(await saved(s, 'v', 'm')), { ['__proto__']: '原型', constructor: '建構子' });
});

test('empty or non-string translations are not saved', async () => {
  const area = fakeArea();
  const { s } = makeStore(area);
  s.save('v', 'm', 'a', '  ');
  s.save('v', 'm', '', '空');
  s.save('v', 'm', 'b', undefined);
  s.save(undefined, 'm', 'c', '丙');
  await s.flush();
  assert.equal(area.writes.length, 0);
});

test('malformed stored records load as empty or skip bad pairs', async () => {
  const key = store.recordKey('v', 'm');
  const area = fakeArea({ [key]: { lines: [['ok', '好'], ['bad'], [1, 2], 'x', ['blank', ' ']] } });
  const { s } = makeStore(area);
  assert.deepEqual([...await saved(s, 'v', 'm')], [['ok', '好']]);
  area.data[key] = 'garbage';
  assert.equal((await saved(s, 'v', 'm')).size, 0);
});

test('records past the limit are removed, oldest first; loading counts as use', async () => {
  const area = fakeArea();
  const { s, timers } = makeStore(area, { maxRecords: 2 });
  s.save('old', 'm', 'a', '甲');
  await s.flush();
  s.save('mid', 'm', 'a', '甲');
  await s.flush();
  // Rewatching "old" makes it newer than "mid".
  assert.equal((await saved(s, 'old', 'm')).size, 1);
  timers.fire();
  await s.flush();
  s.save('new', 'm', 'a', '甲');
  await s.flush();
  assert.equal((await saved(s, 'mid', 'm')).size, 0);
  assert.equal((await saved(s, 'old', 'm')).size, 1);
  assert.equal((await saved(s, 'new', 'm')).size, 1);
  assert.deepEqual(Object.keys(area.data[store.INDEX_KEY]).sort(),
    [store.recordKey('new', 'm'), store.recordKey('old', 'm')].sort());
});

test('storage failures never reject', async () => {
  const broken = {
    get: () => { throw new Error('Extension context invalidated.'); },
    set: async () => { throw new Error('QUOTA_BYTES quota exceeded'); },
    remove: async () => {},
  };
  const { s } = makeStore(broken);
  assert.equal((await saved(s, 'v', 'm')).size, 0);
  const warn = console.warn;
  console.warn = () => {};
  try {
    s.save('v', 'm', 'a', '甲');
    await s.flush();
  } finally {
    console.warn = warn;
  }
});

test('summarize and clearAll cover every version but leave other settings', async () => {
  const area = fakeArea({
    bceSettings: { tier: 'ai' },
    // Saved by an older version of the store.
    'bceTx0:old|m': { lines: [['x', '舊']] },
  });
  const { s } = makeStore(area);
  s.save('v1', 'a/m', 'a', '甲');
  s.save('v1', 'b/m', 'a', '甲');
  s.save('v2', 'a/m', 'b', '乙');
  await s.flush();
  assert.deepEqual(await store.summarize(area), { records: 4, videos: 3, lines: 4 });
  assert.equal(await store.clearAll(area), 5);
  assert.deepEqual(Object.keys(area.data), ['bceSettings']);
});

test('a seeded AI translator answers saved lines without sending them', async () => {
  const calls = [];
  const send = async (payload) => {
    const { lines } = JSON.parse(payload.messages[1].content);
    calls.push(lines);
    return { ok: true, text: JSON.stringify({ t: lines.map((l) => `中:${l}`) }) };
  };
  const sentences = ['a', 'b', 'c', 'd'];
  const heard = [];
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => sentences, send,
    seed: new Map([['a', '甲'], ['c', '丙']]),
    onResult: (text, result) => heard.push([text, result]),
  });
  assert.equal(await t.translate('a'), '甲');
  assert.equal(calls.length, 0);
  assert.equal(await t.translate('b'), '中:b');
  assert.deepEqual(calls, [['b', 'd']]);
  assert.deepEqual(heard, [['b', '中:b'], ['d', '中:d']]);
});

test('a throwing onResult does not lose the translation', async () => {
  const send = async (payload) => {
    const { lines } = JSON.parse(payload.messages[1].content);
    return { ok: true, text: JSON.stringify({ t: lines.map((l) => `中:${l}`) }) };
  };
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => ['a'], send, onResult: () => { throw new Error('boom'); },
  });
  assert.equal(await t.translate('a'), '中:a');
});

test('a corrected caption is saved and loaded with its translation', async () => {
  const area = fakeArea();
  const { s } = makeStore(area);
  s.save('v', 'm', 'so today we', '所以今天我們', 'So today, we');
  s.save('v', 'm', 'next one', '下一個');
  await s.flush();
  const { translations, sources } = await s.load('v', 'm');
  assert.deepEqual([...translations], [['so today we', '所以今天我們'], ['next one', '下一個']]);
  assert.deepEqual([...sources], [['so today we', 'So today, we']]);
  assert.deepEqual(area.data[store.recordKey('v', 'm')].lines,
    [['so today we', '所以今天我們', 'So today, we'], ['next one', '下一個']]);
});

test('records from before version 2 are not loaded', async () => {
  assert.equal(store.VERSION, 2);
  const area = fakeArea({ 'bceTx1:v|m': { at: 1, lines: [['a', '甲']] } });
  const { s } = makeStore(area);
  assert.equal((await saved(s, 'v', 'm')).size, 0);
});
