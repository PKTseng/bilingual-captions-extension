// Shared settings for the AI translation tiers: defaults, merging stored
// values, and building the OpenAI-compatible chat-completions request.
// Loaded as a content script, via importScripts, and via <script> in options.
(() => {
  'use strict';

  const SETTINGS_KEY = 'bceSettings';
  const KEYS_KEY = 'bceKeys';
  const TIERS = ['basic', 'ai'];
  const TIER_LABELS = { basic: '基本', ai: 'AI' };
  // Settings saved before the single AI tier existed.
  const LEGACY_AI_TIERS = ['aiFree', 'aiPro'];
  const PROVIDERS = {
    openrouter: { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1/chat/completions' },
  };
  // glossary: the user's term list (see parseGlossary). fixAsr: AI also
  // returns auto-generated captions with punctuation and misheard words fixed.
  // prefetchWhole: AI translates the rest of the video in the background.
  // monthlyLimit: US dollars of AI use per month (usage.js); 0 is no limit.
  const DEFAULT_SETTINGS = {
    tier: 'basic',
    ai: { provider: 'openrouter', model: 'deepseek/deepseek-v4.1-flash' },
    hiddenModels: [],
    glossary: '',
    fixAsr: true,
    prefetchWhole: true,
    monthlyLimit: 0,
  };
  const GLOSSARY_MAX_LENGTH = 4000;
  const MODEL_CATALOG = [
    { tier: 'ai', ...DEFAULT_SETTINGS.ai },
    { tier: 'ai', provider: 'openrouter', model: 'qwen/qwen3.7-flash' },
    { tier: 'ai', provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
  ];

  const modelMenuKey = (tier, config) => `${tier}/${config.provider}/${config.model}`;

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
      tier: TIERS.includes(src.tier) ? src.tier : LEGACY_AI_TIERS.includes(src.tier) ? 'ai' : 'basic',
      // Old AI tier models are not carried over: the AI tier starts on its default.
      ai: mergeTier(src.ai, DEFAULT_SETTINGS.ai),
      hiddenModels: Array.isArray(src.hiddenModels)
        ? [...new Set(src.hiddenModels.filter((key) => typeof key === 'string'))] : [],
      glossary: typeof src.glossary === 'string' ? src.glossary.slice(0, GLOSSARY_MAX_LENGTH) : '',
      fixAsr: typeof src.fixAsr === 'boolean' ? src.fixAsr : DEFAULT_SETTINGS.fixAsr,
      prefetchWhole: typeof src.prefetchWhole === 'boolean' ? src.prefetchWhole : DEFAULT_SETTINGS.prefetchWhole,
      monthlyLimit: Number.isFinite(src.monthlyLimit) && src.monthlyLimit > 0
        ? Math.round(src.monthlyLimit * 100) / 100 : 0,
    };
  }

  // One term per line. "LLM = 大型語言模型" (or →, ->) sets how a term is
  // translated; a term alone ("Kubernetes") is kept as it is. Lines starting
  // with # are notes. Repeated terms keep their first line.
  function parseGlossary(text) {
    const entries = [];
    const seen = new Set();
    for (const raw of String(text ?? '').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const match = /^(.+?)\s*(?:=|＝|→|->)\s*(.*)$/.exec(line);
      const source = (match ? match[1] : line).trim();
      const target = (match ? match[2] : '').trim() || source;
      const key = source.toLowerCase();
      if (!source || seen.has(key)) continue;
      seen.add(key);
      entries.push({ source, target });
    }
    return entries;
  }

  // Besides the model, the glossary and the caption fix change what the AI
  // returns, so translations saved under other values are kept apart. The
  // defaults give '' (no suffix on the stored key).
  function translationProfile(settings) {
    const glossary = parseGlossary(settings?.glossary).map(({ source, target }) => `${source}=${target}`).join('\n');
    const fixAsr = settings?.fixAsr !== false;
    if (!glossary && fixAsr) return '';
    let hash = 0x811c9dc5;
    for (const char of `${fixAsr ? 1 : 0}\n${glossary}`) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36);
  }

  function listTranslationModels(settings) {
    const custom = [{ tier: 'ai', ...settings.ai }]
      .filter(({ tier, provider, model }) => !MODEL_CATALOG.some((entry) =>
        entry.tier === tier && entry.provider === provider && entry.model === model));
    return [...MODEL_CATALOG, ...custom]
      .filter((entry) => !settings.hiddenModels.includes(modelMenuKey(entry.tier, entry)));
  }

  function buildChatRequest(settings, keys, tier, messages) {
    if (tier !== 'ai') return { error: 'bad-tier' };
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

  // OpenRouter answers 402 when the balance cannot cover the request; a 402
  // about in-flight requests (sent with Retry-After) passes once they settle.
  function httpErrorCode(status, body, { retryAfter = false } = {}) {
    if (status === 402) {
      const metadata = body?.error?.metadata;
      const transient = retryAfter || metadata?.error_type === 'in_flight_budget_exhausted'
        || metadata?.limit_source === 'openrouter_in_flight_budget';
      return transient ? 'rate-limit' : 'credits';
    }
    if (status === 429) return 'rate-limit';
    return status === 401 || status === 403 ? 'bad-key' : `http-${status}`;
  }

  const AI_ERROR_REASONS = {
    credits: 'AI 帳戶餘額不足',
    budget: '已達本月 AI 費用上限',
    'rate-limit': 'AI 服務限制請求',
    'no-key': '尚未設定 API key',
    'bad-key': 'API key 無效或沒有權限',
    'bad-reply': 'AI 未回傳可用譯文',
    timeout: 'AI 回應逾時',
    network: '無法連線到 AI 服務',
    // An orphaned content script after the extension was reloaded.
    'send-failed': '擴充功能已更新，請重新整理頁面',
    'http-404': '找不到這個模型',
  };

  // Short reason for the fallback, shown in the menu and in notices.
  function describeAiError(code) {
    if (Object.hasOwn(AI_ERROR_REASONS, code)) return AI_ERROR_REASONS[code];
    const status = /^http-(\d+)$/.exec(code ?? '')?.[1];
    if (!status) return 'AI 暫時無法使用';
    if (status === '400') return 'AI 服務拒絕請求（HTTP 400，可能是模型名稱錯誤）';
    if (status.startsWith('5')) return `AI 服務暫時無法使用（HTTP ${status}）`;
    return `AI 服務錯誤（HTTP ${status}）`;
  }

  // An overloaded provider (502/503/504) usually
  // recovers within seconds, so those statuses are tried again after a pause.
  const RETRY_DELAYS_MS = [1000, 3000];
  const RETRY_STATUSES = new Set([502, 503, 504]);
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function fetchWithRetry(doFetch, { delays = RETRY_DELAYS_MS, wait = pause } = {}) {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch();
      if (res.ok || !RETRY_STATUSES.has(res.status) || attempt >= delays.length) return res;
      await wait(delays[attempt]);
    }
  }

  function fetchErrorCode(error) {
    return error && error.name === 'TimeoutError' ? 'timeout' : 'network';
  }

  const BASIC_LABEL = '基本（Chrome 內建）';

  // Human-readable tier label; AI tiers append the model's short name.
  function describeTier(settings, tier) {
    if (tier !== 'ai') return BASIC_LABEL;
    return describeModel(tier, settings[tier]);
  }

  function describeModel(tier, config) {
    const model = config.model;
    const short = model.slice(model.lastIndexOf('/') + 1);
    return `${TIER_LABELS[tier]} · ${short}`;
  }

  const api = {
    SETTINGS_KEY, KEYS_KEY, TIERS, TIER_LABELS, PROVIDERS, DEFAULT_SETTINGS, REQUEST_TIMEOUT_MS,
    MODEL_CATALOG, GLOSSARY_MAX_LENGTH, mergeSettings, parseGlossary, translationProfile,
    modelMenuKey, listTranslationModels, buildChatRequest,
    httpErrorCode, fetchWithRetry, fetchErrorCode, describeAiError, describeTier, describeModel,
  };
  globalThis.bceSettings = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
