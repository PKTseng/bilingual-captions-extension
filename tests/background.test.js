const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const settings = require('../settings.js');
const usageModule = require('../usage.js');

const background = readFileSync(join(__dirname, '../background.js'), 'utf8');
const envUrl = 'chrome-extension://test/.env';

// `stored` seeds chrome.storage.local; `usage` is what each reply reports.
function loadWorker(env, keys, { stored = {}, usage } = {}) {
  let onMessage;
  let onInstalled;
  const authHeaders = [];
  const opened = [];
  const data = { [settings.KEYS_KEY]: keys, ...stored };
  vm.runInNewContext(background, {
    importScripts() {},
    bceSettings: settings,
    bceUsage: usageModule,
    AbortSignal,
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
        onMessage: { addListener: (listener) => { onMessage = listener; } },
        onInstalled: { addListener: (listener) => { onInstalled = listener; } },
      },
      tabs: { create: async ({ url }) => { opened.push(url); } },
      storage: { local: {
        get: async (wanted) => {
          const list = Array.isArray(wanted) ? wanted : [wanted];
          return structuredClone(Object.fromEntries(list.filter((key) => key in data).map((key) => [key, data[key]])));
        },
        // A pause, so writes of replies that arrive together could overlap.
        set: async (values) => {
          await new Promise((resolve) => setImmediate(resolve));
          Object.assign(data, structuredClone(values));
        },
      } },
    },
    async fetch(url, options) {
      if (url === envUrl) {
        if (env === undefined) throw new TypeError('File not found');
        return new Response(env);
      }
      authHeaders.push(options.headers.Authorization);
      return Response.json({ choices: [{ message: { content: '測試字幕' } }], usage });
    },
  });
  return {
    data,
    authHeaders,
    opened,
    install: (reason) => onInstalled({ reason }),
    translate: (tier) => new Promise((resolve) => {
      onMessage({ type: 'bce-ai', tier, messages: [] }, {}, resolve);
    }),
  };
}

test('local env key takes precedence over the stored key', async () => {
  const worker = loadWorker(
    '\uFEFF# Local keys\r\nOPENROUTER_API_KEY = "local-openrouter"\r\n',
    { openrouter: 'stored-openrouter' },
  );

  assert.equal((await worker.translate('ai')).ok, true);
  assert.deepEqual(worker.authHeaders, ['Bearer local-openrouter']);
});

test('missing env file and blank entries fall back to the key saved in Chrome', async () => {
  for (const env of [undefined, "OPENROUTER_API_KEY=''\n", 'OPENROUTER_API_KEY=\n']) {
    const worker = loadWorker(env, { openrouter: 'stored-openrouter' });
    assert.equal((await worker.translate('ai')).ok, true);
    assert.deepEqual(worker.authHeaders, ['Bearer stored-openrouter']);
  }
  assert.equal((await loadWorker(undefined, {}).translate('ai')).error, 'no-key');
});

test('a leftover Gemini key is ignored', async () => {
  const worker = loadWorker('GEMINI_API_KEY=local-gemini\n', { gemini: 'stored-gemini' });
  assert.equal((await worker.translate('ai')).error, 'no-key');
  assert.equal((await worker.translate('aiFree')).error, 'bad-tier');
  assert.deepEqual(worker.authHeaders, []);
});

test('a first install opens the welcome page, an update does not', () => {
  const worker = loadWorker(undefined, {});
  worker.install('update');
  worker.install('chrome_update');
  assert.deepEqual(worker.opened, []);
  worker.install('install');
  assert.deepEqual(worker.opened, ['chrome-extension://test/welcome.html']);
});

test('each reply adds its cost and tokens to this month, even when replies arrive together', async () => {
  const usage = { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140, cost: 0.0005 };
  const worker = loadWorker(undefined, { openrouter: 'k' }, { usage });
  const replies = await Promise.all([worker.translate('ai'), worker.translate('ai'), worker.translate('ai')]);
  assert.ok(replies.every((reply) => reply.ok));
  const { current } = usageModule.mergeUsage(worker.data[usageModule.USAGE_KEY]);
  assert.equal(current.requests, 3);
  assert.equal(current.promptTokens, 300);
  assert.equal(current.completionTokens, 120);
  assert.ok(Math.abs(current.cost - 0.0015) < 1e-12);
});

test('a reached monthly limit stops requests before they are sent', async () => {
  const month = usageModule.monthOf(new Date());
  const stored = {
    [settings.SETTINGS_KEY]: { tier: 'ai', monthlyLimit: 1 },
    [usageModule.USAGE_KEY]: { current: { month, cost: 1.02, promptTokens: 0, completionTokens: 0, requests: 9 } },
  };
  const worker = loadWorker(undefined, { openrouter: 'k' }, { stored });
  assert.deepEqual({ ...await worker.translate('ai') }, { ok: false, error: 'budget' });
  assert.deepEqual(worker.authHeaders, []);
  // Last month's spending does not count.
  const lastMonth = { current: { month: '2000-01', cost: 50, promptTokens: 0, completionTokens: 0, requests: 1 } };
  const fresh = loadWorker(undefined, { openrouter: 'k' }, { stored: { ...stored, [usageModule.USAGE_KEY]: lastMonth } });
  assert.equal((await fresh.translate('ai')).ok, true);
});
