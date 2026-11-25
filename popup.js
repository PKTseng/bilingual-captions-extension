// Toolbar popup: the captions switch, the source language, and what the
// YouTube tab in front is showing (asked of its content script).
(() => {
  'use strict';

  const { SOURCE_LANGUAGE_KEY, PREFERENCES, LANGUAGES, mergeSourceLanguage, normalizeLanguage } = globalThis.bceLanguages;
  const { SETTINGS_KEY, mergeSettings } = globalThis.bceSettings;
  const { USAGE_KEY, mergeUsage, formatCost } = globalThis.bceUsage;
  // Same key as content.js: every YouTube tab follows it.
  const ENABLED_KEY = 'bceCaptionsEnabled';
  const PREFERENCE_LABELS = { ...PREFERENCES, auto: '自動（跟著影片）' };

  const $ = (sel) => document.querySelector(sel);
  const enabled = $('#enabled');
  const language = $('#language');
  const status = $('#status');

  for (const [value, label] of Object.entries(PREFERENCE_LABELS)) {
    language.append(new Option(label, value));
  }

  function showLine(text) {
    const line = document.createElement('div');
    line.textContent = text;
    status.replaceChildren(line);
  }

  function showDetails(rows) {
    const list = document.createElement('dl');
    for (const [term, value] of rows) {
      if (!value) continue;
      const dt = document.createElement('dt');
      dt.textContent = term;
      const dd = document.createElement('dd');
      dd.textContent = value;
      list.append(dt, dd);
    }
    status.replaceChildren(list);
  }

  function render(report, tab) {
    if (!report) {
      const onWatchPage = /^https:\/\/www\.youtube\.com\/watch\b/.test(tab?.url ?? '');
      showLine(onWatchPage
        ? '這個分頁還沒載入雙語字幕，請重新整理頁面。'
        : '在 YouTube 影片頁會顯示字幕狀態。若已在影片頁，請重新整理頁面。');
      return;
    }
    if (!report.videoId) return showLine('打開一部 YouTube 影片後即可使用。');
    if (!report.enabled) return showLine('雙語字幕已關閉。');
    if (!report.running) return showLine(report.notice || '正在等候影片的字幕…');
    const code = normalizeLanguage(report.language);
    showDetails([
      ['原文', code && LANGUAGES[code].label],
      ['來源', report.source],
      ['翻譯', report.translation],
      ['提示', report.notice],
    ]);
  }

  async function refreshStatus() {
    let tab;
    let report;
    try {
      [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id !== undefined) report = await chrome.tabs.sendMessage(tab.id, { type: 'bce-status' });
    } catch {
      // No content script there: another site, or a tab opened before the extension loaded.
    }
    render(report, tab);
  }

  async function loadPreferences() {
    const stored = await chrome.storage.local.get([ENABLED_KEY, SOURCE_LANGUAGE_KEY]);
    enabled.checked = stored[ENABLED_KEY] === true;
    language.value = mergeSourceLanguage(stored[SOURCE_LANGUAGE_KEY]);
    enabled.disabled = false;
    language.disabled = false;
  }

  // This month's AI spending, once there is some or a limit is set.
  async function showUsage() {
    const usageLine = $('#usage');
    try {
      const stored = await chrome.storage.local.get([USAGE_KEY, SETTINGS_KEY]);
      const { current } = mergeUsage(stored[USAGE_KEY]);
      const limit = mergeSettings(stored[SETTINGS_KEY]).monthlyLimit;
      const over = limit > 0 && current.cost >= limit;
      usageLine.hidden = !current.requests && !limit;
      usageLine.classList.toggle('over', over);
      usageLine.textContent = `本月 AI 費用 ${formatCost(current.cost)}`
        + (limit > 0 ? `（上限 ${formatCost(limit)}${over ? '，已暫停 AI' : ''}）` : '');
    } catch {
      usageLine.hidden = true;
    }
  }

  async function save(values) {
    try {
      await chrome.storage.local.set(values);
    } catch {
      showLine('無法儲存，請再試一次。');
    }
  }

  enabled.addEventListener('change', () => void save({ [ENABLED_KEY]: enabled.checked }));
  language.addEventListener('change', () => void save({ [SOURCE_LANGUAGE_KEY]: mergeSourceLanguage(language.value) }));

  // The tab reacts to the change on its own; ask again once it has.
  let statusTimer;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes[ENABLED_KEY]) enabled.checked = changes[ENABLED_KEY].newValue === true;
    if (changes[SOURCE_LANGUAGE_KEY]) language.value = mergeSourceLanguage(changes[SOURCE_LANGUAGE_KEY].newValue);
    if (changes[USAGE_KEY] || changes[SETTINGS_KEY]) void showUsage();
    clearTimeout(statusTimer);
    statusTimer = setTimeout(refreshStatus, 600);
  });

  $('#options').addEventListener('click', () => {
    void chrome.runtime.openOptionsPage();
    window.close();
  });
  $('#welcome').addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') });
    window.close();
  });

  loadPreferences().catch(() => showLine('無法讀取設定，請重新開啟。'));
  void showUsage();
  void refreshStatus();
  // Captions keep loading while the popup is open.
  setInterval(refreshStatus, 2000);
})();
