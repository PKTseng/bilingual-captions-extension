// The simulated YouTube page that content.js runs in for the player tests.
const fs = require('node:fs');
const vm = require('node:vm');
const settings = require('../settings.js');
const ai = require('../ai-translator.js');
const store = require('../translation-store.js');
const languages = require('../languages.js');

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
  prepend(...children) { this.children.unshift(...children); }
  replaceChildren(...children) { this.children = children; }
  contains(item) { return this.children.includes(item); }
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

async function openPlayer(translate = async (text) => '基本 ' + text, live = false, stored = {}, browser = {}) {
  const elements = [];
  const document = new EventTarget();
  document.createElement = () => {
    const item = new Element();
    elements.push(item);
    return item;
  };
  const video = { currentTime: 0, readyState: 4, paused: false, play: async () => { video.paused = false; } };
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
  let poll, changed, onMessage;
  const sent = [];
  const payloads = [];
  const context = {
    document, window, Element, Event, AbortController, URLSearchParams, performance: { now: () => now },
    clearTimeout, setTimeout: () => 1,
    location: new URL('https://www.youtube.com/watch?v=test'),
    setInterval: (fn) => { poll = fn; }, matchMedia: () => ({ matches: true }),
    bceTranscript: { readTranscript: () => [], openTranscript: () => false },
    bcePageBridge: {
      cachedTimedText: (id) => live || id === 'silent' ? undefined : { cues },
      requestTimedText: () => new Promise(() => {}),
      requestVideoDetails: async () => ({}),
      cachedVideoDetails: () => undefined,
    },
    bceLanguages: languages,
    bceSettings: settings, bceAiTranslator: ai,
    // Writes wait for a flush that these tests never trigger.
    bceTranslationStore: {
      ...store,
      createTranslationStore: (options) => store.createTranslationStore({ ...options, setTimer: () => 1, clearTimer() {} }),
    },
    Translator: { create: async () => ({ translate, destroy() {} }) },
    navigator: { userActivation: { isActive: false } },
    ...browser,
    chrome: {
      runtime: { sendMessage: async (payload) => {
        const { lines } = JSON.parse(payload.messages[1].content);
        sent.push(...lines);
        payloads.push(payload);
        const error = await response.promise;
        if (error) return { ok: false, error };
        // `browser.aiReply` lets a test answer with more than translations.
        const reply = browser.aiReply ? browser.aiReply(lines) : { t: lines.map((line) => 'AI ' + line) };
        return { ok: true, text: JSON.stringify(reply) };
      }, onMessage: { addListener: (fn) => { onMessage = fn; }, removeListener() {} } },
      storage: { local: {
        get: async (keys) => Object.fromEntries(Object.entries(stored)
          .filter(([key]) => Array.isArray(keys) ? keys.includes(key) : keys === key)),
        set: async (values) => Object.assign(stored, values),
      }, onChanged: { addListener: (fn) => { changed = fn; } } },
    },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../content.js'), 'utf8'), context);
  await flush();
  function say(text) {
    raw = text;
    poll();
    now += 250;
    poll();
  }
  const line = elements.find((el) => el.className === 'bce-line bce-translation');
  const select = (tier) => changed({ [settings.SETTINGS_KEY]: { newValue: { tier } } }, 'local');
  return {
    line, respond: response.resolve, say, select, sent, payloads,
    original: elements.find((el) => el.className === 'bce-line bce-original'),
    // Playback moves on by `ms` in poll-sized steps.
    play(ms) {
      for (let left = ms; left > 0; left -= 250) {
        now += 250;
        poll();
      }
    },
    sourceLanguage(value) { changed({ bceSourceLanguage: { newValue: value } }, 'local'); },
    toggle: elements.find((el) => el.className === 'bce-toggle'),
    indicator: elements.find((el) => el.className === 'bce-toggle-source'),
    download: elements.find((el) => el.className === 'bce-download'),
    notice: elements.find((el) => el.className === 'bce-notice'),
    replay: elements.find((el) => el.className === 'bce-replay'),
    video,
    menuItem: (key) => elements.findLast((el) => el.dataset.key === key),
    display(mode) { changed({ bceCaptionDisplayMode: { newValue: mode } }, 'local'); },
    toggleCaptions() { window.dispatchEvent(Object.assign(new Event('keydown'), { code: 'KeyC', altKey: true })); },
    menuSwitch() {
      this.toggle.dispatchEvent(new Event('click'));
      elements.findLast((el) => el.dataset.key === 'switch').dispatchEvent(new Event('click'));
    },
    playingCaptions: () => player.classList.contains('bce-replaces-native'),
    navigate(id) { context.location.search = '?v=' + id; document.dispatchEvent(new Event('yt-navigate-finish')); poll(); },
    enabledFromOtherTab(value) { changed({ bceCaptionsEnabled: { newValue: value } }, 'local'); },
    readyState(value) { video.readyState = value; poll(); },
    status() {
      let reply;
      onMessage({ type: 'bce-status' }, {}, (value) => { reply = value; });
      return reply;
    },
    go(time) { video.currentTime = time; poll(); },
  };
}

module.exports = { Element, flush, deferred, openPlayer };
