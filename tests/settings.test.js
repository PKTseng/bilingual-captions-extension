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

test('buildChatRequest reports missing key and basic tier', () => {
  const settings = s.mergeSettings({});
  assert.deepEqual(s.buildChatRequest(settings, {}, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: '  ' }, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: 'k' }, 'basic', []), { error: 'bad-tier' });
});
