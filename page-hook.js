// Runs in the page's own JavaScript world (manifest "world": "MAIN").
// Downloads the caption track in the source language as json3 (millisecond
// cue times, plus per-word offsets on auto-generated tracks), and reads the
// video's title, channel and description for AI translation. Some YouTube sessions only
// serve captions to requests that carry the player's `pot` token, so this
// script also remembers the player's own timedtext request and reuses its
// parameters.
(() => {
  'use strict';

  const FROM_PAGE = 'bce-timedtext';
  const FROM_CONTENT = 'bce-content';
  const TRACK_PARAMS = ['lang', 'kind', 'name', 'tlang', 'vssId'];
  const captured = new Map();

  function post(data) {
    window.postMessage({ source: FROM_PAGE, ...data }, location.origin);
  }

  function remember(url) {
    try {
      const parsed = new URL(url, location.href);
      const id = parsed.searchParams.get('v');
      if (!parsed.pathname.endsWith('/api/timedtext') || !id) return;
      const known = captured.get(id);
      // Keep a URL with a token over one without.
      if (known && new URL(known).searchParams.has('pot') && !parsed.searchParams.has('pot')) return;
      captured.set(id, parsed.href);
      post({ type: 'token', videoId: id });
    } catch {
      // Not a URL we care about.
    }
  }

  // Three ways to see the player's request, because other scripts on the page
  // (or other extensions) may replace XMLHttpRequest / fetch after us.
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    remember(String(url));
    return open.apply(this, arguments);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input) {
    remember(typeof input === 'string' ? input : input?.url ?? String(input));
    return nativeFetch.apply(this, arguments);
  };
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.name.includes('/api/timedtext')) remember(entry.name);
      }
    }).observe({ type: 'resource', buffered: true });
  } catch {
    // Resource timing unavailable.
  }

  // Kept in step with languages.js, which the page world does not load.
  const SOURCE_CODES = ['en', 'ja', 'ko'];
  const baseLanguage = (code) => String(code ?? '').toLowerCase().split(/[-_]/)[0];
  // A copy of content.js from before languages existed asks for English.
  const wantedLanguage = (value) => value === 'auto' || SOURCE_CODES.includes(value) ? value : 'en';

  function playerResponse(videoId) {
    const response = document.querySelector('#movie_player')?.getPlayerResponse?.();
    return response?.videoDetails?.videoId === videoId ? response : undefined;
  }

  const captionTracks = (response) => response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  // The order to try tracks in. 'auto' starts with the language spoken in the
  // video (the one its auto-generated track is in), then English, then the
  // other supported ones. Human-made tracks come before auto-generated ones.
  function rankTracks(tracks, wanted) {
    const spoken = baseLanguage(tracks.find((track) => track.kind === 'asr')?.languageCode);
    const order = wanted !== 'auto' ? [wanted]
      : [...new Set([SOURCE_CODES.includes(spoken) ? spoken : 'en', 'en', ...SOURCE_CODES])];
    return order.flatMap((code) => tracks.filter((track) => baseLanguage(track.languageCode) === code)
      .sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr')));
  }

  function videoDetails(videoId, wanted) {
    const response = playerResponse(videoId);
    const details = response?.videoDetails;
    const best = rankTracks(captionTracks(response), wanted)[0];
    return {
      title: String(details?.title ?? ''),
      channel: String(details?.author ?? ''),
      description: String(details?.shortDescription ?? ''),
      language: best ? baseLanguage(best.languageCode) : undefined,
    };
  }

  // Start from the player's own request when we have one (it carries the
  // token and client parameters), then switch it to this track.
  function trackUrl(track, base) {
    const url = new URL(base ?? track.baseUrl ?? '/api/timedtext', location.href);
    if (base) {
      for (const key of TRACK_PARAMS) url.searchParams.delete(key);
      for (const [key, value] of new URL(track.baseUrl ?? '', location.href).searchParams) {
        if (key !== 'tlang' && key !== 'fmt') url.searchParams.set(key, value);
      }
    }
    url.searchParams.delete('tlang');
    url.searchParams.set('lang', track.languageCode);
    if (track.kind) url.searchParams.set('kind', track.kind);
    else url.searchParams.delete('kind');
    url.searchParams.set('fmt', 'json3');
    return url;
  }

  async function download(url) {
    try {
      const response = await nativeFetch(url, { credentials: 'include' });
      const text = response.ok ? await response.text() : '';
      const events = text ? JSON.parse(text).events : undefined;
      return events?.length ? events : undefined;
    } catch {
      return undefined;
    }
  }

  async function load(videoId, wanted) {
    const all = captionTracks(playerResponse(videoId));
    const listed = rankTracks(all, wanted);
    // The player lists its tracks, and none is in this language.
    if (all.length && !listed.length) return { error: 'empty' };
    const base = captured.get(videoId);
    if (!listed.length && !base) return { error: 'no-token' };
    // Without a track list, guess from the language the player itself asked for.
    const playerLanguage = base && baseLanguage(new URL(base).searchParams.get('lang'));
    const guess = wanted !== 'auto' ? wanted : SOURCE_CODES.includes(playerLanguage) ? playerLanguage : 'en';
    const tracks = listed.length ? listed
      : [{ languageCode: guess }, { languageCode: guess, kind: 'asr' }];
    for (const track of tracks) {
      const events = await download(trackUrl(track, base));
      if (events) {
        return { events, track: { lang: baseLanguage(track.languageCode), kind: track.kind ?? '' } };
      }
    }
    // Without the player's request the track URLs may need its token.
    return { error: base ? 'empty' : 'no-token' };
  }

  window.addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== window || data?.source !== FROM_CONTENT) return;
    const wanted = wantedLanguage(data.language);
    if (data.type === 'details') {
      post({ type: 'details', requestId: data.requestId, videoId: data.videoId, ...videoDetails(data.videoId, wanted) });
      return;
    }
    if (data.type !== 'load') return;
    const result = await load(data.videoId, wanted);
    post({ type: 'track', requestId: data.requestId, videoId: data.videoId, ...result });
  });
})();
