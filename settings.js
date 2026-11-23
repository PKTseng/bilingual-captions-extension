// Shared settings for the AI translation tiers: defaults, merging stored
// values, and building the OpenAI-compatible chat-completions request.
// Loaded as a content script, via importScripts, and via <script> in options.
(() => {
  'use strict';

  const SETTINGS_KEY = 'bceSettings';
  const KEYS_KEY = 'bceKeys';
  const TIERS = ['basic', 'aiFree', 'aiPro'];
  const TIER_LABELS = { basic: '基本', aiFree: 'AI 免費', aiPro: 'AI 進階' };
  const PROVIDERS = {
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
    gemini: { label: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions' },
  };
  const DEFAULT_SETTINGS = {
    tier: 'basic',
    aiFree: { provider: 'gemini', model: 'gemini-3.8-flash' },
    aiPro: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
  };

  function mergeTier(stored, defaults) {
    const base = { ...defaults };
    if (!stored || typeof stored !== 'object') return base;
    if (Object.hasOwn(PROVIDERS, stored.provider)) base.provider = stored.provider;
    if (typeof stored.model === 'string' && stored.model.trim()) base.model = stored.model.trim();
    return base;
  }

  function mergeSettings(stored) {
    const src = stored && typeof stored === 'object' ? stored : {};
    return {
      tier: TIERS.includes(src.tier) ? src.tier : 'basic',
      aiFree: mergeTier(src.aiFree, DEFAULT_SETTINGS.aiFree),
      aiPro: mergeTier(src.aiPro, DEFAULT_SETTINGS.aiPro),
    };
  }

  function buildChatRequest(settings, keys, tier, messages) {
    if (tier !== 'aiFree' && tier !== 'aiPro') return { error: 'bad-tier' };
    const { provider, model } = settings[tier];
    const key = String((keys && keys[provider]) ?? '').trim();
    if (!key) return { error: 'no-key' };
    return {
      url: PROVIDERS[provider].url,
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages, temperature: 0.2 }),
      },
    };
  }

  // Long enough for a slow batch, short enough that the service worker is
  // still alive to answer.
  const REQUEST_TIMEOUT_MS = 25000;

  function httpErrorCode(status) {
    return status === 401 || status === 403 ? 'bad-key' : `http-${status}`;
  }

  function fetchErrorCode(error) {
    return error && error.name === 'TimeoutError' ? 'timeout' : 'network';
  }

  const api = {
    SETTINGS_KEY, KEYS_KEY, TIERS, TIER_LABELS, PROVIDERS, DEFAULT_SETTINGS, REQUEST_TIMEOUT_MS,
    mergeSettings, buildChatRequest, httpErrorCode, fetchErrorCode,
  };
  globalThis.bceSettings = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
