// Content-script side of the postMessage channel to page-hook.js, which runs
// in the page world, holds the player's caption token, downloads the
// caption track in the source language and reads the video's details.
(() => {
  'use strict';

  const { LANGUAGES, normalizeLanguage, traitsOf } = globalThis.bceLanguages;
  const pendingReplies = new Map();
  const tokenWaiters = new Set();
  let requestCounter = 0;
  let timedCache;
  let detailsCache;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== 'bce-timedtext') return;
    if (data.type === 'token') {
      for (const waiter of tokenWaiters) waiter(data.videoId);
    } else if (data.type === 'track' || data.type === 'details') {
      pendingReplies.get(data.requestId)?.(data);
    }
  });

  function askPage(type, id, language, ms) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${++requestCounter}`;
      const finish = (data) => {
        clearTimeout(timer);
        pendingReplies.delete(requestId);
        resolve(data);
      };
      const timer = setTimeout(() => finish({ error: 'timeout' }), ms);
      pendingReplies.set(requestId, finish);
      window.postMessage({ source: 'bce-content', type, videoId: id, language, requestId }, location.origin);
    });
  }

  function waitForToken(id, ms) {
    return new Promise((resolve) => {
      const finish = (found) => {
        clearTimeout(timer);
        tokenWaiters.delete(waiter);
        resolve(found);
      };
      const waiter = (tokenId) => {
        if (tokenId === id) finish(true);
      };
      const timer = setTimeout(() => finish(false), ms);
      tokenWaiters.add(waiter);
    });
  }

  // The last track downloaded, if it belongs to this video and language choice.
  function cachedTimedText(id, preference = 'auto') {
    return timedCache?.videoId === id && timedCache.preference === preference ? timedCache : undefined;
  }

  // Resolves to { videoId, preference, cues, source, language, asr } or
  // undefined. When the page has no token yet, `nudge` (if given) is called
  // to make the player request captions, and the download is retried once
  // the token arrives.
  async function requestTimedText(id, nudge, preference = 'auto') {
    const cached = cachedTimedText(id, preference);
    if (cached) return cached;
    let reply = await askPage('load', id, preference, 15000);
    if (reply.error === 'no-token') {
      // The player only requests captions once the video is playing.
      const token = waitForToken(id, 20000);
      if (nudge) void nudge();
      if (await token) reply = await askPage('load', id, preference, 15000);
    }
    if (!reply.events) return undefined;
    const asr = reply.track.kind === 'asr';
    const language = normalizeLanguage(reply.track.lang) ?? 'en';
    const cues = globalThis.bceCaptions.fromJson3(reply.events, { asr, traits: traitsOf(language) });
    if (!cues.length) return undefined;
    timedCache = {
      videoId: id,
      preference,
      cues,
      language,
      asr,
      source: `YouTube ${LANGUAGES[language].label}${asr ? '自動字幕' : '字幕'}`,
    };
    return timedCache;
  }

  function cachedVideoDetails(id, preference = 'auto') {
    return detailsCache?.videoId === id && detailsCache.preference === preference ? detailsCache : undefined;
  }

  // Title, channel and description for the AI prompt, and the language of
  // the track that would be picked. Never rejects: the page may not answer.
  // Kept only once the player had this video's data.
  async function requestVideoDetails(id, preference = 'auto') {
    const cached = cachedVideoDetails(id, preference);
    if (cached) return cached;
    const reply = await askPage('details', id, preference, 1500);
    const fallbackTitle = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    const details = {
      videoId: id,
      preference,
      title: reply.title || fallbackTitle,
      channel: reply.channel || '',
      description: reply.description || '',
      language: normalizeLanguage(reply.language),
    };
    if (!reply.error && reply.title) detailsCache = details;
    return details;
  }

  globalThis.bcePageBridge = { requestTimedText, cachedTimedText, requestVideoDetails, cachedVideoDetails };
})();
