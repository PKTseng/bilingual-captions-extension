(() => {
  'use strict';

  const LANGUAGES = { sourceLanguage: 'en', targetLanguage: 'zh-Hant' };
  const NATIVE_CAPTIONS = '.ytp-caption-window-container';
  const CAPTION_LINES = '.caption-visual-line';
  const cache = new Map();
  const SENTENCE_END = /[.!?]["'”’)\]]*$/;
  const englishWords = new Intl.Segmenter('en', { granularity: 'word' });
  const chineseWords = new Intl.Segmenter('zh-Hant', { granularity: 'word' });
  const LIVE_GAP_MS = 900;
  const { sentenceCues, readTranscript, openTranscript } = globalThis.bceTranscript;
  const { requestTimedText, cachedTimedText } = globalThis.bcePageBridge;
  const {
    TIERS, TIER_LABELS, SETTINGS_KEY, mergeSettings, describeTier,
  } = globalThis.bceSettings;
  const { createAiTranslator, CONTEXT_SIZE } = globalThis.bceAiTranslator;
  const PASSING_NOTICE_MS = 6000;
  let tier = 'basic';
  // Only the tier and model names are read here (SETTINGS_KEY), never API keys.
  let settings = mergeSettings();
  let videoId;
  let player;
  let job;
  let imported = [];
  let currentText = '';
  let restoreCc;
  let advanceSeconds = 0;
  let importedSource = '';
  let displayedCue;
  let wordElements = [];

  function element(tag, className, text) {
    const item = document.createElement(tag);
    item.className = className;
    if (text) item.textContent = text;
    return item;
  }

  // Built with createElementNS because YouTube enforces Trusted Types.
  function svgElement(tag, attributes) {
    const item = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) item.setAttribute(name, value);
    return item;
  }
  const toggle = element('button', 'bce-toggle');
  toggle.type = 'button';
  toggle.title = '雙語字幕選單';
  toggle.setAttribute('aria-label', '雙語字幕選單');
  const toggleIcon = svgElement('svg', {
    viewBox: '0 0 24 24', width: '24', height: '24', fill: 'none', stroke: 'currentColor',
    'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true',
  });
  // Tabler Icons Subtitles, MIT (icons/LICENSE-tabler.txt).
  toggleIcon.append(
    svgElement('path', { d: 'M18 5a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-12a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3l12 0' }),
    svgElement('path', { d: 'M7 15h5' }),
    svgElement('path', { d: 'M15 15h2' }),
    svgElement('path', { d: 'M17 12h-3' }),
    svgElement('path', { d: 'M11 12h-1' }),
  );
  toggle.append(toggleIcon);
  const overlay = element('div', 'bce-overlay');
  const card = element('div', 'bce-card');
  const original = element('div', 'bce-line bce-original');
  const translation = element('div', 'bce-line bce-translation');
  original.lang = 'en';
  translation.lang = 'zh-Hant';
  card.append(original, translation);
  const copied = element('div', 'bce-copied');
  copied.setAttribute('role', 'status');
  overlay.append(copied, card);
  overlay.hidden = true;

  const notice = element('div', 'bce-notice');
  const message = element('div', 'bce-message');
  message.setAttribute('role', 'status');
  const importButton = element('button', 'bce-import', '匯入英文 SRT／VTT');
  importButton.type = 'button';
  const fileInput = element('input', '');
  fileInput.type = 'file';
  fileInput.accept = '.srt,.vtt';
  fileInput.hidden = true;
  notice.append(message, importButton, fileInput);
  notice.hidden = true;
  // Marks this version's elements; subtitles.css hides unmarked ones left by
  // an older copy of the extension that is still loaded in Chrome.
  for (const item of [toggle, overlay, notice]) item.dataset.bce = 'current';
  let retired = false;

  let noticeTimer;
  function setNotice(text) {
    clearTimeout(noticeTimer);
    message.textContent = text;
    notice.hidden = !text;
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
  // main page and the translation and timing sub-pages. renderMenu() rebuilds
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

  function tierValue() {
    if (!job?.fellBack || tier === 'basic') return describeTier(settings, tier);
    return job.fellBack === 'english' ? '僅英文（AI 已暫停）' : '基本（AI 已暫停）';
  }

  function timingValue() {
    if (advanceSeconds === 0) return '原始';
    return `${advanceSeconds > 0 ? '提早' : '延後'} ${Math.abs(advanceSeconds).toFixed(1)} 秒`;
  }

  function sourceValue() {
    const source = job?.source ?? importedSource;
    if (!source) return '尚未選擇字幕來源';
    const wordTimed = job ? job.wordTimed : imported.some((cue) => cue.marks?.length);
    const detail = hasTiming() ? (wordTimed ? '含原始字詞時間碼' : '字詞高亮為估算')
      : source === '即時 CC' ? '等字幕送到才能合句，可匯入 SRT 使用時間碼' : '';
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
    // begin() runs inside the click, so the built-in translator's model
    // download still has the user activation it needs.
    const onOff = menuItem('switch', '雙語字幕', () => void begin(),
      { role: 'menuitemcheckbox', checked: Boolean(job) });
    onOff.append(glyph('bce-menu-switch'));
    return [
      onOff,
      menuItem('tier', '翻譯', () => showMenuPage('tier'), { value: tierValue(), next: true }),
      menuItem('timing', '字幕時間', () => showMenuPage('timing'),
        { value: timingValue(), next: true, disabled: !hasTiming() }),
      menuItem('import', '匯入英文 SRT／VTT', () => {
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
  function tierPage() {
    return [
      backItem('翻譯'),
      ...TIERS.map((name) => {
        const item = menuItem(`tier-${name}`, describeTier(settings, name), () => {
          void chooseTier(name);
          showMenuPage('main');
        }, { role: 'menuitemradio', checked: tier === name });
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
      : menuPage === 'timing' ? timingPage() : mainPage()));
    const key = preferKey ?? focused;
    if (focused !== undefined) {
      (menu.querySelector(`[data-key="${key}"]:not(:disabled)`) ?? firstMenuItem())?.focus();
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
    toggle.setAttribute('aria-pressed', String(Boolean(job)));
    updateMenu();
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
    copied.textContent = `已複製：${text}`;
    copied.classList.add('bce-visible');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => copied.classList.remove('bce-visible'), 1400);
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

  card.addEventListener('pointerenter', () => {
    hovering = true;
    updateHeld();
  });
  card.addEventListener('pointerleave', () => {
    hovering = false;
    updateHeld();
  });
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
    card.addEventListener(type, (event) => event.stopPropagation());
  }

  function stop(resetNotice = true) {
    const previous = job;
    job = undefined;
    clearTimeout(noticeTimer);
    hovering = pressing = held = false;
    previous?.controller.abort();
    previous?.inFlight?.controller.abort();
    previous?.translator?.destroy();
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
        imported = [];
        importedSource = '';
        advanceSeconds = 0;
      }
      toggle.remove();
      overlay.remove();
      notice.remove();
      menu.remove();
      videoId = nextId;
      player = nextPlayer;
    }
    if (!player) return;
    const controls = player.querySelector('.ytp-right-controls');
    if (controls && toggle.parentNode !== controls) controls.prepend(toggle);
    if (overlay.parentNode !== player) player.append(overlay, notice);
    if (menu.parentNode !== player) player.append(menu);
    placeOverlay();
    placeMenu();
  }

  // CC that was already on before this script loaded won't request again by
  // itself; switching it off and on makes the player fetch captions again.
  async function nudgeCaptions() {
    const cc = player?.querySelector('.ytp-subtitles-button');
    if (cc?.getAttribute('aria-pressed') !== 'true') return;
    cc.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (cc.isConnected && cc.getAttribute('aria-pressed') === 'false') cc.click();
  }

  async function loadTimedText(active) {
    const id = videoId;
    const timed = await requestTimedText(id, active.ccWasOn ? nudgeCaptions : undefined);
    if (job !== active || idFromUrl() !== id) return;
    if (!timed) {
      if (!active.cues.length && openTranscript()) active.transcriptUntil = performance.now() + 2600;
      return;
    }
    active.cues = timed.cues;
    active.source = timed.source;
    active.wordTimed = timed.wordTimed;
    active.fillGaps = false;
    active.transcriptUntil = 0;
    active.inFlight?.controller.abort();
    currentText = '';
    clearOverlay();
    updateMenu();
    refresh();
  }

  function readNativeCaption() {
    const container = player?.querySelector(NATIVE_CAPTIONS);
    if (!container || !container.getClientRects().length) return '';
    const lines = [...container.querySelectorAll(CAPTION_LINES)]
      .map((line) => line.textContent.trim()).filter(Boolean);
    if (lines.length) return lines.join('\n');
    return [...container.querySelectorAll('.ytp-caption-segment')]
      .map((part) => part.textContent.trim()).filter(Boolean).join(' ');
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
    if (reduceMotion.matches || !line.textContent) return;
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

  function setTranslation(result) {
    translation.textContent = '';
    appendWords(translation, result, chineseWords);
  }

  function showTranslation(result) {
    if (held || translation.textContent === result) return;
    resizeSmoothly(() => setTranslation(result));
    reveal(translation);
  }

  function renderCaption(text, result = '', cue) {
    if (held) return;
    if (!text) {
      // Fade out and keep the last sentence on the card while it fades.
      displayedCue = undefined;
      wordElements = [];
      clearOverlay();
      return;
    }
    const changed = text !== original.textContent || cue !== displayedCue;
    resizeSmoothly(() => fillCaption(text, result, cue));
    if (changed) {
      reveal(original);
      reveal(translation);
    }
    overlay.hidden = false;
    overlay.classList.add('bce-shown');
  }

  function fillCaption(text, result, cue) {
    displayedCue = cue;
    wordElements = [];
    original.textContent = '';
    for (const token of text.matchAll(/\S+|\s+/g)) {
      if (!/\S/.test(token[0])) {
        original.append(token[0]);
        continue;
      }
      const span = element('span', 'bce-token');
      appendWords(span, token[0], englishWords);
      original.append(span);
      if (!cue) continue;
      span.dataset.word = '';
      const mark = cue.marks?.find((entry) => entry.index === token.index);
      wordElements.push({ span, time: mark?.time, fill: 0 });
    }
    if (wordElements.length) {
      let anchor = 0;
      wordElements[0].time ??= cue.start;
      for (let i = 1; i <= wordElements.length; i++) {
        const next = i === wordElements.length ? cue.end : wordElements[i].time;
        if (next === undefined) continue;
        const start = wordElements[anchor].time;
        for (let j = anchor + 1; j < i; j++) {
          wordElements[j].time = start + (next - start) * (j - anchor) / (i - anchor);
        }
        anchor = i;
      }
      // A word is "sung" from its start until the next word starts, but not
      // through a long pause; the last word gets a length estimated from its
      // letters, since the cue end includes the time it lingers on screen.
      wordElements.forEach((word, i) => {
        const next = wordElements[i + 1]?.time;
        const spoken = Math.min(0.9, Math.max(0.25, 0.12 + 0.065 * word.span.textContent.length));
        word.end = next === undefined
          ? Math.min(cue.end, word.time + spoken)
          : Math.min(next, word.time + 1);
      });
    }
    setTranslation(result);
  }

  // KTV-style colour sweep: each word fills left to right while it is spoken.
  function updateFill(time) {
    for (const word of wordElements) {
      const length = word.end - word.time;
      const progress = length > 0 ? (time - word.time) / length : Number(time >= word.time);
      const fill = Math.round(Math.min(1, Math.max(0, progress)) * 1000) / 10;
      if (fill === word.fill) continue;
      word.fill = fill;
      word.span.style.setProperty('--bce-fill', `${fill}%`);
    }
  }

  // The 75 ms poll is too coarse for a smooth sweep, so the fill follows the
  // video on every animation frame.
  function animateFill() {
    if (retired) return;
    requestAnimationFrame(animateFill);
    const video = player?.querySelector('video');
    if (!job || !displayedCue || !wordElements.length || !video) return;
    updateFill(video.currentTime + advanceSeconds);
  }
  requestAnimationFrame(animateFill);

  function setTimedCaption(active, text, cue) {
    if (text === currentText && cue === displayedCue) return;
    currentText = text;
    const result = cache.get(text);
    if (text && result === undefined && active.inFlight?.text !== text) {
      active.inFlight?.controller.abort();
    }
    renderCaption(text, result, cue);
    if (text && active.translator && !active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
  }

  function refreshLive(active, now) {
    const live = active.live;
    const raw = readNativeCaption().replace(/\s+/g, ' ').trim();
    if (raw) live.lastSeen = now;
    if (raw && raw !== live.raw && !live.raw.startsWith(raw + ' ')) {
      const previous = live.raw;
      const suffix = previous && raw.startsWith(previous) ? raw.slice(previous.length) : '';
      if (!live.buffer) live.started = now;
      if (live.buffer && /^[,.!?;:](?:$|\s|["'”’])/.test(suffix)) {
        live.buffer += suffix;
      } else {
        const left = previous.split(' ');
        const right = raw.split(' ');
        let overlap = previous ? Math.min(left.length, right.length) : 0;
        while (overlap && left.slice(-overlap).join(' ') !== right.slice(0, overlap).join(' ')) overlap--;
        const addition = right.slice(overlap).join(' ');
        if (addition && !live.buffer && live.wanted) {
          live.wanted = '';
          live.shown = '';
          active.inFlight?.controller.abort();
          clearOverlay();
        }
        live.buffer = [live.buffer, addition].filter(Boolean).join(' ');
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
      if (active.inFlight?.text !== sentence) active.inFlight?.controller.abort();
    }
    if (gap) live.raw = '';
    if (gap && now - live.lastSeen >= 2700 && now - (live.shownAt ?? -Infinity) >= 1400) {
      clearOverlay();
      live.wanted = '';
      live.shown = '';
    }
    const sentence = live.wanted;
    if (!sentence) return;
    if (sentence !== live.shown) {
      renderCaption(sentence, cache.get(sentence));
      live.shown = sentence;
      live.shownAt = now;
    }
    if (!active.translator) return;
    if (!active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
    if (!cache.has(sentence) && !active.inFlight) {
      void translateCaption(active, sentence);
    }
  }

  function refresh() {
    const active = job;
    const video = player?.querySelector('video');
    if (!active || !video || idFromUrl() !== videoId || video.seeking) return;
    const now = performance.now();
    if (active.transcriptUntil && now >= active.nextTranscriptCheck) {
      active.nextTranscriptCheck = now + 200;
      const cues = readTranscript(video);
      if (cues.length) {
        active.cues = cues;
        active.source = 'YouTube 逐字稿';
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
      ? readNativeCaption().replace(/\s+/g, ' ').trim() : '';
    setTimedCaption(active, currentCue?.text ?? fallback, currentCue);
    if (currentCue) updateFill(time);

    if (currentText && active.translator && !active.receivedCaption) {
      active.receivedCaption = true;
      setNotice('');
    }
    if (!active.translator || active.inFlight) return;
    if (currentText && !cache.has(currentText)) {
      void translateCaption(active, currentText);
      return;
    }
    const upcoming = cues.slice(index + 1, index + 16)
      .find((cue) => cue.start - time <= 60 && !cache.has(cue.text));
    if (upcoming) void translateCaption(active, upcoming.text);
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
    active.inFlight = { text, controller };
    try {
      const result = await translator.translate(text, { signal: controller.signal });
      if (job !== active || controller.signal.aborted || idFromUrl() !== videoId) return;
      if (cache.size >= 4000) cache.delete(cache.keys().next().value);
      cache.set(text, result);
      if (text === currentText || (!active.cues.length && text === active.live.shown)) {
        showTranslation(result);
      }
    } catch (error) {
      if (job !== active || controller.signal.aborted || error?.name === 'AbortError'
        || idFromUrl() !== videoId || translator !== active.translator) return;
      if (translator.kind === 'ai') {
        void fallBack(active, error);
        return;
      }
      stop(false);
      setNotice('翻譯中斷，請在雙語字幕選單重新開啟。');
    } finally {
      active.inFlight = undefined;
      if (job === active) refresh();
    }
  }

  // Built-in translators have no `kind`; AI ones say `kind: 'ai'`.
  async function createTranslator(active, wanted) {
    if (wanted !== 'basic') {
      return createAiTranslator({
        tier: wanted,
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
    return Translator.create({
      ...LANGUAGES,
      signal: active.controller.signal,
      monitor(download) {
        // Quiet once another translator took over (a tier switch mid-download).
        download.addEventListener('downloadprogress', (event) => {
          if (job === active && !active.translator) setNotice(`下載語言模型 ${Math.round(event.loaded * 100)}%`);
        });
      }
    });
  }

  // Replaces the job's translator. Until the new one is ready there is none,
  // so refresh() skips translating; a newer request (tier switch, fallback)
  // or a different job supersedes this one, which then resolves to false.
  async function installTranslator(active, wanted) {
    const request = {};
    active.translatorRequest = request;
    active.inFlight?.controller.abort();
    active.translator?.destroy();
    active.translator = undefined;
    const current = () => job === active && active.translatorRequest === request;
    try {
      const translator = await createTranslator(active, wanted);
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

  // The AI translator failed: carry on with the built-in one, or with English
  // only when that cannot start (no API, or a model that needs a download,
  // which requires a click). Picking the AI tier again retries.
  async function fallBack(active, error) {
    console.warn('[bce] AI 翻譯失敗：', error?.code ?? error);
    cache.clear();
    active.fellBack = 'basic';
    updateMenu();
    const text = error?.code === 'no-key'
      ? '請先在設定頁填入 OpenRouter／Gemini 的 API key，已改用內建翻譯。'
      : error?.code === 'bad-key'
        ? 'API key 無效或沒有權限，已改用內建翻譯。請到設定頁檢查。'
        : 'AI 暫時無法使用，已改用內建翻譯。';
    setNotice(text);
    try {
      if (!(await installTranslator(active, 'basic'))) return;
      setPassingNotice(text);
      refresh();
    } catch {
      // installTranslator left the job without a translator: English only.
      active.fellBack = 'english';
      updateMenu();
      setPassingNotice(globalThis.Translator
        ? 'AI 暫時無法使用，內建翻譯也無法啟動。請在選單把翻譯切到「基本」，再重新開啟雙語字幕下載語言模型。'
        : 'AI 暫時無法使用，這個 Chrome 環境也無法使用內建翻譯。');
    }
  }

  async function switchTier(next) {
    tier = next;
    cache.clear();
    if (job) job.fellBack = undefined;
    updateMenu();
    const active = job;
    if (!active) return;
    if (next === 'basic' && !globalThis.Translator) {
      stop(false);
      setNotice('這個 Chrome 環境無法使用內建翻譯。');
      return;
    }
    try {
      if (!(await installTranslator(active, next))) return;
      updateMenu();
      refresh();
    } catch {
      stop(false);
      setNotice('翻譯中斷，請在雙語字幕選單重新開啟。');
    }
  }

  async function chooseTier(next) {
    // Storage would not change, so retry the AI tier here.
    if (next === tier && tier !== 'basic' && job?.fellBack) {
      void switchTier(next);
      return;
    }
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      await chrome.storage.local.set({ [SETTINGS_KEY]: { ...mergeSettings(stored[SETTINGS_KEY]), tier: next } });
    } catch {
      setNotice('無法儲存翻譯等級，請重新整理頁面。');
    }
  }

  function onSettingsChanged(changes, areaName) {
    if (retired || areaName !== 'local' || !changes[SETTINGS_KEY]) return;
    settings = mergeSettings(changes[SETTINGS_KEY].newValue);
    if (settings.tier !== tier) void switchTier(settings.tier);
    else updateMenu();
  }

  async function loadTier() {
    try {
      const stored = await chrome.storage.local.get(SETTINGS_KEY);
      if (retired) return;
      settings = mergeSettings(stored[SETTINGS_KEY]);
      if (settings.tier !== tier) void switchTier(settings.tier);
      else updateMenu();
    } catch {
      // Orphaned copy: keep the built-in translator.
    }
  }

  function enableNativeCaptions() {
    const cc = player.querySelector('.ytp-subtitles-button');
    if (!cc || cc.disabled || cc.getAttribute('aria-disabled') === 'true'
      || cc.getAttribute('aria-pressed') === null || cc.getClientRects().length === 0) return false;
    if (cc.getAttribute('aria-pressed') === 'false') {
      cc.click();
      const id = videoId;
      restoreCc = () => {
        if (idFromUrl() === id && cc.isConnected && cc.getAttribute('aria-pressed') === 'true') cc.click();
      };
    }
    return true;
  }

  async function begin() {
    if (retired) return;
    syncPage();
    if (!player) return;
    if (job) {
      stop();
      return;
    }

    const video = player.querySelector('video');
    if (!video) return;
    const timed = !imported.length ? cachedTimedText(videoId) : undefined;
    const cues = imported.length ? imported : timed?.cues ?? readTranscript(video);
    const nativeAvailable = !imported.length && enableNativeCaptions();
    // Turning CC on makes the player request captions, which hands
    // page-hook.js the token it needs to download the English track.
    const fetchingTimed = !imported.length && !timed && nativeAvailable;
    const openingTranscript = !cues.length && !fetchingTimed && openTranscript();
    if (!cues.length && !nativeAvailable && !openingTranscript) {
      setNotice('播放器目前沒有可用的 CC。可匯入從 DownSub 下載的英文 SRT。');
      return;
    }
    if (tier === 'basic' && !globalThis.Translator) {
      stop(false);
      setNotice('這個 Chrome 環境無法使用內建翻譯。');
      return;
    }

    const active = {
      controller: new AbortController(),
      receivedCaption: false,
      cues,
      source: imported.length ? importedSource : timed ? timed.source : cues.length ? 'YouTube 逐字稿' : '即時 CC',
      wordTimed: imported.length ? imported.some((cue) => cue.marks?.length) : Boolean(timed?.wordTimed),
      fillGaps: nativeAvailable && !timed,
      ccWasOn: nativeAvailable && !restoreCc,
      live: { raw: '', buffer: '', lastSeen: -Infinity },
      transcriptUntil: openingTranscript ? performance.now() + 2600 : 0,
      nextTranscriptCheck: 0,
    };
    job = active;
    updateToggle();
    setNotice(tier === 'basic' ? '正在準備 Chrome 內建翻譯…' : `正在準備 AI 翻譯（${TIER_LABELS[tier]}）…`);
    player.classList.add('bce-replaces-native');
    if (fetchingTimed) void loadTimedText(active);
    refresh();

    try {
      if (!(await installTranslator(active, tier))) return;
      setNotice(active.cues.length
        ? '已取得時間碼，字幕會跟著影片時間切換。'
        : '播放影片測試。若原文不是英文，請在 YouTube 字幕設定選英文。');
      refresh();
    } catch {
      if (job === active) {
        stop(false);
        setNotice('暫時無法啟動英翻繁中。請確認桌面版 Chrome 支援內建翻譯，再點一次。');
      }
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
        setNotice('讀不到字幕時間碼，請選擇英文 .srt 或 .vtt 檔案。');
        return;
      }
      stop();
      imported = sentenceCues(entries);
      importedSource = source;
      advanceSeconds = 0;
      setNotice(`已讀取 ${entries.length} 段字幕。請在雙語字幕選單開啟。`);
      updateMenu();
    } catch {
      if (idFromUrl() === id) setNotice('無法讀取這個字幕檔。');
    }
  });

  document.addEventListener('yt-navigate-finish', syncPage);
  document.addEventListener('loadedmetadata', syncPage, true);
  document.addEventListener('seeking', resetPosition, true);
  chrome.storage.onChanged.addListener(onSettingsChanged);
  // A short poll catches caption mutations and controls replaced by YouTube.
  const timer = setInterval(() => {
    syncPage();
    refresh();
  }, 75);

  // Only one copy may run: a copy that loads later (another install of this
  // extension, or a reload) tells the earlier one to remove itself.
  document.dispatchEvent(new Event('bce-takeover'));
  document.addEventListener('bce-takeover', () => {
    retired = true;
    clearInterval(timer);
    try {
      chrome.storage.onChanged.removeListener(onSettingsChanged);
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
  void loadTier();
})();
