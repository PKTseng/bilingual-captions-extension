// Options page: edits tier/model settings and API keys in chrome.storage.local.
(() => {
  'use strict';

  const { SETTINGS_KEY, KEYS_KEY, TIERS, TIER_LABELS, PROVIDERS, mergeSettings } = globalThis.bceSettings;
  const AI_TIERS = ['aiFree', 'aiPro'];

  const $ = (sel, root = document) => root.querySelector(sel);

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
    for (const tier of AI_TIERS) {
      const select = $('.provider', $(`#${tier}`));
      for (const [id, p] of Object.entries(PROVIDERS)) {
        select.append(new Option(p.label, id));
      }
    }
  }

  function readForm() {
    const checked = $('input[name="tier"]:checked');
    const settings = { tier: checked ? checked.value : 'basic' };
    for (const tier of AI_TIERS) {
      const box = $(`#${tier}`);
      settings[tier] = { provider: $('.provider', box).value, model: $('.model', box).value };
    }
    const keys = {
      openrouter: $('#key-openrouter').value.trim(),
      gemini: $('#key-gemini').value.trim(),
    };
    return { settings: mergeSettings(settings), keys };
  }

  async function load() {
    const stored = await chrome.storage.local.get([SETTINGS_KEY, KEYS_KEY]);
    const settings = mergeSettings(stored[SETTINGS_KEY]);
    const keys = stored[KEYS_KEY] || {};
    $(`input[name="tier"][value="${settings.tier}"]`).checked = true;
    for (const tier of AI_TIERS) {
      const box = $(`#${tier}`);
      $('.provider', box).value = settings[tier].provider;
      $('.model', box).value = settings[tier].model;
    }
    $('#key-openrouter').value = typeof keys.openrouter === 'string' ? keys.openrouter : '';
    $('#key-gemini').value = typeof keys.gemini === 'string' ? keys.gemini : '';
  }

  async function save() {
    const { settings, keys } = readForm();
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings, [KEYS_KEY]: keys });
    // Reflect merged values (e.g. an emptied model falls back to its default).
    await load();
  }

  async function test(tier, resultEl) {
    resultEl.textContent = '測試中…';
    try {
      await save();
      const res = await chrome.runtime.sendMessage({
        type: 'bce-ai',
        tier,
        messages: [{ role: 'user', content: '請只回覆：連線成功' }],
      });
      resultEl.textContent = res && res.ok ? res.text : `錯誤：${res ? res.error : 'no-response'}`;
    } catch {
      resultEl.textContent = '錯誤：no-response';
    }
  }

  buildForm();
  load();

  $('#save').addEventListener('click', async () => {
    const status = $('#status');
    await save();
    status.textContent = '已儲存';
    setTimeout(() => { status.textContent = ''; }, 2000);
  });

  for (const tier of AI_TIERS) {
    const box = $(`#${tier}`);
    $('.test', box).addEventListener('click', () => test(tier, $('.result', box)));
  }
})();
