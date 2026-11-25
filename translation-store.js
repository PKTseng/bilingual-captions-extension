// Keeps AI translations between visits in chrome.storage.local, one record
// per video and model, so rewatching a video costs nothing and shows Chinese
// at once. Storage is extension-only (unlike IndexedDB in a content script,
// which belongs to youtube.com). Loaded as a content script and in options.
(() => {
  'use strict';

  // Bump the version when the prompt or reply format changes, so translations
  // made the old way are no longer used (clearAll still removes them).
  // 2: lines may carry the corrected caption, and the prompt has the video's
  // details, the source language and the glossary.
  const VERSION = 2;
  const PREFIX = 'bceTx';
  const RECORD_PREFIX = `${PREFIX}${VERSION}:`;
  const INDEX_KEY = `${PREFIX}${VERSION}Index`;
  // Roughly 30 KB per ten minutes of captions; the oldest videos go first.
  const MAX_RECORDS = 300;
  // Results arrive a batch at a time; one write covers a burst of them.
  const FLUSH_DELAY_MS = 1500;

  const recordKey = (videoId, model) => `${RECORD_PREFIX}${videoId}|${model}`;

  // Stored as [caption, chinese] or [caption, chinese, corrected caption]
  // tuples: caption text never becomes an object key (a line reading
  // "__proto__" would be lost). Map of caption -> { t, s }.
  function readEntries(record) {
    const entries = new Map();
    if (!record || !Array.isArray(record.lines)) return entries;
    for (const tuple of record.lines) {
      if (!Array.isArray(tuple) || typeof tuple[0] !== 'string' || typeof tuple[1] !== 'string'
        || !tuple[0] || !tuple[1].trim()) continue;
      const s = typeof tuple[2] === 'string' && tuple[2].trim() ? tuple[2] : undefined;
      entries.set(tuple[0], { t: tuple[1], s });
    }
    return entries;
  }

  // Just the translations: caption -> chinese.
  function readLines(record) {
    return new Map([...readEntries(record)].map(([text, entry]) => [text, entry.t]));
  }

  const toTuple = ([text, { t, s }]) => (s ? [text, t, s] : [text, t]);

  function readIndex(value) {
    const index = {};
    if (!value || typeof value !== 'object') return index;
    for (const [key, at] of Object.entries(value)) {
      if (key.startsWith(RECORD_PREFIX) && Number.isFinite(at)) index[key] = at;
    }
    return index;
  }

  // Keys of the records past the newest `max`.
  function staleKeys(index, max) {
    return Object.entries(index).sort((a, b) => b[1] - a[1]).slice(max).map(([key]) => key);
  }

  function createTranslationStore({
    area, now = Date.now, maxRecords = MAX_RECORDS, flushDelayMs = FLUSH_DELAY_MS,
    setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    // key -> Map of lines not written yet.
    let dirty = new Map();
    // key -> time it was last opened without anything to write.
    let touched = new Map();
    let timer;
    // Writes run one after another so two flushes never undo each other.
    let chain = Promise.resolve();

    function schedule() {
      if (timer !== undefined) return;
      timer = setTimer(() => {
        timer = undefined;
        void flush();
      }, flushDelayMs);
    }

    async function write(pending, opened) {
      const keys = [...pending.keys()];
      const stored = await area.get([INDEX_KEY, ...keys]);
      const index = readIndex(stored[INDEX_KEY]);
      const at = now();
      for (const [key, time] of opened) if (Object.hasOwn(index, key)) index[key] = Math.max(index[key], time);
      const updates = {};
      for (const [key, lines] of pending) {
        const merged = readEntries(stored[key]);
        for (const [text, entry] of lines) merged.set(text, entry);
        updates[key] = { at, lines: [...merged].map(toTuple) };
        index[key] = at;
      }
      const stale = staleKeys(index, maxRecords);
      for (const key of stale) {
        delete index[key];
        delete updates[key];
      }
      await area.set({ ...updates, [INDEX_KEY]: index });
      if (stale.length) await area.remove(stale);
    }

    function flush() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      const pending = dirty;
      const opened = touched;
      dirty = new Map();
      touched = new Map();
      if (!pending.size && !opened.size) return chain;
      chain = chain.then(() => write(pending, opened)).catch((error) => {
        // Full storage or an orphaned copy: captions carry on without it.
        console.warn('[bce] 無法儲存譯文：', error);
      });
      return chain;
    }

    // Saved translations for this video and model, as { translations,
    // sources } (caption -> chinese, caption -> corrected caption); empty
    // when there are none or storage cannot be read.
    async function load(videoId, model) {
      const empty = () => ({ translations: new Map(), sources: new Map() });
      if (!videoId || !model) return empty();
      const key = recordKey(videoId, model);
      try {
        await chain;
        const stored = await area.get(key);
        const entries = readEntries(stored[key]);
        if (entries.size) {
          // Rewatched videos stay among the newest, even with nothing new to write.
          touched.set(key, now());
          schedule();
        }
        const translations = new Map();
        const sources = new Map();
        for (const [text, { t, s }] of entries) {
          translations.set(text, t);
          if (s) sources.set(text, s);
        }
        return { translations, sources };
      } catch {
        return empty();
      }
    }

    function save(videoId, model, text, result, source) {
      if (!videoId || !model || typeof text !== 'string' || !text
        || typeof result !== 'string' || !result.trim()) return;
      const key = recordKey(videoId, model);
      if (!dirty.has(key)) dirty.set(key, new Map());
      const s = typeof source === 'string' && source.trim() ? source : undefined;
      dirty.get(key).set(text, { t: result, s });
      schedule();
    }

    return { load, save, flush };
  }

  const isStoreKey = (key) => key.startsWith(PREFIX)
    && (/^bceTx\d+:/.test(key) || /^bceTx\d+Index$/.test(key));

  // Every saved translation, from this version and older ones.
  async function summarize(area) {
    const all = await area.get(null);
    const records = Object.keys(all).filter((key) => isStoreKey(key) && !key.endsWith('Index'));
    const lines = records.reduce((sum, key) => sum + readLines(all[key]).size, 0);
    const videos = new Set(records.map((key) => key.slice(key.indexOf(':') + 1, key.lastIndexOf('|'))));
    return { records: records.length, videos: videos.size, lines };
  }

  async function clearAll(area) {
    const keys = Object.keys(await area.get(null)).filter(isStoreKey);
    if (keys.length) await area.remove(keys);
    return keys.length;
  }

  const api = {
    VERSION, RECORD_PREFIX, INDEX_KEY, MAX_RECORDS, FLUSH_DELAY_MS, recordKey, readLines, readEntries, staleKeys,
    createTranslationStore, summarize, clearAll,
  };
  globalThis.bceTranslationStore = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
