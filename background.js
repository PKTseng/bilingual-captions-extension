// Service worker: relays AI translation requests from content scripts to the
// configured provider. API keys are read here only; they never reach content.js.
importScripts('settings.js');

const { SETTINGS_KEY, KEYS_KEY, mergeSettings, buildChatRequest } = globalThis.bceSettings;

async function handleAi({ tier, messages }) {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
  const settings = mergeSettings(stored[SETTINGS_KEY]);
  const req = buildChatRequest(settings, stored[KEYS_KEY], tier, messages);
  if (req.error) return { ok: false, error: req.error };

  let res;
  try {
    res = await fetch(req.url, req.init);
  } catch {
    return { ok: false, error: 'network' };
  }
  if (!res.ok) return { ok: false, error: `http-${res.status}` };

  try {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text) return { ok: true, text };
  } catch {
    // fall through to bad-reply
  }
  return { ok: false, error: 'bad-reply' };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.type !== 'bce-ai') return;
  handleAi(msg).then(sendResponse, () => sendResponse({ ok: false, error: 'network' }));
  return true;
});
