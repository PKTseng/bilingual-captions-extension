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

  const SYSTEM_PROMPT = [
    '你是影片字幕翻譯員。請把 lines 中的英文句子逐句翻成台灣用語的繁體中文。',
    'context 是前文，只供理解語境，不要翻譯。',
    '人名、品牌、產品與專有名詞請保留原文。',
    '只回傳 JSON，格式為 {"t":[...]}，不要加任何說明或程式碼圍欄；',
    't 的項數與順序必須和 lines 完全相同。',
  ].join('\n');

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

  function buildMessages({ lines, context }) {
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify({ context, lines }) },
    ];
  }

  function parseBatchReply(reply, count) {
    const text = String(reply).replace(/```(?:json)?/gi, '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end < start) throw new Error('reply has no JSON object');
    const t = JSON.parse(text.slice(start, end + 1)).t;
    if (!Array.isArray(t) || t.length !== count || !t.every((x) => typeof x === 'string')) {
      throw new Error(`reply must hold ${count} strings`);
    }
    return t;
  }

  const abortError = () => new DOMException('Translation aborted', 'AbortError');
  const codedError = (code, message) => Object.assign(new Error(message || code), { code });

  function createAiTranslator({ tier, getSentences, send }) {
    const results = new Map();
    const pending = new Map();
    let recent = [];
    let destroyed = false;

    async function runBatch(lines, context) {
      let res;
      try {
        res = await send({ type: 'bce-ai', tier, messages: buildMessages({ lines, context }) });
      } catch (err) {
        throw codedError('send-failed', err && err.message);
      }
      if (!res || typeof res.ok !== 'boolean') throw codedError('send-failed');
      if (!res.ok) throw codedError(res.error || 'send-failed');
      let out;
      try {
        out = parseBatchReply(res.text, lines.length);
      } catch (err) {
        throw codedError('bad-reply', err.message);
      }
      if (destroyed) return;
      lines.forEach((line, i) => results.set(line, out[i]));
    }

    function startBatch(text) {
      const done = (t) => results.has(t) || pending.has(t);
      const { lines, context } = buildBatch(getSentences() || [], text, done, recent);
      const promise = runBatch(lines, context);
      const cleanup = () => {
        for (const line of lines) if (pending.get(line) === promise) pending.delete(line);
      };
      // Also keeps the stored copy from raising an unhandled rejection when
      // its only caller already aborted.
      promise.then(cleanup, cleanup);
      for (const line of lines) pending.set(line, promise);
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

    function destroy() {
      destroyed = true;
      results.clear();
      pending.clear();
      recent = [];
    }

    return { kind: 'ai', translate, destroy };
  }

  const api = { FIRST_BATCH_SIZE, BATCH_SIZE, CONTEXT_SIZE, buildBatch, buildMessages, parseBatchReply, createAiTranslator };
  globalThis.bceAiTranslator = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
