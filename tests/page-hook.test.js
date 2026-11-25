const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const code = fs.readFileSync(require.resolve('../page-hook.js'), 'utf8');

// Runs page-hook.js against a fake player. `served` lists the tracks the
// server has events for, as "lang/kind" ("ja/asr", "en/").
function loadHook(tracks, { served = tracks.map((t) => `${t.languageCode}/${t.kind ?? ''}`), details = {} } = {}) {
  const posted = [];
  const fetched = [];
  const window = new EventTarget();
  window.postMessage = (data) => {
    posted.push(data);
    for (const waiter of [...waiters]) waiter(data);
  };
  window.fetch = async (url) => {
    const parsed = new URL(url);
    const key = `${parsed.searchParams.get('lang')}/${parsed.searchParams.get('kind') ?? ''}`;
    fetched.push(key);
    const events = served.includes(key) ? [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: key }] }] : [];
    return { ok: true, text: async () => JSON.stringify({ events }) };
  };
  const waiters = new Set();
  function XMLHttpRequest() {}
  XMLHttpRequest.prototype.open = function () {};
  const response = {
    videoDetails: { videoId: 'v1', title: 'A title', author: 'A channel', shortDescription: 'About it', ...details },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: tracks.map((t) => ({ baseUrl: '/api/timedtext?v=v1', ...t })) } },
  };
  vm.runInNewContext(code, {
    window, URL, XMLHttpRequest, location: new URL('https://www.youtube.com/watch?v=v1'),
    document: { querySelector: () => ({ getPlayerResponse: () => response }) },
  });
  let counter = 0;
  function ask(type, language) {
    const requestId = `r${++counter}`;
    return new Promise((resolve) => {
      const waiter = (data) => {
        if (data.requestId !== requestId) return;
        waiters.delete(waiter);
        // Copied into this realm, so deepEqual compares plain objects.
        resolve(JSON.parse(JSON.stringify(data)));
      };
      waiters.add(waiter);
      window.dispatchEvent(Object.assign(new Event('message'), {
        source: window, data: { source: 'bce-content', type, videoId: 'v1', language, requestId },
      }));
    });
  }
  return { ask, fetched, posted };
}

const tracks = [
  { languageCode: 'en' },
  { languageCode: 'ja', kind: 'asr' },
  { languageCode: 'ja' },
  { languageCode: 'zh-Hant' },
];

test('auto picks the spoken language (its auto track), human-made first', async () => {
  const hook = loadHook(tracks);
  const reply = await hook.ask('load', 'auto');
  assert.deepEqual(reply.track, { lang: 'ja', kind: '' });
  assert.deepEqual(hook.fetched, ['ja/']);
});

test('auto falls back to English when the spoken language is not supported', async () => {
  const hook = loadHook([{ languageCode: 'zh', kind: 'asr' }, { languageCode: 'en-US' }]);
  assert.deepEqual((await hook.ask('load', 'auto')).track, { lang: 'en', kind: '' });
});

test('a chosen language takes only its own tracks', async () => {
  const hook = loadHook(tracks, { served: ['ja/asr'] });
  assert.deepEqual((await hook.ask('load', 'ja')).track, { lang: 'ja', kind: 'asr' });
  assert.deepEqual(hook.fetched, ['ja/', 'ja/asr']);
  // English is listed but serves nothing: without the player's own request
  // the download may just need its token, so the bridge waits for one.
  const english = await hook.ask('load', 'en');
  assert.deepEqual(english.track, undefined);
  assert.equal(english.error, 'no-token');
});

test('none of the listed tracks in the chosen language: no download is tried', async () => {
  const hook = loadHook(tracks);
  assert.equal((await hook.ask('load', 'ko')).error, 'empty');
  assert.deepEqual(hook.fetched, []);
});

test('a request without a language (an older content script) means English', async () => {
  const hook = loadHook(tracks);
  assert.deepEqual((await hook.ask('load', undefined)).track, { lang: 'en', kind: '' });
});

test('details carry the title, channel, description and the language that would be used', async () => {
  const hook = loadHook(tracks);
  const reply = await hook.ask('details', 'auto');
  assert.equal(reply.title, 'A title');
  assert.equal(reply.channel, 'A channel');
  assert.equal(reply.description, 'About it');
  assert.equal(reply.language, 'ja');
  assert.equal((await hook.ask('details', 'en')).language, 'en');
  assert.equal((await hook.ask('details', 'ko')).language, undefined);
});
