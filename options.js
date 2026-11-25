// Options page: edits tier/model settings and API keys in chrome.storage.local.
(() => {
  'use strict';

  const {
    SETTINGS_KEY, KEYS_KEY, TIERS, TIER_LABELS, PROVIDERS, MODEL_CATALOG,
    mergeSettings, parseGlossary, modelMenuKey, describeModel, describeAiError,
  } = globalThis.bceSettings;
  const { createAiTranslator } = globalThis.bceAiTranslator;
  const { summarize, clearAll } = globalThis.bceTranslationStore;
  const { USAGE_KEY, mergeUsage, describeMonth, formatCost } = globalThis.bceUsage;
  const AI_TIERS = ['ai'];
  const AI_PROVIDER = 'openrouter';
  const SAMPLE_CAPTIONS = ['Welcome back to the channel.', 'Today we are going to try something new.'];

  const $ = (sel, root = document) => root.querySelector(sel);
  const modelCheckboxes = new Map();
  let dirty = false;
  let displayedForm;

  function buildForm() {
    const tiers = $('#tiers');
    for (const tier of TIERS) {
      const label = document.createElement('label');
      const radio = document.createElement('input');
      radio.type = 'radio';
      radio.name = 'tier';
      radio.value = tier;
      label.append(radio, ` ${TIER_LABELS[tier]}`);
      tiers.append(label);
    }
    for (const config of MODEL_CATALOG) {
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      const label = document.createElement('label');
      label.append(checkbox, ` ${describeModel(config.tier, config)}`);
      $('#menu-models').append(label);
      modelCheckboxes.set(modelMenuKey(config.tier, config), checkbox);
    }
  }

  function readForm() {
    const checked = $('input[name="tier"]:checked');
    const settings = { tier: checked ? checked.value : 'basic' };
    settings.hiddenModels = [...modelCheckboxes].filter(([, checkbox]) => !checkbox.checked).map(([key]) => key);
    for (const tier of AI_TIERS) {
      const box = $(`#${tier}`);
      settings[tier] = { provider: AI_PROVIDER, model: $('.model', box).value };
    }
    settings.glossary = $('#glossary').value;
    settings.fixAsr = $('#fix-asr').checked;
    settings.prefetchWhole = $('#prefetch-whole').checked;
    settings.monthlyLimit = Number.parseFloat($('#monthly-limit').value) || 0;
    const keys = { openrouter: $('#key-openrouter').value.trim() };
    return { settings: mergeSettings(settings), keys };
  }

  async function load() {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
    if (dirty && displayedForm) return;
    const settings = mergeSettings(stored[SETTINGS_KEY]);
    const keys = stored[KEYS_KEY] || {};
    $(`input[name="tier"][value="${settings.tier}"]`).checked = true;
    for (const tier of AI_TIERS) {
      $('.model', $(`#${tier}`)).value = settings[tier].model;
    }
    $('#key-openrouter').value = typeof keys.openrouter === 'string' ? keys.openrouter : '';
    $('#glossary').value = settings.glossary;
    $('#fix-asr').checked = settings.fixAsr;
    $('#prefetch-whole').checked = settings.prefetchWhole;
    $('#monthly-limit').value = settings.monthlyLimit ? String(settings.monthlyLimit) : '';
    void showUsage(settings.monthlyLimit);
    for (const [key, checkbox] of modelCheckboxes) checkbox.checked = !settings.hiddenModels.includes(key);
    displayedForm = readForm();
  }

  async function save() {
    const draft = readForm();
    const displayed = displayedForm;
    dirty = false;
    let settings;
    try {
      const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
      settings = mergeSettings(stored[SETTINGS_KEY]);
      // Keys of providers no longer supported (Gemini) are dropped on save.
      const keys = Object.fromEntries(Object.entries(stored[KEYS_KEY] ?? {})
        .filter(([provider]) => Object.hasOwn(PROVIDERS, provider)));
      if (draft.settings.tier !== displayed.settings.tier) settings.tier = draft.settings.tier;
      for (const tier of AI_TIERS) {
        if (modelMenuKey(tier, draft.settings[tier]) !== modelMenuKey(tier, displayed.settings[tier])) {
          settings[tier] = draft.settings[tier];
        }
      }
      const hidden = new Set(settings.hiddenModels);
      for (const model of modelCheckboxes.keys()) {
        const wasHidden = displayed.settings.hiddenModels.includes(model);
        const isHidden = draft.settings.hiddenModels.includes(model);
        if (isHidden && !wasHidden) hidden.add(model);
        if (!isHidden && wasHidden) hidden.delete(model);
      }
      settings.hiddenModels = [...hidden];
      // Only what was edited here; another tab may have changed the rest.
      for (const key of ['glossary', 'fixAsr', 'prefetchWhole', 'monthlyLimit']) {
        if (draft.settings[key] !== displayed.settings[key]) settings[key] = draft.settings[key];
      }
      for (const provider of Object.keys(PROVIDERS)) {
        if (draft.keys[provider] !== displayed.keys[provider]) keys[provider] = draft.keys[provider];
      }
      await chrome.storage.local.set({ [SETTINGS_KEY]: settings, [KEYS_KEY]: keys });
      if (dirty) displayedForm = draft;
    } catch (error) {
      dirty = true;
      throw error;
    }
    // Reflect merged values (e.g. an emptied model falls back to its default).
    await load();
    return settings;
  }

  async function test(tier, resultEl) {
    const translator = createAiTranslator({
      tier,
      getSentences: () => SAMPLE_CAPTIONS,
      getContext: () => ({ glossary: parseGlossary($('#glossary').value) }),
      send: (payload) => chrome.runtime.sendMessage(payload),
    });
    resultEl.textContent = '正在翻譯測試字幕…';
    try {
      await formReady;
      const saved = await save();
      const translations = await Promise.all(SAMPLE_CAPTIONS.map((line) => translator.translate(line)));
      resultEl.textContent = `${describeModel(tier, saved[tier])} 翻譯成功：${translations.join(' ')}`;
    } catch (error) {
      // HTTP reasons already name the status; others keep their code for reports.
      const code = error?.code;
      const detail = code && !code.startsWith('http-') ? `（${code}）` : '';
      resultEl.textContent = `測試失敗：${describeAiError(code)}${detail}。`;
    } finally {
      translator.destroy();
    }
  }

  // This month and the last month with use, against the saved limit.
  let shownLimit = 0;
  async function showUsage(limit = shownLimit) {
    shownLimit = limit;
    const summary = $('#usage-summary');
    try {
      const stored = await chrome.storage.local.get(USAGE_KEY);
      const { current, previous } = mergeUsage(stored[USAGE_KEY]);
      const lines = [`本月 · ${describeMonth(current)}`];
      if (limit > 0) {
        const left = Math.max(0, limit - current.cost);
        lines.push(current.cost >= limit
          ? `已達上限 ${formatCost(limit)}，AI 翻譯暫停中`
          : `上限 ${formatCost(limit)}，還剩 ${formatCost(left)}`);
      }
      if (previous) lines.push(`上次使用 · ${describeMonth(previous)}`);
      summary.replaceChildren(...lines.map((text, i) => {
        const line = document.createElement('div');
        line.textContent = text;
        if (i === 1 && limit > 0 && current.cost >= limit) line.className = 'over';
        return line;
      }));
    } catch {
      summary.textContent = '無法讀取 AI 用量。';
    }
  }

  buildForm();
  const formReady = load();
  formReady.catch(() => { $('#status').textContent = '無法讀取設定，請重新開啟設定頁。'; });
  document.addEventListener('input', () => { dirty = true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[USAGE_KEY]) void showUsage();
    if (!dirty && (changes[SETTINGS_KEY] || changes[KEYS_KEY])) void load();
  });

  $('#save').addEventListener('click', async () => {
    const status = $('#status');
    try {
      await formReady;
      await save();
      status.textContent = '已儲存';
    } catch {
      status.textContent = '無法儲存設定，請再試一次。';
    }
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  for (const tier of AI_TIERS) {
    const box = $(`#${tier}`);
    $('.test', box).addEventListener('click', () => test(tier, $('.result', box)));
  }

  const savedResult = $('.result', $('#saved'));
  async function showSaved() {
    try {
      const { videos, lines } = await summarize(chrome.storage.local);
      savedResult.textContent = videos ? `目前存有 ${videos} 部影片、${lines} 句譯文。` : '目前沒有已存的譯文。';
    } catch {
      savedResult.textContent = '無法讀取已存的譯文。';
    }
  }
  $('.clear', $('#saved')).addEventListener('click', async () => {
    try {
      await clearAll(chrome.storage.local);
      await showSaved();
    } catch {
      savedResult.textContent = '無法清除，請再試一次。';
    }
  });
  void showSaved();
})();
