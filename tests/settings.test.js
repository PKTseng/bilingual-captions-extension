const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../settings.js');

test('mergeSettings fills defaults and rejects unknown tier', () => {
  assert.deepEqual(s.mergeSettings(undefined), s.DEFAULT_SETTINGS);
  assert.equal(s.mergeSettings({ tier: 'weird' }).tier, 'basic');
  const m = s.mergeSettings({ tier: 'aiPro', aiPro: { model: 'x/y' } });
  assert.equal(m.tier, 'aiPro');
  assert.equal(m.aiPro.model, 'x/y');
  assert.equal(m.aiPro.provider, 'openrouter');
});

test('mergeSettings does not mutate defaults and falls back on unknown provider', () => {
  const m = s.mergeSettings({ aiFree: { provider: 'nope', model: 'z' } });
  assert.equal(m.aiFree.provider, 'gemini');
  assert.equal(m.aiFree.model, 'z');
  m.aiPro.model = 'changed';
  assert.notEqual(s.DEFAULT_SETTINGS.aiPro.model, 'changed');
});

test('buildChatRequest targets provider endpoint with bearer key', () => {
  const settings = s.mergeSettings({ aiPro: { provider: 'openrouter', model: 'm1' } });
  const msgs = [{ role: 'user', content: 'hi' }];
  const req = s.buildChatRequest(settings, { openrouter: 'k1' }, 'aiPro', msgs);
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers.Authorization, 'Bearer k1');
  assert.equal(req.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(req.init.body), { model: 'm1', messages: msgs, temperature: 0.2 });
});

test('httpErrorCode maps auth failures to bad-key', () => {
  assert.equal(s.httpErrorCode(401), 'bad-key');
  assert.equal(s.httpErrorCode(403), 'bad-key');
  assert.equal(s.httpErrorCode(429), 'http-429');
  assert.equal(s.httpErrorCode(500), 'http-500');
});

test('fetchErrorCode tells a timeout from a network failure', () => {
  assert.equal(s.REQUEST_TIMEOUT_MS, 25000);
  assert.equal(s.fetchErrorCode(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(s.fetchErrorCode(new TypeError('Failed to fetch')), 'network');
  assert.equal(s.fetchErrorCode(undefined), 'network');
});

test('buildChatRequest reports missing key and basic tier', () => {
  const settings = s.mergeSettings({});
  assert.deepEqual(s.buildChatRequest(settings, {}, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: '  ' }, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: 'k' }, 'basic', []), { error: 'bad-tier' });
});

test('describeTier labels tiers with short model names', () => {
  const settings = s.mergeSettings({
    aiFree: { provider: 'openrouter', model: 'meta-llama/llama-4:free' },
    aiPro: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
  });
  assert.equal(s.describeTier(settings, 'basic'), '基本（Chrome 內建）');
  assert.equal(s.describeTier(settings, 'aiFree'), 'AI 免費 · llama-4:free');
  assert.equal(s.describeTier(settings, 'aiPro'), 'AI 進階 · claude-sonnet-5.5');
  assert.equal(s.describeTier(s.mergeSettings({}), 'aiFree'), `AI 免費 · ${s.DEFAULT_SETTINGS.aiFree.model}`);
  assert.equal(s.describeTier(settings, 'weird'), '基本（Chrome 內建）');
});
