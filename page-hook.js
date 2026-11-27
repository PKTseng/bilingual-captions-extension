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
  const SOURCE_CODES = ['en', 'ja', 'ko', 'th'];
  const baseLanguage = (code) => String(code ?? '').toLowerCase().split(/[-_]/)[0];
  // A copy of content.js from before languages existed asks for English.
  const wantedLanguage = (value) => value === 'auto' || SOURCE_CODES.includes(value) ? value : 'en';

  function playerResponse(videoId) {
    const response = document.querySelector('#movie_player')?.getPlayerResponse?.();
    return response?.videoDetails?.videoId === videoId ? response : undefined;
  }

  const captionTracks = (response) => response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];

  function sourceLanguage(response, wanted) {
    if (wanted !== 'auto') return wanted;
    // On dubbed videos YouTube identifies original audio as <language>.4.
    const renderer = response?.captions?.playerCaptionsTracklistRenderer;
    const audioIds = [
      ...(renderer?.audioTracks ?? []).map((track) => track.audioTrackId),
      ...(response?.streamingData?.adaptiveFormats ?? []).map((format) => format.audioTrack?.id),
    ];
    const original = audioIds.find((id) => typeof id === 'string' && id.endsWith('.4'));
    const tracks = captionTracks(response);
    if (!original && !tracks.length) return undefined;
    const asr = tracks.filter((track) => track.kind === 'asr');
    const candidates = new Set((asr.length ? asr : tracks).map((track) => baseLanguage(track.languageCode)));
    const language = original ? baseLanguage(original.slice(0, -2))
      : candidates.size === 1 ? [...candidates][0] : undefined;
    return SOURCE_CODES.includes(language) ? language : 'en';
  }

  function videoDetails(videoId, wanted) {
    const response = playerResponse(videoId);
    const details = response?.videoDetails;
    const language = sourceLanguage(response, wanted);
    const available = captionTracks(response).some((track) => baseLanguage(track.languageCode) === language);
    return {
      title: String(details?.title ?? ''),
      channel: String(details?.author ?? ''),
      description: String(details?.shortDescription ?? ''),
      language: wanted === 'auto' || available ? language : undefined,
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
    const response = playerResponse(videoId);
    const all = captionTracks(response);
    const base = captured.get(videoId);
    const params = base && new URL(base).searchParams;
    const capturedAsr = params?.get('kind') === 'asr' && baseLanguage(params.get('lang'));
    const language = sourceLanguage(response, wanted) ?? (SOURCE_CODES.includes(capturedAsr) ? capturedAsr : 'en');
    const listed = all.filter((track) => baseLanguage(track.languageCode) === language)
      .sort((a, b) => (a.kind === 'asr') - (b.kind === 'asr'));
    // The player lists its tracks, and none is in this language.
    if (all.length && !listed.length) return { error: 'empty' };
    if (!listed.length && !base) return { error: 'no-token' };
    const tracks = listed.length ? listed
      : [{ languageCode: language }, { languageCode: language, kind: 'asr' }];
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
