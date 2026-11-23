const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai-translator.js');

const reply = (lines) => ({ ok: true, text: JSON.stringify({ t: lines.map((l) => `中:${l}`) }) });
function fakeSend() {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    const { lines } = JSON.parse(payload.messages[1].content);
    return reply(lines);
  };
  return { calls, send };
}

test('buildBatch takes following unique undone lines with preceding context', () => {
  const s = ['a', 'b', 'c', 'b', 'd', 'e', 'f', 'g'];
  const b = ai.buildBatch(s, 'd', (t) => t === 'e', []);
  assert.deepEqual(b.lines, ['d', 'f', 'g']);
  assert.deepEqual(b.context, ['a', 'b', 'c', 'b']);
  assert.deepEqual(ai.buildBatch(s, 'b', () => false, []).lines, ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('batch sizes: small first batch, larger follow-up batches', () => {
  assert.equal(ai.FIRST_BATCH_SIZE, 8);
  assert.equal(ai.BATCH_SIZE, 20);
});

const many = Array.from({ length: 60 }, (_, i) => `s${i}`);

test('buildBatch on a fresh start or seek sends at most FIRST_BATCH_SIZE lines', () => {
  assert.deepEqual(ai.buildBatch(many, 's0', () => false, []).lines, many.slice(0, 8));
  // Seek: the line just before is neither done nor pending.
  const seek = ai.buildBatch(many, 's30', (t) => t === 's10', []);
  assert.deepEqual(seek.lines, many.slice(30, 38));
});

test('buildBatch continuing after a done line sends up to BATCH_SIZE lines', () => {
  const b = ai.buildBatch(many, 's8', (t) => Number(t.slice(1)) < 8, []);
  assert.deepEqual(b.lines, many.slice(8, 28));
  assert.deepEqual(b.context, many.slice(3, 8));
});

test('buildBatch for live captions sends one line with recent context', () => {
  const b = ai.buildBatch([], 'x', () => false, ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(b, { lines: ['x'], context: ['2', '3', '4', '5', '6'] });
});

test('parseBatchReply strips fences and checks count', () => {
  assert.deepEqual(ai.parseBatchReply('```json\n{"t":["甲","乙"]}\n```', 2), ['甲', '乙']);
  assert.throws(() => ai.parseBatchReply('{"t":["甲"]}', 2));
  assert.throws(() => ai.parseBatchReply('not json', 1));
});

test('one batch request serves following sentences', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a', 'b', 'c'], send });
  assert.equal(await t.translate('a', {}), '中:a');
  assert.equal(await t.translate('c', {}), '中:c');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'bce-ai');
  assert.equal(calls[0].tier, 'aiFree');
});

test('failure rejects with code from background', async () => {
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => [], send: async () => ({ ok: false, error: 'http-429' }) });
  await assert.rejects(t.translate('a', {}), (e) => e.code === 'http-429');
  const bad = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => [], send: async () => ({ ok: true, text: 'oops' }) });
  await assert.rejects(bad.translate('a', {}), (e) => e.code === 'bad-reply');
});

test('abort rejects the caller but keeps batch results', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'aiPro', getSentences: () => ['a', 'b'], send });
  const controller = new AbortController();
  const pending = t.translate('a', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(await t.translate('b', {}), '中:b');
  assert.equal(calls.length, 1);
});

test('translate after destroy rejects with AbortError', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a'], send });
  assert.equal(await t.translate('a', {}), '中:a');
  t.destroy();
  await assert.rejects(t.translate('a', {}), (e) => e.name === 'AbortError');
  assert.equal(calls.length, 1);
});

function deferredSend() {
  let settle;
  const gate = new Promise((resolve) => { settle = resolve; });
  return { send: async () => gate, settle };
}

test('in-flight call rejects with AbortError when destroyed, even if send then fails', async () => {
  const { send, settle } = deferredSend();
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a'], send });
  const pending = t.translate('a', {});
  t.destroy();
  settle({ ok: false, error: 'http-429' });
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('in-flight call rejects with AbortError when destroyed, even if send then succeeds', async () => {
  const { send, settle } = deferredSend();
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a'], send });
  const pending = t.translate('a', {});
  t.destroy();
  settle(reply(['a']));
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('aborted caller whose batch later fails leaves no unhandled rejection', async () => {
  const seen = [];
  const spy = (err) => seen.push(err);
  process.on('unhandledRejection', spy);
  try {
    const { send, settle } = deferredSend();
    const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a'], send });
    const controller = new AbortController();
    const pending = t.translate('a', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, (e) => e.name === 'AbortError');
    settle({ ok: false, error: 'http-500' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(seen, []);
  } finally {
    process.off('unhandledRejection', spy);
  }
});
