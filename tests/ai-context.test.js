// The prompt's extras (language, video details, glossary), corrected auto
// captions, and translating a whole video ahead.
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai-translator.js');

const noWait = async () => {};
const reply = (lines) => ({ ok: true, text: JSON.stringify({ t: lines.map((l) => `中:${l}`) }) });
const batchOf = (call) => JSON.parse(call.messages[1].content);
function fakeSend() {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    return reply(batchOf(payload).lines);
  };
  return { calls, send };
}

test('the prompt names the source language and keeps English rules for English', () => {
  assert.match(ai.systemPrompt(), /英文句子/);
  assert.match(ai.systemPrompt(), /專有名詞請保留原文/);
  const japanese = ai.systemPrompt({ languageName: '日文' });
  assert.match(japanese, /日文句子/);
  assert.match(japanese, /通行的中文譯名/);
  assert.doesNotMatch(japanese, /"s"/);
  assert.match(ai.systemPrompt({ fixSource: true }), /\{"t":\[\.\.\.\],"s":\[\.\.\.\]\}/);
});

test('messages carry the video details and only the glossary terms in this batch', () => {
  const glossary = [
    { source: 'AI', target: '人工智慧' },
    { source: 'Kubernetes', target: 'Kubernetes' },
    { source: '東京', target: '東京' },
  ];
  const [system, user] = ai.buildMessages({ lines: ['We said AI runs on Kubernetes'], context: ['before'] }, {
    video: { title: 'Intro to k8s', channel: 'Ops', description: 'Watch https://x.y/z #devops now '.repeat(30) },
    glossary,
  });
  const payload = JSON.parse(user.content);
  assert.deepEqual(Object.keys(payload), ['video', 'glossary', 'context', 'lines']);
  assert.deepEqual(payload.glossary, { AI: '人工智慧', Kubernetes: 'Kubernetes' });
  assert.equal(payload.video.title, 'Intro to k8s');
  assert.ok(!payload.video.description.includes('https://') && !payload.video.description.includes('#devops'));
  assert.ok(payload.video.description.length <= 300);
  assert.match(system.content, /glossary/);
  assert.match(system.content, /video/);

  // "AI" is not found inside "said"; with nothing to add, the payload is as before.
  const plain = JSON.parse(ai.buildMessages({ lines: ['she said hi'], context: [] }, { glossary })[1].content);
  assert.deepEqual(Object.keys(plain), ['context', 'lines']);
  const [japaneseTerm] = [JSON.parse(ai.buildMessages({ lines: ['東京に行く'], context: [] }, { glossary })[1].content)];
  assert.deepEqual(japaneseTerm.glossary, { 東京: '東京' });
});

test('parseBatchReply keeps corrected lines only when asked and well formed', () => {
  const text = '{"t":["甲","乙"],"s":["So, today.","  "]}';
  assert.deepEqual(ai.parseBatchReply(text, 2, { withSource: true }), { t: ['甲', '乙'], s: ['So, today.', undefined] });
  assert.deepEqual(ai.parseBatchReply(text, 2), { t: ['甲', '乙'], s: undefined });
  assert.equal(ai.parseBatchReply('{"t":["甲","乙"],"s":["x"]}', 2, { withSource: true }).s, undefined);
});

test('a correction that rewrites the line is not trusted', () => {
  assert.equal(ai.plausibleFix('so today we are going to', 'So today, we are going to.'), true);
  assert.equal(ai.plausibleFix('so today', 'This is an entirely different and much longer sentence.'), false);
  assert.equal(ai.plausibleFix('hello', ''), false);
  assert.equal(ai.plausibleFix('hello', undefined), false);
  for (const other of ['こんにちは', '안녕하세요', 'bonjour']) {
    assert.equal(ai.plausibleFix('hello', other), false);
  }
  assert.equal(ai.plausibleFix('we are goin home', 'We are going home.'), true);
});

