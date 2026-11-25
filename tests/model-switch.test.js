const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('../settings.js');
const ai = require('../ai-translator.js');

// Only the browser boundaries are simulated. Drive the real content script
// through Alt+C, a storage change and its normal playback poll.
class Element extends EventTarget {
  children = [];
  dataset = {};
  style = { setProperty() {} };
  classes = new Set();
  classList = {
    add: (name) => this.classes.add(name),
    remove: (name) => this.classes.delete(name),
    contains: (name) => this.classes.has(name),
    toggle: (name, on) => on ? this.classes.add(name) : this.classes.delete(name),
  };
  set textContent(value) { this.children = [value]; }
  get textContent() { return this.children.map((child) => child.textContent ?? child).join(''); }
  append(...children) { this.children.push(...children); }
  setAttribute() {}
  remove() {}
  getBoundingClientRect() { return { width: 100, height: 40 }; }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function playerSession(translate = async (text) => '基本 ' + text, live = false) {
  const elements = [];
  const document = new EventTarget();
  document.createElement = () => {
    const item = new Element();
    elements.push(item);
    return item;
  };
  const video = { currentTime: 0 };
  let now = 0;
  let raw = 'One.';
  const captions = { getClientRects: () => [1], querySelectorAll: () => [{ textContent: raw }] };
  const cc = { getAttribute: (key) => key === 'aria-pressed' ? 'true' : null, getClientRects: () => [1] };
  const player = new Element();
  player.querySelector = (selector) => ({
    video, '.ytp-subtitles-button': live && cc, '.ytp-caption-window-container': live && captions,
  })[selector] || null;
  document.querySelector = (selector) => selector === '#movie_player' ? player : null;
  const window = new EventTarget();
  const cues = ['One', 'Two', 'Three'].map((text, i) => ({ text, start: [0, 2, 180][i], end: [2, 4, 182][i] }));
  const response = deferred();
  let poll, changed;
  const context = {
    document, window, Element, Event, AbortController, URLSearchParams, performance: { now: () => now },
    clearTimeout, setTimeout: () => 1,
    location: new URL('https://www.youtube.com/watch?v=test'),
    setInterval: (fn) => { poll = fn; }, matchMedia: () => ({ matches: true }),
    bceTranscript: { readTranscript: () => [] },
    bcePageBridge: { cachedTimedText: () => live ? undefined : { cues }, requestTimedText: () => new Promise(() => {}) },
    bceSettings: settings, bceAiTranslator: ai,
    Translator: { create: async () => ({ translate, destroy() {} }) },
    chrome: {
      runtime: { sendMessage: async (payload) => {
        const { lines } = JSON.parse(payload.messages[1].content);
        const error = await response.promise;
        if (error) return { ok: false, error };
        return { ok: true, text: JSON.stringify({ t: lines.map((line) => 'AI ' + line) }) };
      } },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener: (fn) => { changed = fn; } } },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'), 'utf8'), context);
  await flush();
  window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyC', altKey: true }));
  await flush();
  function say(text) {
    raw = text;
    poll();
    now += 250;
    poll();
  }
  if (live) {
    say('One.');
    await flush();
  }
  const line = elements.find((el) => el.className === 'bce-line bce-translation');
  assert.equal(line.textContent, live ? '基本 One.' : '基本 One');
  const select = (tier) => changed({ [settings.SETTINGS_KEY]: { newValue: { tier } } }, 'local');
  select('ai');
  await flush();
  return {
    line, respond: response.resolve, say, select,
    toggle: elements.find((el) => el.className === 'bce-toggle'),
    indicator: elements.find((el) => el.className === 'bce-toggle-source'),
    display(mode) { changed({ bceCaptionDisplayMode: { newValue: mode } }, 'local'); },
    stop() { window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyC', altKey: true })); },
    go(time) { video.currentTime = time; poll(); },
  };
}

test('a prefetched Chrome caption stays readable until the matching AI caption arrives', async () => {
  const session = await playerSession();
  session.go(2);
  assert.equal(session.line.textContent, '基本 Two');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Two');
});

test('Chrome supplies an uncached visible line during an AI delay', async () => {
  const session = await playerSession();
  session.go(180);
  await flush();
  assert.equal(session.line.textContent, '基本 Three');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
});

test('a late Chrome result cannot overwrite AI', async () => {
  const chromeReply = deferred();
  const session = await playerSession(async (text) => text === 'Three' ? chromeReply.promise : '基本 ' + text);
  session.go(180);
  session.respond();
  await flush();
  chromeReply.resolve('基本 Three');
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
});

test('live captions use the local translation while waiting for AI', async () => {
  const session = await playerSession(undefined, true);
  session.say('Two.');
  await flush();
  assert.equal(session.line.textContent, '基本 Two.');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Two.');
});

test('switching back to Chrome ignores a pending AI response', async () => {
  const session = await playerSession();
  session.go(2);
  session.select('basic');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, '基本 Two');
});

test('the player button pulses until an AI translation reaches the screen', async () => {
  const session = await playerSession();
  const { toggle } = session;
  assert.match(toggle.textContent, /AI…/);
  assert.ok(session.indicator.classList.contains('bce-waiting'));
  session.go(100); // No visible cue, even after AI finishes prefetching.
  session.respond();
  await flush();
  assert.match(toggle.textContent, /AI…/);
  session.go(180);
  assert.match(toggle.textContent, /AI$/);
  assert.equal(session.indicator.classList.contains('bce-waiting'), false);
  assert.equal(session.line.textContent, 'AI Three');
  session.select('basic');
  await flush();
  assert.match(toggle.textContent, /Chrome$/);
});

test('identical Chrome and AI wording still completes the switch', async () => {
  const session = await playerSession(async (text) => text === 'Two' ? 'AI Two' : '基本 ' + text);
  session.go(2);
  assert.match(session.toggle.textContent, /AI…/);
  session.respond();
  await flush();
  assert.match(session.toggle.textContent, /AI$/);
});

test('fallback, original-only mode and stopping clear the AI indicator', async () => {
  const session = await playerSession();
  session.respond('no-key');
  await flush();
  assert.match(session.toggle.textContent, /Chrome$/);
  session.display('original');
  assert.match(session.toggle.textContent, /原文$/);
  session.stop();
  assert.equal(session.toggle.textContent, 'Dual');
});
