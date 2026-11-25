// Service worker: relays AI translation requests from content scripts to the
// configured provider. API keys are read here only; they never reach content.js.
importScripts('settings.js');

const {
  SETTINGS_KEY, KEYS_KEY, REQUEST_TIMEOUT_MS, mergeSettings, buildChatRequest, httpErrorCode,
  fetchWithRetry, fetchErrorCode,
} = globalThis.bceSettings;

async function loadLocalKeys() {
  const keys = {};
  try {
    const response = await fetch(chrome.runtime.getURL('.env'), { cache: 'no-store' });
    if (!response.ok) return keys;
    for (const line of (await response.text()).split(/\r?\n/)) {
      const entry = line.trim().match(/^OPENROUTER_API_KEY\s*=\s*(?:"([^"\s]+)"|'([^'\s]+)'|([^\s"'#]+))(?:\s+#.*)?$/);
      if (entry) keys.openrouter = entry[1] ?? entry[2] ?? entry[3];
    }
  } catch {
    // The local file is optional for installations configured through the options page.
  }
  return keys;
}

async function handleAi({ tier, messages }) {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
  const settings = mergeSettings(stored[SETTINGS_KEY]);
  const keys = { ...stored[KEYS_KEY], ...await loadLocalKeys() };
  const req = buildChatRequest(settings, keys, tier, messages);
  if (req.error) return { ok: false, error: req.error };

  // One deadline covers the retries too; a pause cut short by it ends in a
  // fetch that fails at once with the timeout.
  const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const wait = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
  let res;
  try {
    res = await fetchWithRetry(() => fetch(req.url, { ...req.init, signal }), { wait });
  } catch (error) {
    return { ok: false, error: fetchErrorCode(error) };
  }
  if (!res.ok) {
    // Only the provider's error fields are read; they never hold the key.
    const body = res.status === 402 ? await res.json().catch(() => undefined) : undefined;
    const error = httpErrorCode(res.status, body, { retryAfter: res.headers.has('Retry-After') });
    console.warn('[bce] AI 請求失敗：', res.status, error);
    return { ok: false, error };
  }

  try {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) return { ok: true, text };
  } catch (error) {
    // The timeout also covers reading the body.
    if (fetchErrorCode(error) === 'timeout') return { ok: false, error: 'timeout' };
  }
  return { ok: false, error: 'bad-reply' };
}

// A first install opens the welcome page; updates and reloads stay quiet.
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason !== 'install') return;
  chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') })
    .catch((error) => console.warn('[bce] 無法打開歡迎頁：', error));
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  // From the player menu's 「API key 與模型設定…」; no reply.
  if (msg?.type === 'bce-open-options') {
    chrome.runtime.openOptionsPage().catch((error) => console.warn('[bce] 無法打開設定頁：', error));
    return;
  }
  if (!msg || msg.type !== 'bce-ai') return;
  handleAi(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'network' }));
  return true;
});
