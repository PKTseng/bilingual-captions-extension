(() => {
  'use strict';

  const NATIVE_CAPTIONS = '.ytp-caption-window-container';
  const CAPTION_LINES = '.caption-visual-line';
  let cache = new Map();
  // Captions as the AI corrected them (auto-generated ones), by original text.
  const corrections = new Map();
  const SENTENCE_END = /[.!?。！？]["'”’)\]」』）]*$/;
  const {
    SOURCE_LANGUAGE_KEY, TARGET_LANGUAGE, LANGUAGES, PREFERENCES, normalizeLanguage, mergeSourceLanguage,
    traitsOf, detectLanguage, describePreference,
  } = globalThis.bceLanguages;
  const segmenters = new Map();
  function segmenterFor(code) {
    if (!segmenters.has(code)) segmenters.set(code, new Intl.Segmenter(code, { granularity: 'word' }));
    return segmenters.get(code);
  }
  const chineseWords = segmenterFor(TARGET_LANGUAGE);
  const LIVE_GAP_MS = 900;
  const { sentenceCues, readTranscript, openTranscript } = globalThis.bceTranscript;
  const { requestTimedText, cachedTimedText, requestVideoDetails, cachedVideoDetails } = globalThis.bcePageBridge;
  const {
    TIER_LABELS, SETTINGS_KEY, KEYS_KEY, REQUEST_TIMEOUT_MS, mergeSettings, describeTier, describeModel, describeAiError,
    modelMenuKey, listTranslationModels, parseGlossary, translationProfile,
  } = globalThis.bceSettings;
  const { createAiTranslator, CONTEXT_SIZE, isTransientError } = globalThis.bceAiTranslator;
  // AI translations saved per video and model; the built-in one is free and local.
  const translationStore = globalThis.bceTranslationStore.createTranslationStore({ area: chrome.storage.local });
  const PASSING_NOTICE_MS = 6000;
  // The translator already retried a failed batch; this many failures in a
  // row (with a growing pause between them) still end in the fallback.
  const AI_FAILURE_LIMIT = 3;
  const AI_RETRY_PAUSE_MS = 4000;
  // Allow one request and a retry before falling back for a still-visible line.
  const VISIBLE_AI_TIMEOUT_MS = 2 * REQUEST_TIMEOUT_MS;
  // How far ahead lines are translated. AI batches take seconds and may be
  // retried, so they start further ahead than the built-in translator.
  const LOOKAHEAD = { basic: { seconds: 60, cues: 15 }, ai: { seconds: 150, cues: 60 } };
  // After this much playback, AI translates the rest of the video in the
  // background (settings.prefetchWhole): a video watched this long is likely
  // watched on, and seeking anywhere then needs no wait.
  const PREFETCH_AFTER_MS = 60000;
  let tier = 'basic';
  const ENABLED_KEY = 'bceCaptionsEnabled';
  let captionsEnabled;
  let preferencesReady = false;
  // Infinity after a start attempt, unless the player's caption sources are still loading.
  let nextStartAt = 0;
  let nextDetailsAt = 0;
  const DISPLAY_MODE_KEY = 'bceCaptionDisplayMode';
  const DISPLAY_MODES = { bilingual: '雙語', chinese: '只顯示中文', original: '只顯示原文' };
  let displayMode = 'bilingual';
  const FONT_SIZE_KEY = 'bceCaptionFontPercent';
  const FONT_SIZES = [75, 100, 125, 150, 200];
  const DEFAULT_FONT_PERCENT = 125;
  let fontPercent = DEFAULT_FONT_PERCENT;
  // 'auto' or a language code (languages.js); the job's `language` is the one in use.
  let sourcePreference = 'auto';
  let gameOverride;
  let gameDictionary;
  const usesGameTerms = (details) => gameOverride ?? globalThis.bceSevenKnights.isGame(details);

  function loadGameDictionary() {
    gameDictionary ??= chrome.runtime.sendMessage({ type: 'bce-seven-knights-terms' })
      .then((pack) => globalThis.bceSevenKnights.prepare(pack))
      .catch((error) => {
        gameDictionary = undefined;
        throw error;
      });
    return gameDictionary;
  }
  // Only the tier and model names are read here (SETTINGS_KEY), never API keys.
  let settings = mergeSettings();
  // Until the page reloads or the keys change: an exhausted balance (402)
  // covers every model of that provider.
  const creditLimitedProviders = new Set();
  // This month's AI spending reached the limit set in the options (every
  // model), until the limit is changed or the page reloads.
  let budgetReached = false;
  let videoId;
  let player;
  let job;
  let imported = [];
  let currentText = '';
  let restoreCc;
  let advanceSeconds = 0;
  let importedSource = '';
  let importedLanguage = 'en';
  let displayedCue;
  // The caption text on the card as the cues have it (the card may show the
  // AI's corrected version); translations are looked up by it.
  let shownText = '';

  function element(tag, className, text) {
    const item = document.createElement(tag);
    item.className = className;
    if (text) item.textContent = text;
    return item;
  }

  const toggle = element('button', 'bce-toggle');
  toggle.type = 'button';
  const toggleLabel = element('span', 'bce-toggle-label', 'Dual');
  toggleLabel.lang = 'en';
  const toggleSource = element('span', 'bce-toggle-source');
  toggle.append(toggleLabel, toggleSource);
  const overlay = element('div', 'bce-overlay');
  const card = element('div', 'bce-card');
  const original = element('div', 'bce-line bce-original');
  const translation = element('div', 'bce-line bce-translation');
  original.lang = 'en';
  translation.lang = 'zh-Hant';
  card.append(original, translation);
  // The replay button sits in the stage's left padding, right against the
  // card, so the pointer can move onto it without leaving the hover area.
  const stage = element('div', 'bce-stage');
  const replay = element('button', 'bce-replay');
  replay.type = 'button';
  replay.title = '重播這句';
  replay.setAttribute('aria-label', '重播這句');
  replay.hidden = true;
  replay.append(element('span', 'bce-replay-icon')); // Drawn in subtitles.css.
  stage.append(card, replay);
  const copied = element('div', 'bce-copied');
  const AI_READY_MESSAGE = '已切換為 AI 翻譯';
  copied.setAttribute('role', 'status');
  overlay.append(copied, stage);
  overlay.hidden = true;

  const notice = element('div', 'bce-notice');
  const message = element('div', 'bce-message');
  message.setAttribute('role', 'status');
  const importButton = element('button', 'bce-import', '匯入原文 SRT／VTT');
  importButton.type = 'button';
  const downloadButton = element('button', 'bce-download');
  downloadButton.type = 'button';
  downloadButton.hidden = true;
  const fileInput = element('input', '');
  fileInput.type = 'file';
  fileInput.accept = '.srt,.vtt';
  fileInput.hidden = true;
  const closeNotice = element('button', 'bce-notice-close', '×');
  closeNotice.type = 'button';
  closeNotice.title = '關閉提示';
  closeNotice.setAttribute('aria-label', '關閉提示');
  notice.append(closeNotice, message, downloadButton, importButton, fileInput);
  notice.hidden = true;
  closeNotice.addEventListener('click', () => {
    clearTimeout(noticeTimer);
    notice.hidden = true;
  });
  // Marks this version's elements; subtitles.css hides unmarked ones left by
  // an older copy of the extension that is still loaded in Chrome.
  for (const item of [toggle, overlay, notice]) item.dataset.bce = 'current';
  let retired = false;

  let noticeTimer;
  function setNotice(text) {
    clearTimeout(noticeTimer);
    message.textContent = text;
    importButton.hidden = !downloadButton.hidden;
    notice.hidden = !text && downloadButton.hidden;
  }

  // A notice that goes away by itself, unless something replaced it.
  function setPassingNotice(text) {
    setNotice(text);
    noticeTimer = setTimeout(() => {
      if (message.textContent === text) setNotice('');
    }, PASSING_NOTICE_MS);
  }

  // ---- Player menu ----
  // The player icon opens this panel, modelled on YouTube's settings menu: a
  // main page and its sub-pages. renderMenu() rebuilds
  // the open page from the shared state; updateMenu() does so if it is open.
  const menu = element('div', 'bce-menu');
  menu.id = 'bce-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '雙語字幕選單');
  menu.dataset.bce = 'current';
  menu.hidden = true;
  let menuPage = 'main';
  toggle.setAttribute('aria-haspopup', 'menu');
  toggle.setAttribute('aria-controls', menu.id);
  toggle.setAttribute('aria-expanded', 'false');

  const hasTiming = () => Boolean(job?.cues.length || imported.length);

  function aiModelKey(name, config = settings[name]) {
    return config && `${config.provider}/${config.model}`;
  }

  // 'credits' or 'budget' when this AI model is known not to answer now.
  function usageLimit(name, config = settings[name]) {
    if (!config) return undefined;
    if (budgetReached) return 'budget';
    return creditLimitedProviders.has(config.provider) ? 'credits' : undefined;
  }

  const languageLabel = (code) => LANGUAGES[normalizeLanguage(code) ?? 'en'].label;

  function tierValue() {
    const selected = describeTier(settings, tier);
    if (tier === 'basic' && job?.fallbackCode === 'unsupported-pair') {
      return `${selected}\n不支援${languageLabel(job.language)}，僅顯示原文`;
    }
    if (!job?.fellBack || tier === 'basic') return selected;
    const status = job.fellBack === 'english'
      ? (displayMode === 'chinese' ? '暫無中文譯文' : '僅顯示原文') : '改用 Chrome 內建';
    return `${selected}\n${describeAiError(job.fallbackCode)}，${status}`;
  }

  function timingValue() {
    if (advanceSeconds === 0) return '原始';
    return `${advanceSeconds > 0 ? '提早' : '延後'} ${Math.abs(advanceSeconds).toFixed(1)} 秒`;
  }

  function sourceValue() {
    const source = job?.source ?? importedSource;
    if (!source) return '尚未選擇字幕來源';
    const detail = !hasTiming() && source === '即時 CC' ? '等字幕送到才能合句，可匯入 SRT 使用時間碼' : '';
    return `字幕來源：${source}${detail ? ` · ${detail}` : ''}`;
  }

  function glyph(className, text) {
    const item = element('span', className, text);
    item.setAttribute('aria-hidden', 'true');
    return item;
  }

  function menuItem(key, label, action, { role = 'menuitem', value, next, checked, disabled } = {}) {
    const item = element('button', 'bce-menu-item');
    item.type = 'button';
    item.dataset.key = key;
    item.setAttribute('role', role);
    if (checked !== undefined) item.setAttribute('aria-checked', String(checked));
    if (next) item.setAttribute('aria-haspopup', 'menu');
    item.disabled = Boolean(disabled);
    item.append(element('span', 'bce-menu-label', label));
    if (value) item.append(element('span', 'bce-menu-value', value));
    if (next) item.append(glyph('bce-menu-next', '›'));
    item.addEventListener('click', action);
    return item;
  }

  function backItem(label, value) {
    const item = menuItem('back', label, () => showMenuPage('main'), { value });
    item.classList.add('bce-menu-back');
    item.setAttribute('aria-label', `返回：${label}${value ? `，${value}` : ''}`);
    item.prepend(glyph('bce-menu-prev', '‹'));
    return item;
  }

  function mainPage() {
    const onOff = menuItem('switch', '雙語字幕', toggleCaptions,
      { role: 'menuitemcheckbox', checked: Boolean(captionsEnabled), disabled: !preferencesReady });
    onOff.append(glyph('bce-menu-switch'));
    return [
      onOff,
      menuItem('display-mode', '字幕顯示', () => showMenuPage('display-mode'),
        { value: DISPLAY_MODES[displayMode], next: true }),
      menuItem('source-language', '原文語言', () => showMenuPage('source-language'),
        { value: describePreference(sourcePreference, job?.language), next: true }),
      menuItem('tier', '翻譯', () => showMenuPage('tier'), { value: tierValue(), next: true }),
      ...(tier === 'ai' ? [gameGlossaryItem()] : []),
      menuItem('font-size', '字幕大小', () => showMenuPage('font-size'),
        { value: `${fontPercent}%`, next: true }),
      menuItem('timing', '字幕時間', () => showMenuPage('timing'),
        { value: timingValue(), next: true, disabled: !hasTiming() }),
      menuItem('import', '匯入原文 SRT／VTT', () => {
        closeMenu(true);
        fileInput.click();
      }),
      menuItem('options', 'API key 與模型設定…', () => {
        closeMenu(true);
        openOptions();
      }),
      element('div', 'bce-menu-source', sourceValue()),
    ];
  }

  // The switch itself happens in onSettingsChanged, so the options page and
  // other tabs follow the same tier; chooseTier retries an AI tier that fell back.
  function gameGlossaryItem() {
    const details = job?.details ?? cachedVideoDetails(videoId, sourcePreference) ?? { title: document.title };
    const enabled = usesGameTerms(details);
    return menuItem('game-glossary', '本片七騎士詞表', () => {
      gameOverride = !enabled;
      cache.clear();
      corrections.clear();
      if (job) {
        stop();
        nextStartAt = 0;
        syncPage();
      }
      updateMenu();
    }, { role: 'menuitemcheckbox', checked: enabled, value: enabled ? '開啟' : '關閉' });
  }

  function tierPage() {
    const choices = [{ tier: 'basic' }, ...listTranslationModels(settings)];
    return [
      backItem('翻譯'),
      ...choices.map(({ tier: name, provider, model }) => {
        const config = name === 'basic' ? undefined : { provider, model };
        const key = config ? modelMenuKey(name, config) : 'tier-basic';
        const label = config ? describeModel(name, config) : describeTier(settings, name);
        const modelKey = aiModelKey(name, config);
        const limit = usageLimit(name, config);
        const item = menuItem(key, label, () => {
          void chooseTier(name, config);
          showMenuPage('main');
        }, {
          role: 'menuitemradio', checked: tier === name && modelKey === aiModelKey(name),
          disabled: Boolean(limit),
          value: limit === 'budget' ? '已達本月上限' : limit ? '餘額不足' : undefined,
        });
        item.prepend(glyph('bce-menu-check'));
        return item;
      }),
    ];
  }

  function applyDisplayMode(value) {
    const next = typeof value === 'string' && Object.hasOwn(DISPLAY_MODES, value) ? value : 'bilingual';
    if (next === displayMode) return;
    const previous = displayMode;
    displayMode = next;
    original.hidden = next === 'chinese';
    translation.hidden = next === 'original';
    if (job && next === 'original') {
      releasePreview(job);
      releaseTranslator(job);
      if (job.fellBack) cache.clear();
      job.fellBack = undefined;
      job.showingSelected = false;
      setNotice('');
    } else if (job && previous === 'original') {
      setTranslation(cache.get(shownText));
      void startSelectedTranslator(job);
    } else if (job?.fellBack === 'english') {
      setTranslation(cache.get(shownText));
    }
    updateToggle();
  }

  async function chooseDisplayMode(mode) {
    applyDisplayMode(mode);
    try {
      await chrome.storage.local.set({ [DISPLAY_MODE_KEY]: mode });
    } catch {
      setPassingNotice('無法儲存字幕顯示模式，請重新整理頁面。');
    }
  }

  function displayModePage() {
    return [
      backItem('字幕顯示'),
      ...Object.entries(DISPLAY_MODES).map(([mode, label]) => {
        const item = menuItem(`display-${mode}`, label, () => {
          void chooseDisplayMode(mode);
          showMenuPage('main');
        }, { role: 'menuitemradio', checked: mode === displayMode });
        item.prepend(glyph('bce-menu-check'));
        return item;
      }),
    ];
  }

  // A new choice needs another caption track, so a running job starts over.
  // An imported file keeps its own language.
  function applySourcePreference(value) {
    const next = mergeSourceLanguage(value);
    if (next === sourcePreference) return;
    sourcePreference = next;
    updateMenu();
    if (!job || imported.length) return;
    stop();
    nextStartAt = 0;
    syncPage();
  }

  async function chooseSourceLanguage(value) {
    applySourcePreference(value);
    try {
      await chrome.storage.local.set({ [SOURCE_LANGUAGE_KEY]: value });
    } catch {
      setPassingNotice('無法儲存原文語言，請重新整理頁面。');
    }
  }

  function sourceLanguagePage() {
    return [
      backItem('原文語言'),
      ...Object.entries(PREFERENCES).map(([value, label]) => {
        const item = menuItem(`source-${value}`, value === 'auto' ? '自動（跟著影片）' : label, () => {
          void chooseSourceLanguage(value);
          showMenuPage('main');
        }, { role: 'menuitemradio', checked: value === sourcePreference });
        item.prepend(glyph('bce-menu-check'));
        return item;
      }),
    ];
  }

  function applyFontSize(value) {
    fontPercent = FONT_SIZES.includes(value) ? value : DEFAULT_FONT_PERCENT;
    card.style.setProperty('--bce-font-scale', String(fontPercent / 100));
  }

  async function saveFontSize(percent) {
    applyFontSize(percent);
    updateMenu();
    try {
      await chrome.storage.local.set({ [FONT_SIZE_KEY]: percent });
    } catch {
      setPassingNotice('無法儲存字幕大小，請重新整理頁面。');
    }
  }

  function fontSizePage() {
    return [
      backItem('字幕大小'),
      ...FONT_SIZES.map((percent) => {
        const label = `${percent}%${percent === DEFAULT_FONT_PERCENT ? '（預設）' : ''}`;
        const item = menuItem(`font-size-${percent}`, label, () => {
          void saveFontSize(percent);
          showMenuPage('main');
        }, { role: 'menuitemradio', checked: percent === fontPercent });
        item.prepend(glyph('bce-menu-check'));
        return item;
      }),
    ];
  }

  function timingPage() {
    return [
      backItem('字幕時間', timingValue()),
      menuItem('earlier', '提早 0.5 秒', () => shiftTiming(0.5), { disabled: advanceSeconds >= 10 }),
      menuItem('later', '延後 0.5 秒', () => shiftTiming(-0.5), { disabled: advanceSeconds <= -10 }),
      menuItem('reset', '重設', () => {
        advanceSeconds = 0;
        refresh();
        updateMenu();
      }),
    ];
  }

  const firstMenuItem = () => menu.querySelector('button:not(:disabled)');

  // Rebuilding drops the focused row, so focus goes back to the row with the
  // same key (or `preferKey`), else the first enabled one.
  function renderMenu(preferKey) {
    const focused = menu.contains(document.activeElement) ? document.activeElement.dataset.key : undefined;
    if (menuPage === 'timing' && !hasTiming()) menuPage = 'main';
    menu.replaceChildren(...(menuPage === 'tier' ? tierPage()
      : menuPage === 'display-mode' ? displayModePage()
      : menuPage === 'source-language' ? sourceLanguagePage()
      : menuPage === 'font-size' ? fontSizePage()
      : menuPage === 'timing' ? timingPage() : mainPage()));
    const key = preferKey ?? focused;
    if (focused !== undefined) {
      const selected = Array.from(menu.querySelectorAll('button:not(:disabled)'))
        .find((item) => item.dataset.key === key);
      (selected ?? firstMenuItem())?.focus();
    }
    placeMenu();
  }

  function updateMenu() {
    if (!menu.hidden) renderMenu();
  }

  // Back on the main page, the row that opened the sub-page keeps focus.
  function showMenuPage(page) {
    const from = menuPage;
    menuPage = page;
    renderMenu(page === 'main' ? from : undefined);
  }

  function openMenu(fromKeyboard) {
    syncPage();
    if (retired || !player) return;
    if (menu.parentNode !== player) player.append(menu);
    menuPage = 'main';
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    renderMenu();
    if (fromKeyboard) firstMenuItem()?.focus();
  }

  function closeMenu(focusToggle) {
    if (menu.hidden) return;
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
    if (focusToggle && toggle.isConnected) toggle.focus();
  }

  // Above the controls, right edge lined up with the icon, inside the player.
  function placeMenu() {
    if (menu.hidden || !player || menu.parentNode !== player) return;
    const box = player.getBoundingClientRect();
    const bar = player.querySelector('.ytp-chrome-bottom');
    const barTop = bar?.getClientRects().length ? bar.getBoundingClientRect().top : box.bottom - 48;
    const bottom = Math.max(12, Math.round(box.bottom - barTop) + 12);
    const icon = toggle.isConnected && toggle.getClientRects().length ? toggle.getBoundingClientRect() : undefined;
    const right = Math.max(12, Math.min(icon ? Math.round(box.right - icon.right) : 12,
      player.clientWidth - menu.offsetWidth - 12));
    for (const [name, value] of [['--bce-menu-bottom', `${bottom}px`], ['--bce-menu-right', `${right}px`]]) {
      if (menu.style.getPropertyValue(name) !== value) menu.style.setProperty(name, value);
    }
  }

  function openOptions() {
    try {
      chrome.runtime.sendMessage({ type: 'bce-open-options' })?.catch?.(() => {});
    } catch {
      setPassingNotice('無法打開設定頁，請重新整理頁面。');
    }
  }

  // A keyboard press on the icon (detail 0) moves focus into the menu.
  // Opening or closing the menu never starts or stops the captions.
  toggle.addEventListener('click', (event) => {
    if (menu.hidden) openMenu(event.detail === 0);
    else closeMenu(false);
  });
  // Capture phase, so this runs before YouTube handles the press.
  document.addEventListener('pointerdown', (event) => {
    if (menu.hidden || menu.contains(event.target) || toggle.contains(event.target)) return;
    closeMenu(false);
    // Like YouTube's own settings menu, a press on the video that closes the
    // menu does nothing else (no play/pause). YouTube's controls, our own UI
    // and anything outside the player keep the normal press.
    const target = event.target;
    if (!(target instanceof Element) || !player?.contains(target)
      || target.closest('.ytp-chrome-top, .ytp-chrome-bottom, [class*="ytp-popup"], [class*="bce-"]')) return;
    event.preventDefault();
    event.stopPropagation();
    const swallow = (clickEvent) => {
      if (clickEvent.type === 'click' && !player?.contains(clickEvent.target)) return;
      release();
      if (clickEvent.type !== 'click') return;
      clickEvent.stopPropagation();
      clickEvent.preventDefault();
    };
    const timer = setTimeout(release, 600);
    function release() {
      clearTimeout(timer);
      window.removeEventListener('click', swallow, true);
      window.removeEventListener('pointercancel', swallow, true);
    }
    window.addEventListener('click', swallow, true);
    window.addEventListener('pointercancel', swallow, true);
  }, true);
  document.addEventListener('keydown', (event) => {
    if (menu.hidden || event.key !== 'Escape') return;
    event.stopPropagation();
    closeMenu(true);
  }, true);
  menu.addEventListener('keydown', (event) => {
    const active = document.activeElement;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const items = [...menu.querySelectorAll('button:not(:disabled)')];
      const index = items.indexOf(active);
      const step = event.key === 'ArrowDown' ? 1 : -1;
      items[index < 0 ? (step > 0 ? 0 : items.length - 1) : (index + step + items.length) % items.length]?.focus();
    } else if (event.key === 'ArrowLeft' && menuPage !== 'main') {
      event.preventDefault();
      showMenuPage('main');
    } else if (event.key === 'ArrowRight' && menu.contains(active) && active.getAttribute('aria-haspopup')) {
      event.preventDefault();
      active.click();
    }
  });
  // Like the caption card, clicks and keys on the menu must not reach the
  // player (play/pause, fullscreen, shortcuts). Pointer movement does reach
  // it, so YouTube keeps its controls up while the pointer moves on the menu.
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
    'contextmenu', 'keydown', 'keyup', 'keypress']) {
    menu.addEventListener(type, (event) => event.stopPropagation());
  }
  // ---- End of player menu ----

  function shiftTiming(amount) {
    advanceSeconds = Math.max(-10, Math.min(10, advanceSeconds + amount));
    updateMenu();
    refresh();
  }

  function updateToggle() {
    toggle.setAttribute('aria-pressed', String(Boolean(captionsEnabled)));
    updateSourceIndicator();
    updateMenu();
  }

  function updateSourceIndicator() {
    if (copied.textContent === AI_READY_MESSAGE
      && (!job?.aiReadyAnnounced || job.fellBack || tier !== 'ai' || translation.hidden)) {
      copied.classList.remove('bce-visible');
      copied.textContent = '';
    }
    let label = '';
    let detail = '';
    let waiting = false;
    if (job) {
      if (displayMode === 'original' || job.fellBack === 'english') {
        label = displayMode === 'chinese' ? '無中文' : '原文';
        detail = job.fellBack === 'english' ? '翻譯無法使用' : '只顯示原文';
      } else {
        const basic = tier === 'basic' || job.fellBack === 'basic';
        const source = basic ? 'Chrome 內建翻譯' : describeTier(settings, tier);
        waiting = !job.showingSelected;
        label = (basic ? 'Chrome' : 'AI') + (waiting ? '…' : '');
        detail = waiting ? `等候${source}的譯文` : `字幕來源為 ${source}`;
      }
    }
    const title = detail ? `雙語字幕選單（${detail}）` : '雙語字幕選單';
    if (toggle.title === title && toggleSource.textContent === label) return;
    toggleSource.textContent = label;
    toggleSource.classList.toggle('bce-waiting', waiting);
    toggle.title = title;
    toggle.setAttribute('aria-label', title);
  }

  function clearOverlay() {
    if (job && held) return;
    overlay.classList.remove('bce-shown');
  }

  // While the pointer is on the card (or a selection drag that began there is
  // still going), the sentence stays put so a word or phrase can be picked out
  // of it; the video keeps playing and the caption catches up afterwards.
  let held = false;
  let hovering = false;
  let pressing = false;

  function selectionInCard() {
    const selection = getSelection();
    return selection.rangeCount && !selection.isCollapsed
      && card.contains(selection.getRangeAt(0).commonAncestorContainer)
      ? selection.toString().replace(/\s+/g, ' ').trim() : '';
  }

  function updateHeld() {
    const next = Boolean(job) && (hovering || pressing);
    if (next === held) return;
    held = next;
    if (held) return;
    if (selectionInCard()) getSelection().removeAllRanges();
    if (!job) return;
    clearOverlay();
    currentText = '';
    job.live.shown = '';
    refresh();
    placeOverlay();
  }

  let copiedTimer;
  function flashStatus(text, duration = 1400) {
    copied.textContent = text;
    copied.classList.add('bce-visible');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => copied.classList.remove('bce-visible'), duration);
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const put = (event) => {
        event.clipboardData.setData('text/plain', text);
        event.preventDefault();
      };
      document.addEventListener('copy', put, { once: true });
      const done = document.execCommand('copy');
      document.removeEventListener('copy', put);
      if (!done) return;
    }
    flashStatus(`已複製：${text}`);
  }

  // Starts the sentence on the card over, a moment before its first word so
  // that word is not clipped. The timing shift moves captions, not the video,
  // so it is taken back out here.
  const REPLAY_LEAD_SECONDS = 0.2;
  function replaySentence() {
    const cue = displayedCue;
    const video = player?.querySelector('video');
    if (!job || !cue || !video) return;
    video.currentTime = Math.max(0, cue.start - advanceSeconds - REPLAY_LEAD_SECONDS);
    if (video.paused) void video.play().catch(() => {});
    flashStatus('從句首重播');
  }

  // A selection drag copies what was selected (double/triple click selects a
  // word/the line natively); a plain click copies the word under the pointer.
  function copyFromPointer(event) {
    if (event.button !== 0) return;
    const selected = selectionInCard();
    const word = event.target instanceof Element && card.contains(event.target)
      ? event.target.closest('.bce-word') : null;
    const text = selected || word?.textContent;
    if (text) void copyText(text);
    if (!selected && word) {
      word.classList.remove('bce-flash');
      void word.offsetWidth;
      word.classList.add('bce-flash');
    }
  }

  // The stage holds the card and the replay button, so moving between the two
  // keeps the sentence held.
  stage.addEventListener('pointerenter', () => {
    hovering = true;
    updateHeld();
  });
  stage.addEventListener('pointerleave', () => {
    hovering = false;
    updateHeld();
  });
  // A mouse click must not leave focus on the button, or Space (YouTube's
  // play/pause) would press it again; keyboard focus still works.
  replay.addEventListener('mousedown', (event) => event.preventDefault());
  replay.addEventListener('click', replaySentence);
  // Enter or Space on the focused button must not also reach YouTube's hotkeys.
  for (const type of ['keydown', 'keyup', 'keypress']) {
    replay.addEventListener(type, (event) => event.stopPropagation());
  }
  card.addEventListener('mousedown', (event) => {
    if (event.button === 0) pressing = true;
    updateHeld();
  });
  document.addEventListener('mouseup', (event) => {
    if (!pressing) return;
    pressing = false;
    copyFromPointer(event);
    updateHeld();
  }, true);
  // Keep the player from treating clicks on the card as play/pause or
  // fullscreen, and from popping its controls up under the pointer; right
  // click gets the browser's own menu (with Copy) instead of YouTube's.
  for (const type of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'mouseup',
    'mousemove', 'mouseover', 'mouseout', 'click', 'dblclick', 'contextmenu']) {
    stage.addEventListener(type, (event) => event.stopPropagation());
    notice.addEventListener(type, (event) => event.stopPropagation());
  }

  function stop(resetNotice = true) {
    const previous = job;
    job = undefined;
    clearTimeout(noticeTimer);
    hovering = pressing = held = false;
    if (previous) {
      releasePreview(previous);
      releaseTranslator(previous);
      if (previous.fellBack) cache.clear();
    }
    currentText = '';
    clearOverlay();
    player?.classList.remove('bce-replaces-native');
    restoreCc?.();
    restoreCc = undefined;
    if (resetNotice) setNotice('');
    updateToggle();
  }

  const idFromUrl = () => location.pathname === '/watch'
    ? new URLSearchParams(location.search).get('v')
    : null;

  function onCaptionShortcut(event) {
    if (event.ctrlKey || event.metaKey || event.isComposing || event.defaultPrevented || !player) return;
    const toggleShortcut = event.altKey && event.code === 'KeyC' && !event.shiftKey;
    const resizeCaptions = job && !event.altKey && ['+', '-', '0'].includes(event.key);
    if ((!toggleShortcut && !resizeCaptions) || !idFromUrl()) return;

    const target = event.composedPath()[0];
    if (target instanceof Element && (target.isContentEditable || target.closest('input, textarea, select'))) return;

    event.preventDefault();
    event.stopPropagation();
    if (toggleShortcut) {
      // Start within the key press so Chrome can download the translation model.
      if (!event.repeat) void toggleCaptions();
      return;
    }
    const index = FONT_SIZES.indexOf(fontPercent);
    const next = event.key === '0' ? DEFAULT_FONT_PERCENT : FONT_SIZES[index + (event.key === '+' ? 1 : -1)];
    if (next !== undefined && next !== fontPercent) void saveFontSize(next);
  }

  // Subtitles sit near the bottom of the video, and move up to clear the
  // progress bar and controls (with a small gap) while YouTube shows them.
  const CONTROLS_GAP = 12;
  let placedBottom;
  function placeOverlay() {
    if (!player || overlay.parentNode !== player || held) return;
    const height = player.clientHeight;
    let bottom = Math.max(10, Math.round(height * 0.03));
    const controlsShown = !player.classList.contains('ytp-autohide')
      && !player.classList.contains('ytp-hide-controls');
    if (controlsShown) {
      const playerBottom = player.getBoundingClientRect().bottom;
      for (const selector of ['.ytp-chrome-bottom', '.ytp-progress-bar-container']) {
        const bar = player.querySelector(selector);
        if (bar?.getClientRects().length) {
          bottom = Math.max(bottom, Math.round(playerBottom - bar.getBoundingClientRect().top) + CONTROLS_GAP);
        }
      }
    }
    if (bottom === placedBottom) return;
    placedBottom = bottom;
    overlay.style.setProperty('--bce-bottom', `${bottom}px`);
  }

  function syncPage() {
    if (retired) return;
    const nextId = idFromUrl();
    const nextPlayer = nextId ? document.querySelector('#movie_player') : null;
    if (nextId !== videoId || nextPlayer !== player) {
      closeMenu(false);
      stop();
      if (nextId !== videoId) {
        gameOverride = undefined;
        cache.clear();
        corrections.clear();
        imported = [];
        importedSource = '';
        advanceSeconds = 0;
        guardedVideo = nextId ?? undefined;
      }
      toggle.remove();
      overlay.remove();
      notice.remove();
      menu.remove();
      videoId = nextId;
      player = nextPlayer;
      nextStartAt = 0;
    }
    if (!player) return;
    // Asked ahead of time, so begin() already knows the video's language.
    // The page only answers once the player has this video's data.
    if (captionsEnabled && videoId && !cachedVideoDetails(videoId, sourcePreference)
      && performance.now() >= nextDetailsAt) {
      nextDetailsAt = performance.now() + 1000;
      void requestVideoDetails(videoId, sourcePreference);
    }
    const controls = player.querySelector('.ytp-right-controls');
    if (controls && toggle.parentNode !== controls) controls.prepend(toggle);
    if (overlay.parentNode !== player) player.append(overlay, notice);
    if (menu.parentNode !== player) player.append(menu);
    placeOverlay();
    placeMenu();
    if (preferencesReady && captionsEnabled && !job && performance.now() >= nextStartAt) {
      const video = player.querySelector('video');
      if (video && video.readyState !== 0) void begin(video);
    }
  }

  // CC that was already on before this script loaded won't request again by
  // itself; switching it off and on makes the player fetch captions again.
  async function nudgeCaptions(active) {
    if (job !== active || idFromUrl() !== videoId) return;
    const cc = player?.querySelector('.ytp-subtitles-button');
    if (cc?.getAttribute('aria-pressed') !== 'true') return;
    cc.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (job === active && idFromUrl() === videoId && cc.isConnected && cc.getAttribute('aria-pressed') === 'false') cc.click();
  }

  async function loadTimedText(active) {
    const id = videoId;
    const timed = await requestTimedText(id, active.ccWasOn ? () => nudgeCaptions(active) : undefined,
      active.preference);
    if (job !== active || idFromUrl() !== id) return;
    if (!timed) {
      if (!active.cues.length && openTranscript()) active.transcriptUntil = performance.now() + 2600;
      return;
    }
    active.languageSettled = true;
    active.waitingForSource = false;
    setJobLanguage(active, timed.language, timed.asr);
    active.cues = timed.cues;
    active.source = timed.source;
    active.fillGaps = false;
    active.transcriptUntil = 0;
    active.inFlight?.controller.abort();
    currentText = '';
    clearOverlay();
    updateMenu();
    refresh();
  }

  function readNativeCaption(expected) {
    const container = player?.querySelector(NATIVE_CAPTIONS);
    if (!container || !container.getClientRects().length) return '';
    const lines = [...container.querySelectorAll(CAPTION_LINES)]
      .map((line) => line.textContent.trim()).filter(Boolean);
    const text = lines.length ? lines.join('\n') : [...container.querySelectorAll('.ytp-caption-segment')]
      .map((part) => part.textContent.trim()).filter(Boolean).join(' ');
    return matchesSource(text, expected) ? text : '';
  }

  function cueIndexAt(cues, time) {
    let lo = 0;
    let hi = cues.length;
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (cues[mid].start <= time) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  }

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const EASE = 'cubic-bezier(.2, .8, .2, 1)';

  // Runs a content change, then eases the card from its old size to the new
  // one instead of letting it snap.
  function resizeSmoothly(change) {
    const before = overlay.classList.contains('bce-shown') ? card.getBoundingClientRect() : undefined;
    change();
    if (!before || reduceMotion.matches) return;
    const after = card.getBoundingClientRect();
    if (Math.abs(before.width - after.width) < 1 && Math.abs(before.height - after.height) < 1) return;
    card.animate([
      { width: `${before.width}px`, height: `${before.height}px` },
      { width: `${after.width}px`, height: `${after.height}px` },
    ], { duration: 240, easing: EASE });
  }

  function reveal(line) {
    // The placeholder has its own delayed fade-in (subtitles.css).
    if (line.hidden || reduceMotion.matches || !line.textContent || line.classList.contains('bce-pending')) return;
    line.animate([
      { opacity: 0, transform: 'translateY(0.3em)' },
      { opacity: 1, transform: 'none' },
    ], { duration: 260, easing: EASE });
  }

  // Each word-like piece gets its own span, so it can be hovered and clicked.
  function appendWords(parent, text, segmenter) {
    for (const { segment, isWordLike } of segmenter.segment(text)) {
      parent.append(isWordLike ? element('span', 'bce-word', segment) : segment);
    }
  }

  // `undefined` means not translated yet: a placeholder stands in while a
  // translator is (or is about to be) at work, but not once only the original is left.
  function setTranslation(result) {
    trackDisplayedSource(result);
    translation.textContent = '';
    const pending = !translation.hidden && result === undefined && Boolean(job) && job.fellBack !== 'english';
    translation.classList.toggle('bce-pending', pending);
    if (pending) translation.textContent = downloadButton.hidden || job.preview ? '翻譯中…' : '請點選下載語言模型';
    else if (!result && displayMode === 'chinese' && job?.fellBack === 'english') translation.textContent = '暫無中文譯文';
    else appendWords(translation, result ?? '', chineseWords);
  }

  // The selected engine owns cache. A Chrome preview is held separately,
  // and an AI prefetch counts only once its cue is actually rendered.
  function trackDisplayedSource(result) {
    if (!job || translation.hidden) return;
    const selected = result !== undefined && cache.get(shownText) === result;
    if (selected && tier === 'ai' && job.translator?.kind === 'ai' && !job.fellBack && !job.aiReadyAnnounced) {
      job.aiReadyAnnounced = true;
      flashStatus(AI_READY_MESSAGE, 2200);
    }
    if (job.showingSelected === selected) return;
    job.showingSelected = selected;
    updateSourceIndicator();
  }

  function showTranslation(result) {
    if (held && !translation.classList.contains('bce-pending') && (pressing || selectionInCard())) return;
    if (translation.textContent === result && !translation.classList.contains('bce-pending')) {
      trackDisplayedSource(result);
      return;
    }
    resizeSmoothly(() => setTranslation(result));
    reveal(translation);
  }

  function renderCaption(text, result, cue) {
    if (held) return;
    if (!text) {
      // Fade out and keep the last sentence on the card while it fades.
      displayedCue = undefined;
      clearOverlay();
      return;
    }
    const changed = text !== shownText || cue !== displayedCue;
    resizeSmoothly(() => fillCaption(text, result, cue));
    if (changed) {
      reveal(original);
      reveal(translation);
    }
    overlay.hidden = false;
    overlay.classList.add('bce-shown');
  }

  // Shows the AI's corrected caption when there is one.
  function fillOriginal(text) {
    shownText = text;
    const language = job?.language ?? 'en';
    const words = segmenterFor(language);
    original.lang = language;
    original.textContent = '';
    for (const token of (corrections.get(text) ?? text).matchAll(/\S+|\s+/g)) {
      if (!/\S/.test(token[0])) {
        original.append(token[0]);
        continue;
      }
      const span = element('span', 'bce-token');
      appendWords(span, token[0], words);
      original.append(span);
    }
  }

  function fillCaption(text, result, cue) {
    displayedCue = cue;
    // Live and gap-filling captions have no start time to go back to.
    replay.hidden = !cue;
    fillOriginal(text);
    setTranslation(result);
  }

  function storeTranslation(entries, text, result) {
    if (entries.size >= 4000) entries.delete(entries.keys().next().value);
    entries.set(text, result);
  }

  // Only the selected model's cache counts toward AI lookahead. The local
  // translator supplies a provisional result for the visible line only.
  function captionTranslation(active, text) {
    const result = cache.get(text);
    const preview = active.preview;
    if (result !== undefined || !preview?.translator || !text) return result;
    const local = preview.cache.get(text);
    if (local === undefined && preview.text !== text) {
      preview.controller?.abort();
      preview.text = text;
      preview.controller = new AbortController();
      void translatePreview(active, preview, text, preview.controller.signal);
    }
    return local;
  }

  async function translatePreview(active, preview, text, signal) {
    let result;
    try {
      result = await preview.translator.translate(text, { signal });
    } catch {
      return; // The AI request still owns retry and fallback.
    }
    if (signal.aborted || job !== active || active.preview !== preview || idFromUrl() !== videoId) return;
    storeTranslation(preview.cache, text, result);
    if (text === visibleCaptionText(active) && !cache.has(text)) showTranslation(result);
  }

  function visibleCaptionText(active) {
    if (held) return shownText;
    return active.cues.length ? currentText : active.live.shown;
  }

  function setTimedCaption(active, text, cue) {
    const result = captionTranslation(active, text);
    if (text === currentText && cue === displayedCue) return;
    currentText = text;
    if (text && result === undefined && active.inFlight?.text !== text) {
      active.inFlight?.controller.abort();
    }
    renderCaption(text, result, cue);
    if (text && active.translator && !active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
  }

  // Finish the line under the pointer even if playback has reached a later
  // cue, including when Chrome has already supplied a provisional line.
  function refreshHeldTranslation(active, now) {
    if (!held || !shownText || translation.hidden || active.showingSelected
      || (!active.preview && !translation.classList.contains('bce-pending'))) return false;
    const result = captionTranslation(active, shownText);
    if (result !== undefined) showTranslation(result);
    if (cache.has(shownText)) return true;
    if (active.inFlight && active.inFlight.text !== shownText) active.inFlight.controller.abort();
    else if (active.translator && !active.inFlight && now >= active.retryAt) void translateCaption(active, shownText);
    return true;
  }

  function checkVisibleAiTimeout() {
    const active = job;
    if (active?.translator?.kind !== 'ai') return;
    if (translation.hidden || !overlay.classList.contains('bce-shown') || !translation.classList.contains('bce-pending')) {
      active.waitingForAi = undefined;
      return;
    }
    const now = performance.now();
    if (active.waitingForAi?.text !== shownText) {
      active.waitingForAi = { text: shownText, since: now };
    } else if (now - active.waitingForAi.since >= VISIBLE_AI_TIMEOUT_MS) {
      void fallBack(active, { code: 'timeout' });
    }
  }

  // Whitespace inside Japanese captions only breaks lines, except between
  // Latin words and numbers.
  function collapseSpaces(text, traits) {
    if (traits.spaced || traits.preserveSpaces) return text.replace(/\s+/g, ' ').trim();
    return text.trim().replace(/\s+/g, (gap, at, all) =>
      /[A-Za-z0-9]/.test(all[at - 1] ?? '') && /[A-Za-z0-9]/.test(all[at + gap.length] ?? '') ? ' ' : '');
  }

  function refreshLive(active, now) {
    const live = active.live;
    const expected = active.preference === 'auto' ? active.details?.language : active.preference;
    const nativeText = readNativeCaption(expected);
    // Live captions come without a language, so it is found from their text.
    if (!active.languageSettled && nativeText.replace(/\s/g, '').length >= 6) {
      active.languageSettled = true;
      setJobLanguage(active, detectLanguage(nativeText));
    }
    // Words join with spaces, or (Japanese) characters join directly.
    const traits = traitsOf(active.language);
    const { spaced } = traits;
    const gapText = spaced ? ' ' : '';
    const pieces = (text) => spaced ? text.split(' ') : [...text];
    const raw = collapseSpaces(nativeText, traits);
    if (raw) live.lastSeen = now;
    if (raw && raw !== live.raw && !live.raw.startsWith(raw + gapText)) {
      const previous = live.raw;
      const suffix = previous && raw.startsWith(previous) ? raw.slice(previous.length) : '';
      if (!live.buffer) live.started = now;
      if (live.buffer && /^[,.!?;:、。！？，](?:$|\s|["'”’」』）])/.test(suffix)) {
        live.buffer += suffix;
      } else {
        const left = pieces(previous);
        const right = pieces(raw);
        let overlap = previous ? Math.min(left.length, right.length) : 0;
        while (overlap && left.slice(-overlap).join(gapText) !== right.slice(0, overlap).join(gapText)) overlap--;
        const addition = right.slice(overlap).join(gapText);
        // Keep the last complete sentence eligible for translation while the
        // next one's words accumulate.
        live.buffer = [live.buffer, addition].filter(Boolean).join(gapText);
      }
      live.raw = raw;
      live.changed = now;
    }

    const gap = !raw && now - live.lastSeen >= LIVE_GAP_MS;
    if (live.buffer && (gap || now - live.started >= 6000
      || (SENTENCE_END.test(live.buffer) && now - live.changed >= 200))) {
      const sentence = live.buffer;
      live.buffer = '';
      live.wanted = sentence;
    }
    if (gap) live.raw = '';
    if (gap && now - live.lastSeen >= 2700 && now - (live.shownAt ?? -Infinity) >= 1400) {
      clearOverlay();
      live.wanted = '';
      live.shown = '';
    }
    const sentence = live.wanted;
    if (refreshHeldTranslation(active, now)) return;
    if (active.inFlight && active.inFlight.text !== sentence) active.inFlight.controller.abort();
    if (!sentence) return;
    const result = captionTranslation(active, sentence);
    if (sentence !== live.shown) {
      renderCaption(sentence, result);
      live.shown = sentence;
      live.shownAt = now;
    }
    if (!active.translator) return;
    if (!active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
    if (!cache.has(sentence) && !active.inFlight && now >= active.retryAt) {
      void translateCaption(active, sentence);
    }
  }

  function refresh() {
    const active = job;
    const video = player?.querySelector('video');
    if (!active || !video || idFromUrl() !== videoId || video.seeking || active.waitingForSource) return;
    const now = performance.now();
    trackWatching(active, video, now);
    if (active.transcriptUntil && now >= active.nextTranscriptCheck) {
      active.nextTranscriptCheck = now + 200;
      const expected = active.preference === 'auto' ? active.details?.language : active.preference;
      const { cues, language } = readTranscriptCues(video, expected);
      if (cues.length) {
        active.cues = cues;
        active.source = 'YouTube 逐字稿';
        active.languageSettled = true;
        setJobLanguage(active, language, false);
        updateMenu();
        active.transcriptUntil = 0;
        active.inFlight?.controller.abort();
        currentText = '';
        clearOverlay();
      } else if (now >= active.transcriptUntil) {
        active.transcriptUntil = 0;
      }
    }
    const cues = active.cues;
    if (!cues.length) {
      refreshLive(active, now);
      return;
    }

    const time = video.currentTime + advanceSeconds;
    const index = cueIndexAt(cues, time);
    const cue = cues[index];
    const currentCue = cue && time < cue.end ? cue : undefined;
    const fallback = !currentCue && active.fillGaps
      ? collapseSpaces(readNativeCaption(active.language), traitsOf(active.language)) : '';
    if (refreshHeldTranslation(active, now)) return;
    setTimedCaption(active, currentCue?.text ?? fallback, currentCue);

    if (currentText && active.translator && !active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
    maybePrefetch(active, index);
    if (!active.translator || active.inFlight || now < active.retryAt) return;
    if (currentText && !cache.has(currentText)) {
      void translateCaption(active, currentText);
      return;
    }
    const ahead = LOOKAHEAD[active.translator.kind === 'ai' ? 'ai' : 'basic'];
    const upcoming = cues.slice(index + 1, index + 1 + ahead.cues)
      .find((cue) => cue.start - time <= ahead.seconds && !cache.has(cue.text));
    if (upcoming) void translateCaption(active, upcoming.text);
  }

  // Playback time on this job, counted only while the video plays.
  function trackWatching(active, video, now) {
    if (!video.paused && !video.ended && active.lastTick !== undefined) {
      active.watchedMs += Math.max(0, Math.min(250, now - active.lastTick));
    }
    active.lastTick = now;
  }

  // Once the video has played a while, the AI translates every line left
  // (from here to the end, then the start), saving each as it goes. A new
  // translator or new cues start it again; a failure just ends it, and the
  // lines left are translated on demand as before.
  function maybePrefetch(active, index) {
    const translator = active.translator;
    if (translator?.kind !== 'ai' || typeof translator.prefetch !== 'function' || !settings.prefetchWhole
      || active.watchedMs < PREFETCH_AFTER_MS) return;
    if (active.prefetch?.translator === translator && active.prefetch.cues === active.cues) return;
    active.prefetch?.controller.abort();
    const controller = new AbortController();
    active.prefetch = { translator, cues: active.cues, controller };
    void translator.prefetch(active.cues.map((cue) => cue.text), { from: Math.max(0, index), signal: controller.signal })
      .catch(() => {});
  }

  function stopPrefetch(active) {
    active.prefetch?.controller.abort();
    active.prefetch = undefined;
  }

  // The player's live CC and transcript can belong to a different track.
  function matchesSource(text, expected) {
    if (!expected || !text) return true;
    const letters = text.slice(0, 2000).match(/\p{L}/gu);
    if (!letters) return true;
    if (expected === 'en') {
      return letters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length * 2 >= letters.length;
    }
    if (expected === 'ja' && letters.every((letter) => /\p{Script=Han}/u.test(letter))) return true;
    return detectLanguage(text) === expected;
  }

  function readTranscriptCues(video, expected) {
    let language = expected;
    let matches = true;
    const cues = readTranscript(video, (text) => {
      matches = matchesSource(text, expected);
      language ??= detectLanguage(text);
      return traitsOf(language);
    });
    return { cues: matches ? cues : [], language };
  }

  // The language became known (a track, the transcript, live text). Chrome's
  // translator is made for one language pair, so it is made again; the AI
  // reads the language with each batch and carries on.
  function setJobLanguage(active, code, asr = active.asr) {
    const next = normalizeLanguage(code) ?? 'en';
    active.asr = Boolean(asr);
    if (next === active.language) return;
    active.language = next;
    if (job !== active) return;
    original.lang = next;
    updateMenu();
    if (displayMode === 'original') return;
    if (active.preview) releasePreview(active);
    const builtIn = tier === 'basic' || active.fellBack === 'basic';
    if (tier === 'ai' && !active.fellBack) void preparePreview(active);
    if (!builtIn || (!active.translator && !active.translatorRequest && !active.fellBack)) return;
    if (tier === 'basic') {
      active.fellBack = undefined;
      active.fallbackCode = undefined;
      void startSelectedTranslator(active);
    } else {
      void fallBack(active, { code: active.fallbackCode });
    }
  }

  function resetPosition(event) {
    if (!job || event.target !== player?.querySelector('video')) return;
    job.inFlight?.controller.abort();
    job.live = { raw: '', buffer: '', lastSeen: -Infinity };
    currentText = '';
    clearOverlay();
  }

  async function translateCaption(active, text) {
    const controller = new AbortController();
    const translator = active.translator;
    const inFlight = { text, controller };
    active.inFlight = inFlight;
    try {
      const result = await translator.translate(text, { signal: controller.signal });
      if (job !== active || controller.signal.aborted || idFromUrl() !== videoId) return;
      active.aiFailures = 0;
      storeTranslation(cache, text, result);
      const fixed = translator.sourceOf?.(text);
      if (fixed) storeTranslation(corrections, text, fixed);
      if (text === visibleCaptionText(active)) {
        // The corrected caption replaces the one on the card along with its translation.
        if (fixed && !held && shownText === text) resizeSmoothly(() => fillOriginal(text));
        showTranslation(result);
      }
    } catch (error) {
      if (job !== active || controller.signal.aborted || error?.name === 'AbortError'
        || idFromUrl() !== videoId || translator !== active.translator) return;
      if (translator.kind === 'ai') {
        // A passing failure (slow reply, rate limit, malformed batch) only
        // skips ahead for a moment; the lines are asked for again after it.
        active.aiFailures += 1;
        if (isTransientError(error?.code) && active.aiFailures < AI_FAILURE_LIMIT) {
          console.warn('[bce] AI 翻譯暫時失敗，稍後重試：', error.code);
          active.retryAt = performance.now() + AI_RETRY_PAUSE_MS * active.aiFailures;
          return;
        }
        void fallBack(active, error);
        return;
      }
      stop(false);
      setNotice('翻譯中斷，請在雙語字幕選單重新開啟。');
    } finally {
      if (active.inFlight === inFlight) active.inFlight = undefined;
      if (job === active) refresh();
    }
  }

  // Invoke create inside the click handler, while Chrome's transient activation is live.
  function waitForModelClick(state, signal, create, language) {
    downloadButton.textContent = job?.preview ? '下載 Chrome 語言模型以先顯示本機譯文'
      : state === 'downloading' ? '繼續下載語言模型' : '點此下載語言模型';
    downloadButton.hidden = false;
    if (translation.classList.contains('bce-pending')) setTranslation(undefined);
    setNotice(`Chrome 需要${languageLabel(language)}翻繁中的語言模型。`);
    return new Promise((resolve, reject) => {
      function cleanup() {
        downloadButton.removeEventListener('click', onClick);
        signal.removeEventListener('abort', onAbort);
        downloadButton.hidden = true;
        if (translation.classList.contains('bce-pending')) setTranslation(undefined);
        setNotice('');
      }
      function onAbort() {
        cleanup();
        reject(signal.reason);
      }
      function onClick() {
        cleanup();
        if (!job?.preview) setNotice('正在準備 Chrome 內建翻譯…');
        resolve(create());
      }
      signal.addEventListener('abort', onAbort, { once: true });
      downloadButton.addEventListener('click', onClick);
    });
  }

  // Built-in translators have no `kind`; AI ones say `kind: 'ai'`.
  async function createTranslator(active, wanted, signal) {
    if (wanted !== 'basic') {
      // Captured now: the job outlives neither the video nor the model, and
      // a new glossary or fix setting makes a new translator (onSettingsChanged).
      const id = videoId;
      if (active.pendingDetails) await active.pendingDetails;
      signal.throwIfAborted();
      const dictionary = usesGameTerms(active.details) ? await loadGameDictionary() : undefined;
      signal.throwIfAborted();
      const personal = parseGlossary(settings.glossary);
      const overrides = new Set(personal.map(({ source }) => source.toLowerCase()));
      const profile = translationProfile(settings);
      const model = `${aiModelKey(wanted)}${profile ? `~${profile}` : ''}${dictionary ? `~7k-${dictionary.revision}` : ''}`;
      const { translations, sources } = await translationStore.load(id, model);
      return createAiTranslator({
        tier: wanted,
        seed: translations,
        seedSources: sources,
        onResult: (text, result, fixed) => translationStore.save(id, model, text, result, fixed),
        // Read for every batch: the language may only be known once the track arrives.
        getContext: (lines) => ({
          languageName: languageLabel(active.language),
          fixSource: Boolean(active.asr && settings.fixAsr),
          video: active.details,
          glossary: personal,
          gameTerms: dictionary?.forBatch(active.language, lines)
            .filter(({ source }) => !overrides.has(source.toLowerCase())),
        }),
        // From a little before the current cue, so a line that repeats
        // ("[Music]") is found where the video is, not at its first use.
        getSentences: () => {
          const video = player?.querySelector('video');
          const index = video ? cueIndexAt(active.cues, video.currentTime + advanceSeconds) : 0;
          return active.cues.slice(Math.max(0, index - CONTEXT_SIZE)).map((cue) => cue.text);
        },
        // An orphaned copy (after an extension reload) throws synchronously
        // here; async turns that into a rejection, so it falls back.
        send: async (payload) => chrome.runtime.sendMessage(payload),
      });
    }
    const language = active.language;
    const pair = { sourceLanguage: language, targetLanguage: TARGET_LANGUAGE };
    const unsupported = () => Object.assign(new Error('unsupported language pair'), { code: 'unsupported-pair' });
    const createLocal = () => Translator.create({
      ...pair,
      signal,
      monitor(download) {
        // Quiet once another translator took over (a tier switch mid-download).
        download.addEventListener('downloadprogress', (event) => {
          if (!signal.aborted && !active.translator) setNotice(`下載語言模型 ${Math.round(event.loaded * 100)}%`);
        });
      }
    });
    const create = async () => {
      const local = await createLocal();
      if (language !== 'ko') return local;
      return {
        async translate(text, options) {
          const expanded = globalThis.bceSevenKnights.expandKoreanRankGoal(text);
          if (expanded !== text) {
            await active.pendingDetails;
            if (usesGameTerms(active.details ?? document.title)) return local.translate(expanded, options);
          }
          return local.translate(text, options);
        },
        destroy: () => local.destroy(),
      };
    };
    const canAsk = typeof Translator.availability === 'function';
    if (!navigator.userActivation?.isActive && canAsk) {
      const state = await Translator.availability(pair);
      signal.throwIfAborted();
      if (state === 'unavailable') throw unsupported();
      if (state === 'downloadable' || state === 'downloading') {
        return waitForModelClick(state, signal, create, language);
      }
    }
    try {
      return await create();
    } catch (error) {
      // Asked only now, so that create() above still ran within the key press or click.
      if (canAsk && !signal.aborted && await Translator.availability(pair).catch(() => '') === 'unavailable') {
        throw unsupported();
      }
      throw error;
    }
  }

  // Chrome cannot translate this language: the captions carry on in the
  // original only, and AI can still be picked in the menu.
  function keepOriginalOnly(active) {
    releaseTranslator(active);
    active.fellBack = 'english';
    active.fallbackCode = 'unsupported-pair';
    active.showingSelected = false;
    if (job === active && translation.classList.contains('bce-pending')) setTranslation(undefined);
    updateToggle();
    setNotice(`Chrome 內建翻譯不支援${languageLabel(active.language)}翻繁中。可在選單改用 AI 翻譯，或把字幕顯示切到「只顯示原文」。`);
  }

  function releaseTranslator(active) {
    active.waitingForAi = undefined;
    active.translatorRequest?.abort();
    active.inFlight?.controller.abort();
    active.translator?.destroy();
    active.translator = undefined;
  }

  function releasePreview(active) {
    const preview = active.preview;
    if (!preview) return;
    preview.controller?.abort();
    releaseTranslator(preview);
    active.preview = undefined;
  }

  async function preparePreview(active) {
    if (active.preview || !globalThis.Translator) return;
    const request = new AbortController();
    const preview = { translatorRequest: request, cache: new Map() };
    active.preview = preview;
    try {
      const translator = await createTranslator(active, 'basic', request.signal);
      if (request.signal.aborted) {
        translator.destroy();
        return;
      }
      preview.translator = translator;
      refresh();
    } catch {
      // AI can continue if the local language pair is unavailable.
      if (active.preview === preview) releasePreview(active);
    }
  }

  // Replaces the job's translator. Until the new one is ready there is none,
  // so refresh() skips translating; a newer request (tier switch, fallback)
  // or a different job supersedes this one, which then resolves to false.
  async function installTranslator(active, wanted) {
    releaseTranslator(active);
    active.aiFailures = 0;
    active.retryAt = 0;
    if (wanted === 'basic' && active.preview?.translator) {
      const preview = active.preview;
      preview.controller?.abort();
      active.translator = preview.translator;
      active.translatorRequest = preview.translatorRequest;
      cache = preview.cache;
      active.preview = undefined;
      currentText = '';
      active.live.shown = '';
      return true;
    }
    if (wanted === 'basic') releasePreview(active);
    else void preparePreview(active);
    const request = new AbortController();
    active.translatorRequest = request;
    const current = () => job === active && !request.signal.aborted;
    try {
      const translator = await createTranslator(active, wanted, request.signal);
      if (!current()) {
        translator.destroy();
        return false;
      }
      active.translator = translator;
      return true;
    } catch (error) {
      if (current()) throw error;
      return false;
    }
  }

  // The AI translator failed: carry on with the built-in one, or with the original
  // only when that cannot start (no API, or a model that needs a download,
  // which requires a click). Picking the AI tier again retries.
  async function fallBack(active, error) {
    console.warn('[bce] AI 翻譯失敗：', error?.code ?? error);
    cache.clear();
    const code = error?.code;
    if (code === 'credits' && settings[tier]) creditLimitedProviders.add(settings[tier].provider);
    if (code === 'budget') budgetReached = true;
    active.fellBack = 'basic';
    active.fallbackCode = code;
    active.showingSelected = false;
    updateToggle();
    const notices = {
      credits: 'AI 帳戶餘額不足，已改用 Chrome 內建翻譯。加值後重新整理頁面即可再用。',
      budget: '本月 AI 費用已達設定的上限，已改用 Chrome 內建翻譯。可在設定頁調高上限，下個月也會自動恢復。',
      'rate-limit': 'AI 服務目前限制請求，已改用 Chrome 內建翻譯。',
      'no-key': '請先在設定頁填入 OpenRouter 的 API key，已改用內建翻譯。',
      'bad-key': 'API key 無效或沒有權限，已改用內建翻譯。請到設定頁檢查。',
    };
    const text = notices[code] ?? `${describeAiError(code)}，已改用內建翻譯。`;
    setNotice(text);
    try {
      if (!(await installTranslator(active, 'basic'))) return;
      setPassingNotice(text);
      refresh();
    } catch (installError) {
      // installTranslator left the job without a translator: the original only.
      active.fellBack = 'english';
      if (job === active && translation.classList.contains('bce-pending')) setTranslation(undefined);
      updateToggle();
      setPassingNotice(installError?.code === 'unsupported-pair'
        ? `${describeAiError(code)}，Chrome 內建翻譯也不支援${languageLabel(active.language)}，暫時只顯示原文字幕。`
        : displayMode === 'chinese'
        ? `${describeAiError(code)}，內建翻譯也無法啟動。可在「字幕顯示」切到「只顯示原文」。`
        : code === 'credits'
        ? 'AI 帳戶餘額不足，Chrome 內建翻譯也無法啟動，暫時只顯示原文字幕。'
        : globalThis.Translator
        ? 'AI 暫時無法使用，內建翻譯也無法啟動。請在選單把翻譯切到「基本」，再重新開啟雙語字幕下載語言模型。'
        : 'AI 暫時無法使用，這個 Chrome 環境也無法使用內建翻譯。');
    }
  }

  function switchTier(next) {
    if (next !== 'basic' && job?.translator && job.translator.kind !== 'ai') {
      // Transfer ownership of the Chrome session, including its lifetime
      // signal, before installing AI. Only its old per-line request stops.
      job.preview = { translator: job.translator, translatorRequest: job.translatorRequest, cache };
      job.translator = undefined;
      job.translatorRequest = undefined;
    }
    tier = next;
    cache = new Map();
    if (job) {
      job.aiReadyAnnounced = false;
      job.fellBack = undefined;
      job.fallbackCode = undefined;
      job.showingSelected = false;
    }
    updateToggle();
    if (job && displayMode !== 'original') void startSelectedTranslator(job);
  }

  async function startSelectedTranslator(active) {
    const limit = usageLimit(tier);
    if (limit) {
      await fallBack(active, { code: limit });
      return;
    }
    if (tier === 'basic' && !globalThis.Translator) {
      stop(false);
      setNotice('這個 Chrome 環境無法使用內建翻譯。');
      return;
    }
    try {
      if (!(await installTranslator(active, tier))) return;
      setNotice('');
      updateMenu();
      refresh();
    } catch (error) {
      if (error?.code === 'unsupported-pair' && job === active) {
        keepOriginalOnly(active);
        return;
      }
      stop(false);
      setNotice('翻譯中斷，請在雙語字幕選單重新開啟。');
    }
  }

  async function chooseTier(next, config) {
    const nextModel = aiModelKey(next, config);
    if (usageLimit(next, config)) return;
    // Storage would not change, so retry the AI tier here.
    if (next === tier && nextModel === aiModelKey(tier) && job?.fellBack) {
      void switchTier(next);
      return;
    }
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      const updated = { ...mergeSettings(stored[SETTINGS_KEY]), tier: next };
      if (config) updated[next] = config;
      await chrome.storage.local.set({ [SETTINGS_KEY]: updated });
    } catch {
      setNotice('無法儲存翻譯等級，請重新整理頁面。');
    }
  }

  function onSettingsChanged(changes, areaName) {
    if (retired || areaName !== 'local') return;
    if (changes[ENABLED_KEY]) applyEnabled(changes[ENABLED_KEY].newValue === true);
    if (changes[DISPLAY_MODE_KEY]) applyDisplayMode(changes[DISPLAY_MODE_KEY].newValue);
    if (changes[FONT_SIZE_KEY]) applyFontSize(changes[FONT_SIZE_KEY].newValue);
    if (changes[SOURCE_LANGUAGE_KEY]) applySourcePreference(changes[SOURCE_LANGUAGE_KEY].newValue);
    if (!changes[SETTINGS_KEY] && !changes[KEYS_KEY]) {
      if (changes[FONT_SIZE_KEY]) updateMenu();
      return;
    }
    const previousModel = aiModelKey(tier);
    const previousProfile = translationProfile(settings);
    if (changes[KEYS_KEY]) creditLimitedProviders.clear();
    if (changes[SETTINGS_KEY]) {
      const previousLimit = settings.monthlyLimit;
      settings = mergeSettings(changes[SETTINGS_KEY].newValue);
      // A new limit is checked again on the next request (picking AI in the menu).
      if (settings.monthlyLimit !== previousLimit) budgetReached = false;
    }
    if (job && !settings.prefetchWhole) stopPrefetch(job);
    // A new glossary or fix setting changes the AI's output (and where it is saved).
    const profileChanged = Boolean(previousModel) && previousProfile !== translationProfile(settings);
    if (settings.tier !== tier || previousModel !== aiModelKey(tier) || (previousModel && changes[KEYS_KEY])
      || profileChanged) {
      void switchTier(settings.tier);
    } else {
      updateMenu();
    }
  }

  async function loadPreferences() {
    try {
      const stored = await chrome.storage.local.get([
        SETTINGS_KEY, FONT_SIZE_KEY, DISPLAY_MODE_KEY, ENABLED_KEY, SOURCE_LANGUAGE_KEY,
      ]);
      if (retired) return;
      applyDisplayMode(stored[DISPLAY_MODE_KEY]);
      applyFontSize(stored[FONT_SIZE_KEY]);
      // No job runs yet, so this only records the choice.
      applySourcePreference(stored[SOURCE_LANGUAGE_KEY]);
      settings = mergeSettings(stored[SETTINGS_KEY]);
      captionsEnabled ??= stored[ENABLED_KEY] === true;
      if (settings.tier !== tier) void switchTier(settings.tier);
      else updateMenu();
    } catch {
      // Orphaned copy: keep the built-in translator.
    }
    if (retired) return;
    preferencesReady = true;
    updateToggle();
    syncPage();
  }

  const ccButton = () => document.querySelector('#movie_player .ytp-subtitles-button');
  const ccUsable = (cc) => cc && !cc.disabled && cc.getAttribute('aria-disabled') !== 'true';
  const ccPressed = (cc) => cc?.getAttribute('aria-pressed') === 'true';
  // YouTube switches its own captions on by itself (an English video under a
  // Chinese interface counts as "recommended") and carries the CC button over
  // to later videos. While bilingual captions are off, every video starts with
  // CC off; once the user turns captions on themselves (the CC button, the
  // settings menu or the C key), that video is left alone.
  const CC_GUARD_PAUSE_MS = 500;
  let guardedVideo;
  let ccGuardPausedUntil = 0;

  function guardNativeCc() {
    if (!preferencesReady || captionsEnabled || !guardedVideo || guardedVideo !== idFromUrl()) return;
    const now = performance.now();
    if (now < ccGuardPausedUntil) return;
    const cc = ccButton();
    if (!ccUsable(cc) || !ccPressed(cc)) return;
    cc.click();
    // Give the button time to update before looking again.
    ccGuardPausedUntil = now + CC_GUARD_PAUSE_MS;
  }

  function releaseCcGuard() {
    guardedVideo = undefined;
  }

  document.addEventListener('click', (event) => {
    if (event.isTrusted && event.target instanceof Element
      && event.target.closest('.ytp-subtitles-button, .ytp-settings-menu')) releaseCcGuard();
  }, true);
  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted || event.code !== 'KeyC' || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.composedPath()[0];
    if (target instanceof Element && (target.isContentEditable || target.closest('input, textarea, select'))) return;
    releaseCcGuard();
  }, true);

  function enableNativeCaptions() {
    const cc = player.querySelector('.ytp-subtitles-button');
    if (!ccUsable(cc) || cc.getAttribute('aria-pressed') === null || cc.getClientRects().length === 0) return false;
    if (cc.getAttribute('aria-pressed') === 'false') {
      cc.click();
      const id = videoId;
      // After a switch to another video the guard turns CC off there.
      restoreCc = () => {
        const current = ccButton();
        if (idFromUrl() === id && ccPressed(current)) current.click();
      };
    }
    return true;
  }

  function applyEnabled(enabled) {
    if (enabled === captionsEnabled) return;
    captionsEnabled = enabled;
    nextStartAt = 0;
    if (enabled) {
      updateToggle();
      syncPage();
    } else {
      stop();
    }
  }

  async function toggleCaptions() {
    if (retired || !preferencesReady) return;
    const enabled = !captionsEnabled;
    applyEnabled(enabled);
    try {
      await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
    } catch {
      setPassingNotice('無法儲存雙語字幕開關，這次選擇僅在本頁生效。');
    }
  }

  // Runs within the key press or click that turned captions on (no await
  // before the translator starts), so Chrome may still download its model.
  async function begin(video) {
    nextStartAt = Infinity;
    const id = videoId;
    const preference = sourcePreference;
    // Title and channel for AI, and the language of the track to come; asked
    // of the page below when not known yet.
    const details = cachedVideoDetails(id, preference);
    const timed = !imported.length ? cachedTimedText(id, preference) : undefined;
    const expected = preference === 'auto' ? details?.language : preference;
    const transcript = !imported.length && !timed ? readTranscriptCues(video, expected) : undefined;
    const cues = imported.length ? imported : timed?.cues ?? transcript.cues;
    // Until the track (or live text) shows the language, this is a guess.
    const language = normalizeLanguage(imported.length ? importedLanguage
      : timed ? timed.language
      : cues.length ? transcript.language
      : preference !== 'auto' ? preference : details?.language) ?? 'en';
    const nativeAvailable = !imported.length && enableNativeCaptions();
    // Turning CC on makes the player request captions, which hands
    // page-hook.js the token it needs to download the caption track.
    const fetchingTimed = !imported.length && !timed && nativeAvailable;
    const openingTranscript = !cues.length && !fetchingTimed && openTranscript();
    if (!cues.length && !nativeAvailable && !openingTranscript) {
      nextStartAt = performance.now() + 2500;
      setNotice('播放器目前沒有可用的 CC。可匯入從 DownSub 下載的 SRT 字幕檔。');
      return;
    }
    if (displayMode !== 'original' && tier === 'basic' && !globalThis.Translator) {
      stop(false);
      setNotice('這個 Chrome 環境無法使用內建翻譯。');
      return;
    }

    const active = {
      receivedCaption: false,
      cues,
      source: imported.length ? importedSource : timed ? timed.source : cues.length ? 'YouTube 逐字稿' : '即時 CC',
      fillGaps: nativeAvailable && !timed,
      ccWasOn: nativeAvailable && !restoreCc,
      live: { raw: '', buffer: '', lastSeen: -Infinity },
      transcriptUntil: openingTranscript ? performance.now() + 2600 : 0,
      nextTranscriptCheck: 0,
      aiFailures: 0,
      retryAt: 0,
      preference,
      language,
      asr: Boolean(timed?.asr),
      languageSettled: Boolean(cues.length || expected),
      waitingForSource: !details && !imported.length && !timed && preference === 'auto',
      details,
      watchedMs: 0,
    };
    job = active;
    original.lang = language;
    if (!details) {
      active.pendingDetails = requestVideoDetails(id, preference).then((found) => {
        if (job !== active) return;
        active.details = found;
        if (active.waitingForSource) {
          active.waitingForSource = false;
          if (found.language) {
            if (active.cues.length) {
              active.cues = readTranscriptCues(video, found.language).cues;
              if (!active.cues.length) active.source = '即時 CC';
            }
            active.languageSettled = true;
            setJobLanguage(active, found.language);
          }
          refresh();
        }
      });
    }
    updateToggle();
    const limit = usageLimit(tier);
    if (displayMode === 'original') setNotice('');
    else if (!limit) {
      setNotice(tier === 'basic' ? '正在準備 Chrome 內建翻譯…' : `正在準備 AI 翻譯（${TIER_LABELS[tier]}）…`);
    }
    player.classList.add('bce-replaces-native');
    if (fetchingTimed) void loadTimedText(active);
    refresh();

    if (displayMode === 'original') return;
    if (limit) {
      await fallBack(active, { code: limit });
      return;
    }
    try {
      if (!(await installTranslator(active, tier))) return;
      setPassingNotice(active.cues.length
        ? '已取得時間碼，字幕會跟著影片時間切換。'
        : active.languageSettled ? `等待${languageLabel(active.language)}字幕。可在 YouTube 字幕選單選擇同語言的 CC。`
          : '等待播放器的即時 CC。');
      refresh();
    } catch (error) {
      if (job !== active) return;
      if (error?.code === 'unsupported-pair') {
        keepOriginalOnly(active);
        return;
      }
      stop(false);
      setNotice(`暫時無法啟動${languageLabel(active.language)}翻繁中。請確認桌面版 Chrome 支援內建翻譯，再到雙語字幕選單重新開啟。`);
    }
  }

  importButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files[0];
    fileInput.value = '';
    if (!file) return;
    const id = videoId;
    try {
      const contents = await file.text();
      const entries = globalThis.bceSubtitleParser.parseSubtitleFile(contents);
      const source = /^\uFEFF?WEBVTT/.test(contents) ? 'VTT' : 'SRT';
      if (idFromUrl() !== id) return;
      if (!entries.length) {
        setNotice('讀不到字幕時間碼，請選擇 .srt 或 .vtt 字幕檔。');
        return;
      }
      stop();
      const language = sourcePreference === 'auto'
        ? detectLanguage(entries.map((entry) => entry.text).join(' ')) : sourcePreference;
      imported = sentenceCues(entries, traitsOf(language));
      importedLanguage = language;
      importedSource = source;
      advanceSeconds = 0;
      nextStartAt = 0;
      if (captionsEnabled) syncPage();
      else setNotice(`已讀取 ${entries.length} 段字幕。請在雙語字幕選單開啟。`);
      updateMenu();
    } catch {
      if (idFromUrl() === id) setNotice('無法讀取這個字幕檔。');
    }
  });

  // What the toolbar popup shows for this tab.
  function statusReport() {
    return {
      videoId: idFromUrl(),
      enabled: Boolean(captionsEnabled),
      running: Boolean(job),
      source: job?.source ?? importedSource,
      language: job?.language,
      translation: displayMode === 'original' ? '只顯示原文' : tierValue(),
      notice: notice.hidden ? '' : message.textContent,
    };
  }

  function onRuntimeMessage(msg, _sender, sendResponse) {
    if (retired || msg?.type !== 'bce-status') return;
    sendResponse(statusReport());
  }

  document.addEventListener('yt-navigate-finish', syncPage);
  document.addEventListener('loadedmetadata', syncPage, true);
  document.addEventListener('seeking', resetPosition, true);
  // Best effort: the last second of results may still be waiting to be written.
  window.addEventListener('pagehide', () => void translationStore.flush());
  window.addEventListener('keydown', onCaptionShortcut, true);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  // A short poll catches caption mutations and controls replaced by YouTube.
  const timer = setInterval(() => {
    syncPage();
    guardNativeCc();
    refresh();
    checkVisibleAiTimeout();
  }, 75);

  // Only one copy may run: a copy that loads later (another install of this
  // extension, or a reload) tells the earlier one to remove itself.
  document.dispatchEvent(new Event('bce-takeover'));
  document.addEventListener('bce-takeover', () => {
    retired = true;
    clearInterval(timer);
    window.removeEventListener('keydown', onCaptionShortcut, true);
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
      chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    } catch {
      // Orphaned copy: its listener no longer fires anyway.
    }
    closeMenu(false);
    stop();
    toggle.remove();
    overlay.remove();
    notice.remove();
    menu.remove();
  }, { once: true });

  updateToggle();
  syncPage();
  void loadPreferences();
})();