test('auto captions come back corrected, and a rewrite is ignored', async () => {
  const payloads = [];
  const send = async (payload) => {
    payloads.push(payload);
    const { lines } = batchOf(payload);
    return { ok: true, text: JSON.stringify({
      t: lines.map((l) => `中:${l}`),
      s: lines.map((l) => (l === 'so today we' ? 'So today, we' : 'Something else entirely, and much much longer')),
    }) };
  };
  const heard = [];
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => ['so today we', 'go'], send, wait: noWait,
    getContext: () => ({ fixSource: true, languageName: '英文' }),
    onResult: (...args) => heard.push(args),
  });
  assert.equal(await t.translate('so today we'), '中:so today we');
  assert.equal(t.sourceOf('so today we'), 'So today, we');
  assert.equal(t.sourceOf('go'), undefined);
  assert.match(payloads[0].messages[0].content, /"s"/);
  assert.deepEqual(heard, [['so today we', '中:so today we', 'So today, we'], ['go', '中:go', undefined]]);
});

test('the context is read for every batch, so a language found later is used', async () => {
  const { calls, send } = fakeSend();
  let languageName = '英文';
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => ['a', 'b'], send, wait: noWait, getContext: () => ({ languageName }),
  });
  await t.translate('a');
  languageName = '日文';
  t.destroy();
  const next = ai.createAiTranslator({
    tier: 'ai', getSentences: () => ['c'], send, wait: noWait, getContext: () => ({ languageName }),
  });
  await next.translate('c');
  assert.match(calls[0].messages[0].content, /英文句子/);
  assert.match(calls.at(-1).messages[0].content, /日文句子/);
});

test('saved corrections are answered without a request', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => ['a'], send, wait: noWait,
    seed: new Map([['a', '甲'], ['hello', '你好']]), seedSources: new Map([['a', 'A.'], ['hello', 'こんにちは']]),
  });
  assert.equal(await t.translate('a'), '甲');
  assert.equal(t.sourceOf('a'), 'A.');
  assert.equal(await t.translate('hello'), '你好');
  assert.equal(t.sourceOf('hello'), undefined);
  assert.equal(calls.length, 0);
});

test('prefetch translates every line left, from the given place and then from the start', async () => {
  const lines = Array.from({ length: 50 }, (_, i) => `p${i}`);
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => lines, send, wait: noWait, seed: new Map([['p31', '已存']]),
  });
  assert.equal(await t.prefetch(lines, { from: 30 }), true);
  const batches = calls.map(batchOf);
  assert.equal(batches[0].lines[0], 'p30');
  assert.ok(!batches.flatMap((b) => b.lines).includes('p31'), 'saved lines are not sent');
  assert.deepEqual(batches[0].context, lines.slice(25, 30));
  // After the end it starts over from the first line, with no context before it.
  const restart = batches.find((b) => b.lines[0] === 'p0');
  assert.deepEqual(restart.context, []);
  assert.equal(new Set(batches.flatMap((b) => b.lines)).size, 49);
  assert.ok(batches.every((b) => b.lines.length <= ai.BATCH_SIZE));
  for (const line of lines) assert.equal(typeof await t.translate(line), 'string');
  assert.equal(calls.length, batches.length, 'nothing is asked for twice');
});

test('prefetch stops on abort or destroy, and on a batch that fails for good', async () => {
  const lines = Array.from({ length: 60 }, (_, i) => `q${i}`);
  const controller = new AbortController();
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({
    tier: 'ai', getSentences: () => lines, send, wait: async () => controller.abort(),
  });
  assert.equal(await t.prefetch(lines, { signal: controller.signal }), false);
  assert.equal(calls.length, 1);

  const failing = ai.createAiTranslator({
    tier: 'ai', getSentences: () => lines, wait: noWait, send: async () => ({ ok: false, error: 'credits' }),
  });
  assert.equal(await failing.prefetch(lines), false);

  const destroyed = ai.createAiTranslator({ tier: 'ai', getSentences: () => lines, send, wait: noWait });
  destroyed.destroy();
  assert.equal(await destroyed.prefetch(lines), false);
});

test('a line being prefetched is waited for, not sent again', async () => {
  const lines = ['r0', 'r1', 'r2'];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    await gate;
    return reply(batchOf(payload).lines);
  };
  const t = ai.createAiTranslator({ tier: 'ai', getSentences: () => lines, send, wait: noWait });
  const all = t.prefetch(lines);
  const one = t.translate('r1');
  release();
  assert.equal(await one, '中:r1');
  assert.equal(await all, true);
  assert.equal(calls.length, 1);
});
