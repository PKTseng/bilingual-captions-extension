// Content-script side of the postMessage channel to page-hook.js, which runs
// in the page world, holds the player's caption token and downloads the
// English json3 track for us.
(() => {
  'use strict';

  const pendingTracks = new Map();
  const tokenWaiters = new Set();
  let requestCounter = 0;
  let timedCache;

  window.addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== 'bce-timedtext') return;
    if (data.type === 'token') {
      for (const waiter of tokenWaiters) waiter(data.videoId);
    } else if (data.type === 'track') {
      pendingTracks.get(data.requestId)?.(data);
    }
  });

  function askPage(id) {
    return new Promise((resolve) => {
      const requestId = `${Date.now()}-${++requestCounter}`;
      const finish = (data) => {
        clearTimeout(timer);
        pendingTracks.delete(requestId);
        resolve(data);
      };
      const timer = setTimeout(() => finish({ error: 'timeout' }), 15000);
      pendingTracks.set(requestId, finish);
      window.postMessage({ source: 'bce-content', type: 'load', videoId: id, requestId }, location.origin);
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

  // The last track downloaded, if it belongs to this video.
  function cachedTimedText(id) {
    return timedCache?.videoId === id ? timedCache : undefined;
  }

  // Resolves to { videoId, cues, wordTimed, source } or undefined. When the
  // page has no token yet, `nudge` (if given) is called to make the player
  // request captions, and the download is retried once the token arrives.
  async function requestTimedText(id, nudge) {
    const cached = cachedTimedText(id);
    if (cached) return cached;
    let reply = await askPage(id);
    if (reply.error === 'no-token') {
      // The player only requests captions once the video is playing.
      const token = waitForToken(id, 20000);
      if (nudge) void nudge();
      if (await token) reply = await askPage(id);
    }
    if (!reply.events) return undefined;
    const asr = reply.track.kind === 'asr';
    const cues = globalThis.bceCaptions.fromJson3(reply.events, { asr });
    if (!cues.length) return undefined;
    timedCache = {
      videoId: id,
      cues,
      wordTimed: asr,
      source: asr ? 'YouTube 英文自動字幕' : 'YouTube 英文字幕',
    };
    return timedCache;
  }

  globalThis.bcePageBridge = { requestTimedText, cachedTimedText };
})();
