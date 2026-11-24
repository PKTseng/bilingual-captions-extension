const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../settings.js');

test('mergeSettings fills defaults and rejects unknown tier', () => {
  assert.deepEqual(s.mergeSettings(undefined), s.DEFAULT_SETTINGS);
  assert.deepEqual(s.TIERS, ['basic', 'ai']);
  assert.deepEqual(s.DEFAULT_SETTINGS.ai, { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' });
  assert.equal(s.mergeSettings({ tier: 'weird' }).tier, 'basic');
  const m = s.mergeSettings({ tier: 'ai', ai: { model: 'x/y' } });
  assert.equal(m.tier, 'ai');
  assert.equal(m.ai.model, 'x/y');
  assert.equal(m.ai.provider, 'openrouter');
});

test('mergeSettings moves the old AI tiers to the single AI tier with its default model', () => {
  for (const tier of ['aiFree', 'aiPro']) {
    const m = s.mergeSettings({
      tier,
      aiFree: { provider: 'gemini', model: 'gemini-3.8-flash' },
      aiPro: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
    });
    assert.equal(m.tier, 'ai');
    assert.deepEqual(m.ai, s.DEFAULT_SETTINGS.ai);
    assert.equal('aiFree' in m || 'aiPro' in m, false);
  }
});

test('mergeSettings does not mutate defaults and falls back on unknown provider', () => {
  const m = s.mergeSettings({ ai: { provider: 'gemini', model: 'z' } });
  assert.equal(m.ai.provider, 'openrouter');
  assert.equal(m.ai.model, 'z');
  m.ai.model = 'changed';
  assert.notEqual(s.DEFAULT_SETTINGS.ai.model, 'changed');
  assert.deepEqual(Object.keys(s.PROVIDERS), ['openrouter']);
});

test('model menu uses bundled choices, local visibility, and the existing custom model', () => {
  const qwen = { provider: 'openrouter', model: 'qwen/qwen3.7-flash' };
  const hidden = s.modelMenuKey('ai', qwen);
  const settings = s.mergeSettings({
    ai: { provider: 'openrouter', model: 'my/custom-model' },
    hiddenModels: [hidden, hidden, null],
  });
  assert.ok(s.MODEL_CATALOG.every(({ tier, provider }) => tier === 'ai' && provider === 'openrouter'));
  assert.ok(s.listTranslationModels(s.mergeSettings()).some(({ model }) => model === qwen.model));
  assert.deepEqual(settings.hiddenModels, [hidden]);
  const models = s.listTranslationModels(settings);
  assert.ok(!models.some(({ model }) => model === qwen.model));
  assert.ok(models.some(({ tier, model }) => tier === 'ai' && model === 'my/custom-model'));
  assert.equal(models.filter(({ model }) => model === s.DEFAULT_SETTINGS.ai.model).length, 1);
});

test('buildChatRequest targets provider endpoint with bearer key', () => {
  const settings = s.mergeSettings({ ai: { provider: 'openrouter', model: 'm1' } });
  const msgs = [{ role: 'user', content: 'hi' }];
  const req = s.buildChatRequest(settings, { openrouter: 'k1' }, 'ai', msgs);
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers.Authorization, 'Bearer k1');
  assert.equal(req.init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(req.init.body), { model: 'm1', messages: msgs, temperature: 0.2 });
});

test('httpErrorCode distinguishes auth failures and rate limits', () => {
  assert.equal(s.httpErrorCode(401), 'bad-key');
  assert.equal(s.httpErrorCode(403), 'bad-key');
  assert.equal(s.httpErrorCode(429), 'rate-limit');
  assert.equal(s.httpErrorCode(429, { error: { code: 429, message: 'Rate limit exceeded' } }), 'rate-limit');
  assert.equal(s.httpErrorCode(500), 'http-500');
});

test('httpErrorCode treats a 402 as insufficient credits unless it is a transient in-flight limit', () => {
  const openRouterError = (metadata) => ({ error: { code: 402, message: 'x', metadata } });
  assert.equal(s.httpErrorCode(402), 'credits');
  assert.equal(s.httpErrorCode(402, openRouterError({ error_type: 'payment_required' })), 'credits');
  assert.equal(s.httpErrorCode(402, openRouterError({ limit_source: 'openrouter_credits' })), 'credits');
  assert.equal(s.httpErrorCode(402, openRouterError({ error_type: 'in_flight_budget_exhausted' })), 'rate-limit');
  assert.equal(s.httpErrorCode(402, openRouterError({ limit_source: 'openrouter_in_flight_budget' })), 'rate-limit');
  assert.equal(s.httpErrorCode(402, openRouterError(), { retryAfter: true }), 'rate-limit');
});

test('describeAiError names each failure the fallback can report', () => {
  assert.equal(s.describeAiError('credits'), 'AI 帳戶餘額不足');
  assert.equal(s.describeAiError('no-key'), '尚未設定 API key');
  assert.equal(s.describeAiError('bad-key'), 'API key 無效或沒有權限');
  assert.equal(s.describeAiError('timeout'), 'AI 回應逾時');
  assert.equal(s.describeAiError('network'), '無法連線到 AI 服務');
  assert.equal(s.describeAiError('send-failed'), '擴充功能已更新，請重新整理頁面');
  assert.equal(s.describeAiError('http-404'), '找不到這個模型');
  assert.equal(s.describeAiError('http-400'), 'AI 服務拒絕請求（HTTP 400，可能是模型名稱錯誤）');
  assert.equal(s.describeAiError('http-503'), 'AI 服務暫時無法使用（HTTP 503）');
  assert.equal(s.describeAiError('http-418'), 'AI 服務錯誤（HTTP 418）');
  assert.equal(s.describeAiError(undefined), 'AI 暫時無法使用');
});

test('fetchWithRetry retries an overloaded provider after a pause', async () => {
  const statuses = [503, 200];
  const waits = [];
  const res = await s.fetchWithRetry(async () => ({ ok: statuses[0] === 200, status: statuses.shift() }), {
    delays: [10, 20], wait: async (ms) => { waits.push(ms); },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(waits, [10]);
});

test('fetchWithRetry gives up after the last delay and returns the failure', async () => {
  let calls = 0;
  const res = await s.fetchWithRetry(async () => { calls++; return { ok: false, status: 503 }; }, {
    delays: [10, 20], wait: async () => {},
  });
  assert.equal(res.status, 503);
  assert.equal(calls, 3);
});

test('fetchWithRetry only retries 502, 503 and 504', async () => {
  for (const [status, expectedCalls] of [[502, 2], [504, 2], [500, 1], [400, 1], [429, 1], [200, 1]]) {
    let calls = 0;
    await s.fetchWithRetry(async () => {
      calls++;
      return calls === 1 ? { ok: status === 200, status } : { ok: true, status: 200 };
    }, { delays: [10], wait: async () => {} });
    assert.equal(calls, expectedCalls, `status ${status}`);
  }
});

test('fetchWithRetry lets a fetch failure through without retrying', async () => {
  let calls = 0;
  await assert.rejects(s.fetchWithRetry(async () => { calls++; throw new TypeError('offline'); }, {
    delays: [10], wait: async () => {},
  }), TypeError);
  assert.equal(calls, 1);
});

test('fetchErrorCode tells a timeout from a network failure', () => {
  assert.equal(s.REQUEST_TIMEOUT_MS, 25000);
  assert.equal(s.fetchErrorCode(new DOMException('timed out', 'TimeoutError')), 'timeout');
  assert.equal(s.fetchErrorCode(new TypeError('Failed to fetch')), 'network');
  assert.equal(s.fetchErrorCode(undefined), 'network');
});

test('buildChatRequest reports missing key and basic tier', () => {
  const settings = s.mergeSettings({});
  assert.deepEqual(s.buildChatRequest(settings, {}, 'ai', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { openrouter: '  ' }, 'ai', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { openrouter: 'k' }, 'basic', []), { error: 'bad-tier' });
  assert.deepEqual(s.buildChatRequest(settings, { openrouter: 'k' }, 'aiPro', []), { error: 'bad-tier' });
});

test('describeTier labels tiers with short model names', () => {
  const settings = s.mergeSettings({ ai: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' } });
  assert.equal(s.describeTier(settings, 'basic'), '基本（Chrome 內建）');
  assert.equal(s.describeTier(settings, 'ai'), 'AI · claude-sonnet-5.5');
  assert.equal(s.describeTier(s.mergeSettings({}), 'ai'), 'AI · deepseek-v4.1-flash');
  assert.equal(s.describeTier(settings, 'weird'), '基本（Chrome 內建）');
});
