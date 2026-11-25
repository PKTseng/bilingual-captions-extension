const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai-translator.js');

const noWait = async () => {};
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
  assert.deepEqual(ai.parseBatchReply('```json\n{"t":["甲","乙"]}\n```', 2), { t: ['甲', '乙'], s: undefined });
  assert.throws(() => ai.parseBatchReply('{"t":["甲"]}', 2));
  assert.throws(() => ai.parseBatchReply('not json', 1));
});

test('parseBatchReply rejects blank translations', () => {
  assert.throws(() => ai.parseBatchReply('{"t":["第一句","  "]}', 2));
});

test('one batch request serves following sentences', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a', 'b', 'c'], send });
  assert.equal(await t.translate('a', {}), '中:a');
  assert.equal(await t.translate('c', {}), '中:c');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'bce-ai');
  assert.equal(calls[0].tier, 'ai');
});

test('failure rejects with code from background', async () => {
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => [], send: async () => ({ ok: false, error: 'http-429' }) });
  await assert.rejects(t.translate('a', {}), (e) => e.code === 'http-429');
  const bad = ai.createAiTranslator({ tier: 'ai', getSentences: () => [], send: async () => ({ ok: true, text: 'oops' }), wait: noWait });
  await assert.rejects(bad.translate('a', {}), (e) => e.code === 'bad-reply');
});

test('abort rejects the caller but keeps batch results', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a', 'b'], send });
  const controller = new AbortController();
  const pending = t.translate('a', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(await t.translate('b', {}), '中:b');
  assert.equal(calls.length, 1);
});

test('translate after destroy rejects with AbortError', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a'], send });
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
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a'], send });
  const pending = t.translate('a', {});
  t.destroy();
  settle({ ok: false, error: 'http-429' });
  await assert.rejects(pending, (e) => e.name === 'AbortError');
});

test('in-flight call rejects with AbortError when destroyed, even if send then succeeds', async () => {
  const { send, settle } = deferredSend();
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a'], send });
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
    const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a'], send, wait: noWait });
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

// ---- Long videos: one bad batch must not lose the rest of the video ----

const linesOf = (payload) => JSON.parse(payload.messages[1].content).lines;

test('isTransientError separates retryable failures from fatal ones', () => {
  for (const code of ['timeout', 'network', 'rate-limit', 'bad-reply', 'http-500', 'http-503', 'http-408']) {
    assert.equal(ai.isTransientError(code), true, code);
  }
  for (const code of ['no-key', 'bad-key', 'credits', 'send-failed', 'http-400', 'http-404', undefined]) {
    assert.equal(ai.isTransientError(code), false, String(code));
  }
});

test('a rate-limited batch is retried after a pause', async () => {
  const calls = [];
  const waits = [];
  const send = async (payload) => {
    calls.push(payload);
    return calls.length === 1 ? { ok: false, error: 'rate-limit' } : reply(linesOf(payload));
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a', 'b'], send, wait: async (ms) => waits.push(ms) });
  assert.equal(await t.translate('a', {}), '中:a');
  assert.equal(calls.length, 2);
  assert.equal(waits.length, 1);
  assert.ok(waits[0] > 0);
});

test('a batch that keeps failing gives up after a bounded number of tries', async () => {
  let count = 0;
  const send = async () => {
    count++;
    return { ok: false, error: 'http-503' };
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a'], send, wait: noWait });
  await assert.rejects(t.translate('a', {}), (e) => e.code === 'http-503');
  assert.equal(count, ai.MAX_ATTEMPTS);
});

test('fatal errors are not retried', async () => {
  let count = 0;
  const send = async () => {
    count++;
    return { ok: false, error: 'bad-key' };
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => ['a', 'b'], send, wait: noWait });
  await assert.rejects(t.translate('a', {}), (e) => e.code === 'bad-key');
  assert.equal(count, 1);
});

test('a reply with the wrong line count is split in halves and retried', async () => {
  const sentences = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const sizes = [];
  const send = async (payload) => {
    const lines = linesOf(payload);
    sizes.push(lines.length);
    // The model drops a line whenever it gets more than four.
    const out = lines.length > 4 ? lines.slice(1) : lines;
    return { ok: true, text: JSON.stringify({ t: out.map((l) => `中:${l}`) }) };
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => sentences, send, wait: noWait });
  assert.equal(await t.translate('s0', {}), '中:s0');
  assert.equal(await t.translate('s7', {}), '中:s7');
  assert.deepEqual(sizes, [8, 4, 4]);
});

test('a timed-out batch is split so smaller requests can finish', async () => {
  const sentences = Array.from({ length: 8 }, (_, i) => `s${i}`);
  const sizes = [];
  const send = async (payload) => {
    const lines = linesOf(payload);
    sizes.push(lines.length);
    return lines.length > 4 ? { ok: false, error: 'timeout' } : reply(lines);
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => sentences, send, wait: noWait });
  assert.equal(await t.translate('s0', {}), '中:s0');
  assert.equal(await t.translate('s5', {}), '中:s5');
  assert.deepEqual(sizes, [8, 4, 4]);
});

test('a fresh start also requests the following batch right away', async () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `s${i}`);
  const batches = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const send = async (payload) => {
    batches.push(linesOf(payload));
    await gate;
    return reply(linesOf(payload));
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => sentences, send });
  const first = t.translate('s0', {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(batches.length, 2);
  assert.deepEqual(batches[0], sentences.slice(0, ai.FIRST_BATCH_SIZE));
  assert.deepEqual(batches[1], sentences.slice(ai.FIRST_BATCH_SIZE, ai.FIRST_BATCH_SIZE + ai.BATCH_SIZE));
  release();
  assert.equal(await first, '中:s0');
  // Lines of the follow-up batch need no new request.
  assert.equal(await t.translate('s20', {}), '中:s20');
  assert.equal(batches.length, 2);
});

test('a continuing batch does not start an extra follow-up', async () => {
  const sentences = Array.from({ length: 60 }, (_, i) => `s${i}`);
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => sentences, send });
  await t.translate('s0', {});
  assert.equal(calls.length, 2);
  await t.translate('s28', {});
  assert.equal(calls.length, 3);
  assert.deepEqual(linesOf(calls[2]), sentences.slice(28, 48));
});
