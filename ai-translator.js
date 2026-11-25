// Batched AI translator with the same interface content.js uses from Chrome's
// built-in Translator (translate / destroy). It never touches the network:
// the injected `send` carries each batch to the background worker.
(() => {
  'use strict';

  // A fresh start or a seek sends a small batch so the first line comes back
  // quickly; batches that continue from translated lines can be larger.
  const FIRST_BATCH_SIZE = 8;
  const BATCH_SIZE = 20;
  const CONTEXT_SIZE = 5;
  // A long video sends a hundred or more batches, so a single slow or
  // malformed reply is expected sooner or later. Such failures are retried
  // here (at most MAX_ATTEMPTS rounds per line) instead of ending AI
  // translation for the rest of the video.
  const MAX_ATTEMPTS = 3;
  const RETRY_DELAYS_MS = [1500, 4000];
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Failures that a later request can get past. The others (no key, bad key,
  // no credits, unknown model, orphaned script) will fail the same way again.
  function isTransientError(code) {
    if (['timeout', 'network', 'rate-limit', 'bad-reply'].includes(code)) return true;
    const status = /^http-(\d+)$/.exec(code ?? '')?.[1];
    return status === '408' || Boolean(status?.startsWith('5'));
  }

  // While the rest of a video is translated in the background, one batch at a
  // time with this pause between them.
  const PREFETCH_PAUSE_MS = 500;
  const DESCRIPTION_LENGTH = 300;
  const GLOSSARY_LIMIT = 40;

  // `fixSource`: the lines are auto-generated captions, and the reply also
  // carries them corrected (s) next to the translations (t).
  function systemPrompt({ languageName = '英文', fixSource = false, hasVideo = false, hasGlossary = false } = {}) {
    const rules = [
      `你是影片字幕翻譯員。請把 lines 中的${languageName}句子逐句翻成台灣用語的繁體中文。`,
      'context 是前文，只供理解語境，不要翻譯。',
    ];
    if (hasVideo) rules.push('video 是影片的標題、頻道與說明，只用來判斷主題與專有名詞的寫法，不要翻譯。');
    rules.push(languageName === '英文'
      ? '人名、品牌、產品與專有名詞請保留原文。'
      : '品牌與產品名稱保留原文；人名有通行的中文譯名時用譯名，否則保留原文。');
    if (hasGlossary) {
      rules.push('glossary 是使用者指定的詞彙對照：原文出現這些詞時，必須用指定的寫法（值與原文相同代表保留原文）。');
    }
    if (fixSource) {
      rules.push(
        'lines 是自動語音辨識的字幕，沒有標點，也可能聽錯字。',
        '請在 s 逐句回傳修正後的原文：補上標點與大小寫、改正明顯聽錯的字，不要改寫、增加或刪除內容。',
        '只回傳 JSON，格式為 {"t":[...],"s":[...]}，不要加任何說明或程式碼圍欄；',
        't 和 s 的項數與順序都必須和 lines 完全相同。',
      );
    } else {
      rules.push(
        '只回傳 JSON，格式為 {"t":[...]}，不要加任何說明或程式碼圍欄；',
        't 的項數與順序必須和 lines 完全相同。',
      );
    }
    return rules.join('\n');
  }

  // Links and hashtags say little about the topic; the start of the
  // description says the most.
  function compactVideo(video) {
    if (!video || typeof video !== 'object') return undefined;
    const clean = (text) => String(text ?? '').replace(/https?:\/\/\S+/g, ' ').replace(/#\S+/g, ' ')
      .replace(/\s+/g, ' ').trim();
    const compact = {
      title: clean(video.title),
      channel: clean(video.channel),
      description: clean(video.description).slice(0, DESCRIPTION_LENGTH),
    };
    for (const key of Object.keys(compact)) if (!compact[key]) delete compact[key];
    return Object.keys(compact).length ? compact : undefined;
  }

  // Only the terms that appear in this batch go out. Latin terms match whole
  // words ("AI" is not found in "said"); others match anywhere.
  function relevantGlossary(entries, lines) {
    if (!Array.isArray(entries) || !entries.length) return undefined;
    const text = lines.join('\n');
    const lower = text.toLowerCase();
    const escape = (term) => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const picked = entries.filter(({ source }) => {
      if (typeof source !== 'string' || !source) return false;
      if (!/^[\x20-\x7e]+$/.test(source)) return lower.includes(source.toLowerCase());
      return new RegExp(`(?<![A-Za-z0-9])${escape(source)}(?![A-Za-z0-9])`, 'i').test(text);
    }).slice(0, GLOSSARY_LIMIT);
    return picked.length ? Object.fromEntries(picked.map(({ source, target }) => [source, target])) : undefined;
  }

  // A correction that changed far more than punctuation and a few words is
  // more likely a rewrite, so the original line is kept.
  function plausibleFix(original, fixed) {
    if (typeof fixed !== 'string') return false;
    const letters = (text) => text.toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
    const before = letters(String(original ?? ''));
    const after = letters(fixed);
    if (!after) return false;
    const ratio = after.length / Math.max(1, before.length);
    return ratio >= 0.6 && ratio <= 1.5;
  }

  function buildBatch(sentences, text, done, recent) {
    const at = sentences.indexOf(text);
    if (at === -1) return { lines: [text], context: recent.slice(-CONTEXT_SIZE) };
    const continuing = at > 0 && done(sentences[at - 1]);
    const size = continuing ? BATCH_SIZE : FIRST_BATCH_SIZE;
    const lines = [text];
    const seen = new Set(lines);
    for (let i = at + 1; i < sentences.length && lines.length < size; i++) {
      const s = sentences[i];
      if (seen.has(s) || done(s)) continue;
      seen.add(s);
      lines.push(s);
    }
    return { lines, context: sentences.slice(Math.max(0, at - CONTEXT_SIZE), at) };
  }

  // `options` comes from the caller's getContext(): { languageName,
  // fixSource, video, glossary } (glossary as parsed by bceSettings).
  function buildMessages({ lines, context }, options = {}) {
    const video = compactVideo(options.video);
    const glossary = relevantGlossary(options.glossary, lines);
    const payload = {};
    if (video) payload.video = video;
    if (glossary) payload.glossary = glossary;
    payload.context = context;
    payload.lines = lines;
    const prompt = systemPrompt({
      languageName: options.languageName, fixSource: Boolean(options.fixSource),
      hasVideo: Boolean(video), hasGlossary: Boolean(glossary),
    });
    return [
      { role: 'system', content: prompt },
      { role: 'user', content: JSON.stringify(payload) },
    ];
  }

  // { t, s }: t is required; s (corrected source lines) only when asked for,
  // and dropped rather than failing the batch when it is malformed.
  function parseBatchReply(reply, count, { withSource = false } = {}) {
    const text = String(reply).replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('reply has no JSON object');
    const parsed = JSON.parse(text.slice(start, end + 1));
    const t = parsed?.t;
    if (!Array.isArray(t) || t.length !== count || !t.every((x) => typeof x === 'string' && x.trim())) {
      throw new Error(`reply must hold ${count} nonempty translations`);
    }
    const s = withSource && Array.isArray(parsed.s) && parsed.s.length === count
      ? parsed.s.map((x) => typeof x === 'string' && x.trim() ? x.trim() : undefined) : undefined;
    return { t, s };
  }

  const abortError = () => new DOMException('Translation aborted', 'AbortError');
  const codedError = (code, message) => Object.assign(new Error(message || code), { code });

  // `seed` holds translations saved on an earlier visit, and `seedSources`
  // the corrected captions saved with them: they are answered at once and
  // left out of batches. `onResult(line, translation, corrected)` hears each
  // line translated here. `getContext()` is read for every batch (see
  // buildMessages), so a language found later still reaches the prompt.
  function createAiTranslator({
    tier, getSentences, send, wait = pause, seed, seedSources, onResult, getContext = () => ({}),
  }) {
    const results = new Map(seed);
    const sources = new Map(seedSources);
    const pending = new Map();
    let recent = [];
    let destroyed = false;

    async function request(lines, context) {
      const options = getContext() ?? {};
      const withSource = Boolean(options.fixSource);
      let res;
      try {
        res = await send({ type: 'bce-ai', tier, messages: buildMessages({ lines, context }, options) });
      } catch (err) {
        throw codedError('send-failed', err && err.message);
      }
      if (!res || typeof res.ok !== 'boolean') throw codedError('send-failed');
      if (!res.ok) throw codedError(res.error || 'send-failed');
      try {
        return parseBatchReply(res.text, lines.length, { withSource });
      } catch (err) {
        throw codedError('bad-reply', err.message);
      }
    }

    // A reply with the wrong number of lines, or one too slow to finish, is
    // usually down to the batch size, so those batches are split in halves;
    // other transient failures are retried as they are after a pause.
    async function runBatch(lines, context, attempt = 0) {
      let out;
      try {
        out = await request(lines, context);
      } catch (err) {
        if (destroyed || !isTransientError(err.code) || attempt + 1 >= MAX_ATTEMPTS) throw err;
        if (lines.length > 1 && (err.code === 'bad-reply' || err.code === 'timeout')) {
          const half = Math.ceil(lines.length / 2);
          const head = lines.slice(0, half);
          await Promise.all([
            runBatch(head, context, attempt + 1),
            runBatch(lines.slice(half), [...context, ...head].slice(-CONTEXT_SIZE), attempt + 1),
          ]);
          return;
        }
        await wait(RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)]);
        if (destroyed) throw abortError();
        await runBatch(lines, context, attempt + 1);
        return;
      }
      if (destroyed) return;
      lines.forEach((line, i) => {
        const fixed = plausibleFix(line, out.s?.[i]) ? out.s[i] : undefined;
        results.set(line, out.t[i]);
        if (fixed) sources.set(line, fixed);
        try {
          onResult?.(line, out.t[i], fixed);
        } catch {
          // Saving is optional; the translation is already in hand.
        }
      });
    }

    const done = (t) => results.has(t) || pending.has(t);

    // Callers wait on a batch through `pending`, so a line is never asked for twice.
    function track(lines, promise) {
      const cleanup = () => {
        for (const line of lines) if (pending.get(line) === promise) pending.delete(line);
      };
      // Also keeps the stored copy from raising an unhandled rejection when
      // its only caller already aborted.
      promise.then(cleanup, cleanup);
      for (const line of lines) pending.set(line, promise);
      return promise;
    }

    function startBatch(text, sentences = getSentences() || [], followUp = true) {
      const at = sentences.indexOf(text);
      const fresh = at !== -1 && !(at > 0 && done(sentences[at - 1]));
      const { lines, context } = buildBatch(sentences, text, done, recent);
      const promise = track(lines, runBatch(lines, context));
      // A fresh start or a seek has nothing translated ahead, so the next
      // batch goes out alongside the small first one instead of after it;
      // otherwise the lines after the first batch wait a whole round trip.
      if (fresh && followUp) {
        const next = sentences.slice(at + 1).find((s) => !done(s));
        if (next !== undefined) startBatch(next, sentences, false);
      }
      return promise;
    }

    async function resolveText(text) {
      for (;;) {
        if (destroyed) throw abortError();
        if (results.has(text)) return results.get(text);
        try {
          await (pending.get(text) || startBatch(text));
        } catch (err) {
          if (destroyed) throw abortError();
          throw err;
        }
      }
    }

    function translate(text, { signal } = {}) {
      if (destroyed || (signal && signal.aborted)) return Promise.reject(abortError());
      const work = resolveText(text).then((out) => {
        if (!(signal && signal.aborted)) recent = [...recent, text].slice(-CONTEXT_SIZE);
        return out;
      });
      if (!signal) return work;
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    }

    // Translates every line not done yet, from `from` to the end and then from
    // the start, one batch at a time. Resolves to true once all are done, or
    // false when stopped (destroy, `signal`) or a batch failed for good; the
    // lines left are still translated on demand.
    async function prefetch(sentences, { from = 0, signal } = {}) {
      const total = sentences.length;
      const order = Array.from({ length: total }, (_, k) => (Math.max(0, from) + k) % total);
      let k = 0;
      while (k < total) {
        if (destroyed || signal?.aborted) return false;
        if (done(sentences[order[k]])) {
          k++;
          continue;
        }
        const start = order[k];
        const lines = [];
        const seen = new Set();
        // A batch is a run of neighbouring lines, so its context is the lines before it.
        let j = k;
        while (j < total && lines.length < BATCH_SIZE && (j === k || order[j] === order[j - 1] + 1)) {
          const line = sentences[order[j]];
          if (!done(line) && !seen.has(line)) {
            seen.add(line);
            lines.push(line);
          }
          j++;
        }
        const context = sentences.slice(Math.max(0, start - CONTEXT_SIZE), start);
        try {
          await track(lines, runBatch(lines, context));
        } catch {
          return false;
        }
        k = j;
        if (k < total) await wait(PREFETCH_PAUSE_MS);
      }
      return !destroyed;
    }

    // The caption as the AI corrected it, when it did.
    const sourceOf = (text) => sources.get(text);

    function destroy() {
      destroyed = true;
      results.clear();
      sources.clear();
      pending.clear();
      recent = [];
    }

    return { kind: 'ai', translate, prefetch, sourceOf, destroy };
  }

  const api = {
    FIRST_BATCH_SIZE, BATCH_SIZE, CONTEXT_SIZE, MAX_ATTEMPTS, PREFETCH_PAUSE_MS, isTransientError, buildBatch,
    buildMessages, systemPrompt, compactVideo, relevantGlossary, plausibleFix, parseBatchReply, createAiTranslator,
  };
  globalThis.bceAiTranslator = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
