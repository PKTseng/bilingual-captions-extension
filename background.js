// Service worker: relays AI translation requests from content scripts to the
// configured provider. API keys are read here only; they never reach content.js.
importScripts('settings.js');

const {
  SETTINGS_KEY, KEYS_KEY, REQUEST_TIMEOUT_MS, mergeSettings, buildChatRequest, httpErrorCode, fetchErrorCode,
} = globalThis.bceSettings;

async function handleAi({ tier, messages }) {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
  const settings = mergeSettings(stored[SETTINGS_KEY]);
  const req = buildChatRequest(settings, stored[KEYS_KEY], tier, messages);
  if (req.error) return { ok: false, error: req.error };

  let res;
  try {
    res = await fetch(req.url, { ...req.init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    return { ok: false, error: fetchErrorCode(error) };
  }
  if (!res.ok) {
    // The provider's error text helps tell a quota from a bad model name; it
    // never holds the key or the request body.
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // no body
    }
    console.warn('[bce] AI 請求失敗：', res.status, detail);
    return { ok: false, error: httpErrorCode(res.status) };
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

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'bce-ai') return;
  handleAi(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'network' }));
  return true;
});
