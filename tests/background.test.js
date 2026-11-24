const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const settings = require('../settings.js');

const background = readFileSync(join(__dirname, '../background.js'), 'utf8');
const envUrl = 'chrome-extension://test/.env';

function loadWorker(env, keys) {
  let onMessage;
  const authHeaders = [];
  vm.runInNewContext(background, {
    importScripts() {},
    bceSettings: settings,
    AbortSignal,
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://test/${path}`,
        onMessage: { addListener: (listener) => { onMessage = listener; } },
      },
      storage: { local: { get: async () => ({ [settings.KEYS_KEY]: keys }) } },
    },
    async fetch(url, options) {
      if (url === envUrl) {
        if (env === undefined) throw new TypeError('File not found');
        return new Response(env);
      }
      authHeaders.push(options.headers.Authorization);
      return Response.json({ choices: [{ message: { content: '測試字幕' } }] });
    },
  });
  return {
    authHeaders,
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
