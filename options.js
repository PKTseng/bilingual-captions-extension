// Options page: edits tier/model settings and API keys in chrome.storage.local.
(() => {
  'use strict';

  const {
    SETTINGS_KEY, KEYS_KEY, TIERS, TIER_LABELS, PROVIDERS, MODEL_CATALOG,
    mergeSettings, modelMenuKey, describeModel, describeAiError,
  } = globalThis.bceSettings;
  const { createAiTranslator } = globalThis.bceAiTranslator;
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

  buildForm();
  const formReady = load();
  formReady.catch(() => { $('#status').textContent = '無法讀取設定，請重新開啟設定頁。'; });
  document.addEventListener('input', () => { dirty = true; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (!dirty && area === 'local' && (changes[SETTINGS_KEY] || changes[KEYS_KEY])) void load();
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
})();
