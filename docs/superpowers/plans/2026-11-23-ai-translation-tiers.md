# AI 翻譯等級 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者在「基本（Chrome 內建）／AI 免費／AI 進階」三個翻譯等級間切換，AI 走 OpenRouter 或 Gemini 的 OpenAI 相容 API，失敗時自動退回內建翻譯。

**Architecture:** 新增 `settings.js`（設定預設值與 API 請求組裝，純函式，三個環境共用）、`ai-translator.js`（與 Chrome `Translator` 同介面的 AI 翻譯器，負責分批與解析）、`background.js`（唯一發出 API 請求的 service worker）、`options.html/js`（設定頁）。`content.js` 依目前等級建立翻譯器，並在播放器的「字幕設定」面板加等級切換。

**Tech Stack:** Chrome MV3、原生 JS（無打包、無相依）、測試用 Node 內建 `node:test`（`node --test tests/`）。

**Spec:** `docs/superpowers/specs/2026-11-23-ai-translation-tiers-design.md`

## Global Constraints

- 使用者介面文字一律繁體中文。
- 無打包工具、無相依套件；content script 模組包在 IIFE 裡，API 掛到 `globalThis.bceXxx`，結尾 `if (typeof module !== 'undefined') module.exports = ...` 供 Node 測試。
- `manifest.json` 的 `content_scripts[1].js` 順序：被依賴的在前，`content.js` 最後。
- API key 只在 `background.js` 與設定頁讀取；`content.js` 只讀等級。
- Provider 端點：OpenRouter `https://openrouter.ai/api/v1/chat/completions`；Gemini `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`。兩者都用 `Authorization: Bearer <key>`。
- 批次大小 40 句，前文 5 句。
- 退回內建翻譯時的提示：`AI 暫時無法使用，已改用內建翻譯。`

## Review Focus

- **選了 AI 等級但沒填 key**：應退回內建翻譯並提示「請先在設定頁填入 OpenRouter／Gemini 的 API key」，而不是一直重試。→ Task 1 `buildChatRequest` 回 `{ error: 'no-key' }` 的測試；Task 4 依 `no-key` 顯示專屬提示。
- **免費層中途 429（額度／速率）**：不能停掉字幕，要退回內建翻譯。→ Task 2 測試 `send` 回 `{ ok: false, error: 'http-429' }` 時 `translate` 以帶 `code` 的錯誤拒絕；Task 4 的退回邏輯處理。
- **模型回傳包在 ```json 圍欄裡、或句數不對**：圍欄要能解析；句數不符要整批失敗、不能錯位配對。→ Task 2 `parseBatchReply` 測試。
- **使用者拖動進度條（abort）時批次還在跑**：該次 `translate` 以 AbortError 拒絕，但批次結果仍存下，之後翻同批句子不再發請求。→ Task 2 測試。
- **逐字稿有重複句子、或沒有逐字稿（即時 CC）**：同一批不重複送；即時 CC 只送單句並附最近翻過的 5 句當前文。→ Task 2 測試。

---

### Task 1: 共用設定模組 `settings.js`

**Files:**
- Create: `settings.js`
- Test: `tests/settings.test.js`

**Interfaces:**
- Produces（`globalThis.bceSettings` 與 `module.exports`）：
  - `TIERS: ['basic', 'aiFree', 'aiPro']`
  - `TIER_LABELS: { basic: '基本', aiFree: 'AI 免費', aiPro: 'AI 進階' }`
  - `PROVIDERS: { openrouter: { label: 'OpenRouter', url }, gemini: { label: 'Gemini', url } }`
  - `DEFAULT_SETTINGS: { tier: 'basic', aiFree: { provider: 'gemini', model }, aiPro: { provider: 'openrouter', model } }`
  - `mergeSettings(stored: object|undefined) => settings`：缺的欄位補預設值，未知 tier 改回 `'basic'`。
  - `buildChatRequest(settings, keys: { openrouter?: string, gemini?: string }, tier, messages) => { url, init } | { error: 'no-key' | 'bad-tier' }`
  - storage key 名稱：`SETTINGS_KEY = 'bceSettings'`、`KEYS_KEY = 'bceKeys'`

- [ ] **Step 1: 寫失敗的測試** `tests/settings.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../settings.js');

test('mergeSettings fills defaults and rejects unknown tier', () => {
  assert.deepEqual(s.mergeSettings(undefined), s.DEFAULT_SETTINGS);
  assert.equal(s.mergeSettings({ tier: 'weird' }).tier, 'basic');
  const m = s.mergeSettings({ tier: 'aiPro', aiPro: { model: 'x/y' } });
  assert.equal(m.tier, 'aiPro');
  assert.equal(m.aiPro.model, 'x/y');
  assert.equal(m.aiPro.provider, 'openrouter');
});

test('buildChatRequest targets provider endpoint with bearer key', () => {
  const settings = s.mergeSettings({ aiPro: { provider: 'openrouter', model: 'm1' } });
  const msgs = [{ role: 'user', content: 'hi' }];
  const req = s.buildChatRequest(settings, { openrouter: 'k1' }, 'aiPro', msgs);
  assert.equal(req.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(req.init.method, 'POST');
  assert.equal(req.init.headers.Authorization, 'Bearer k1');
  assert.deepEqual(JSON.parse(req.init.body), { model: 'm1', messages: msgs, temperature: 0.2 });
});

test('buildChatRequest reports missing key and basic tier', () => {
  const settings = s.mergeSettings({});
  assert.deepEqual(s.buildChatRequest(settings, {}, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: '  ' }, 'aiFree', []), { error: 'no-key' });
  assert.deepEqual(s.buildChatRequest(settings, { gemini: 'k' }, 'basic', []), { error: 'bad-tier' });
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test tests/`
Expected: FAIL，`Cannot find module '../settings.js'`

- [ ] **Step 3: 實作 `settings.js`**

IIFE 包住，掛 `globalThis.bceSettings`，結尾 `module.exports`。key 先 `trim()` 再判斷空字串。預設模型名稱：到 `https://ai.google.dev/gemini-api/docs/models` 選目前免費層可用、最新的 Flash 模型給 `aiFree`；到 `https://openrouter.ai/models` 選一個翻譯品質好的付費模型（Claude Sonnet 或 GPT 同級）給 `aiPro`。把選了哪兩個寫進 commit 訊息。

- [ ] **Step 4: 執行確認通過**

Run: `node --test tests/`
Expected: PASS（3 tests）

- [ ] **Step 5: Commit**

```bash
git add settings.js tests/settings.test.js
git commit -m "feat: 新增翻譯等級設定模組"
```

---

### Task 2: AI 翻譯器 `ai-translator.js`

**Files:**
- Create: `ai-translator.js`
- Test: `tests/ai-translator.test.js`

**Interfaces:**
- Consumes: 無（`send` 由呼叫端注入）。
- Produces（`globalThis.bceAiTranslator` 與 `module.exports`）：
  - `BATCH_SIZE = 40`、`CONTEXT_SIZE = 5`
  - `buildBatch(sentences: string[], text: string, done: (t) => boolean, recent: string[]) => { lines: string[], context: string[] }`：`text` 在 `sentences` 中時，從它的第一個出現位置往後取未完成且不重複的句子，最多 `BATCH_SIZE` 句（`text` 一定是第一句），前文取該位置前 `CONTEXT_SIZE` 句；不在其中時 `lines = [text]`、`context = recent` 的最後 `CONTEXT_SIZE` 句。
  - `buildMessages({ lines, context }) => [{ role: 'system', content }, { role: 'user', content }]`：system 要求譯成台灣用語繁體中文、保留專有名詞、只回 JSON `{"t":[...]}`，項數與順序和 `lines` 相同；user 是 `JSON.stringify({ context, lines })`。
  - `parseBatchReply(reply: string, count: number) => string[]`：去掉 ```json 圍欄，取第一個 `{` 到最後一個 `}` 解析；`t` 不是長度 `count` 的字串陣列就丟 `Error`。
  - `createAiTranslator({ tier, getSentences: () => string[], send: (payload) => Promise<{ ok: true, text } | { ok: false, error }> }) => { kind: 'ai', translate(text, { signal }) => Promise<string>, destroy() }`
    - `send` 的 payload：`{ type: 'bce-ai', tier, messages }`。
    - 失敗時以 `Error` 拒絕，`error.code` 為 `send` 回的 `error`（例如 `'no-key'`、`'http-429'`），解析錯誤為 `'bad-reply'`。
    - `signal` abort 時以 `DOMException('…', 'AbortError')` 拒絕，但批次照常完成並存入結果。
    - `destroy()` 後所有 `translate` 以 AbortError 拒絕。

- [ ] **Step 1: 寫失敗的測試** `tests/ai-translator.test.js`

```js
const test = require('node:test');
const assert = require('node:assert/strict');
const ai = require('../ai-translator.js');

const reply = (lines) => ({ ok: true, text: JSON.stringify({ t: lines.map((l) => `中:${l}`) }) });
function fakeSend() {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
    const { lines } = JSON.parse(payload.messages[1].content);
    return reply(lines);
  };
  return { calls, send };
}

test('buildBatch takes following unique undone lines with preceding context', () => {
  const s = ['a', 'b', 'c', 'b', 'd', 'e', 'f', 'g'];
  const b = ai.buildBatch(s, 'd', (t) => t === 'e', []);
  assert.deepEqual(b.lines, ['d', 'f', 'g']);
  assert.deepEqual(b.context, ['a', 'b', 'c', 'b']);
  assert.deepEqual(ai.buildBatch(s, 'b', () => false, []).lines, ['b', 'c', 'd', 'e', 'f', 'g']);
});

test('buildBatch for live captions sends one line with recent context', () => {
  const b = ai.buildBatch([], 'x', () => false, ['1', '2', '3', '4', '5', '6']);
  assert.deepEqual(b, { lines: ['x'], context: ['2', '3', '4', '5', '6'] });
});

test('parseBatchReply strips fences and checks count', () => {
  assert.deepEqual(ai.parseBatchReply('```json\n{"t":["甲","乙"]}\n```', 2), ['甲', '乙']);
  assert.throws(() => ai.parseBatchReply('{"t":["甲"]}', 2));
  assert.throws(() => ai.parseBatchReply('not json', 1));
});

test('one batch request serves following sentences', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => ['a', 'b', 'c'], send });
  assert.equal(await t.translate('a', {}), '中:a');
  assert.equal(await t.translate('c', {}), '中:c');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].type, 'bce-ai');
  assert.equal(calls[0].tier, 'aiFree');
});

test('failure rejects with code from background', async () => {
  const t = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => [], send: async () => ({ ok: false, error: 'http-429' }) });
  await assert.rejects(t.translate('a', {}), (e) => e.code === 'http-429');
  const bad = ai.createAiTranslator({ tier: 'aiFree', getSentences: () => [], send: async () => ({ ok: true, text: 'oops' }) });
  await assert.rejects(bad.translate('a', {}), (e) => e.code === 'bad-reply');
});

test('abort rejects the caller but keeps batch results', async () => {
  const { calls, send } = fakeSend();
  const t = ai.createAiTranslator({ tier: 'aiPro', getSentences: () => ['a', 'b'], send });
  const controller = new AbortController();
  const pending = t.translate('a', { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e) => e.name === 'AbortError');
  assert.equal(await t.translate('b', {}), '中:b');
  assert.equal(calls.length, 1);
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test tests/`
Expected: ai-translator 測試 FAIL，`Cannot find module '../ai-translator.js'`

- [ ] **Step 3: 實作 `ai-translator.js`**

內部用 `results: Map<text, string>` 存結果、`pending: Map<text, Promise<void>>` 讓同一批的句子等同一個請求、`recent: string[]` 記最近翻過的原文。`translate` 先查 `results`，再等 `pending`，都沒有才 `buildBatch` → `send`。對呼叫端用 `Promise.race` 搭配 signal 的 abort 事件，讓 abort 只影響回傳，不影響批次。

- [ ] **Step 4: 執行確認通過**

Run: `node --test tests/`
Expected: PASS（Task 1 的 3 個 + 本 task 的 6 個）

- [ ] **Step 5: Commit**

```bash
git add ai-translator.js tests/ai-translator.test.js
git commit -m "feat: 新增分批 AI 翻譯器"
```

---

### Task 3: 背景程式、設定頁與 manifest

**Files:**
- Create: `background.js`、`options.html`、`options.js`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: Task 1 的 `mergeSettings`、`buildChatRequest`、`PROVIDERS`、`TIER_LABELS`、`SETTINGS_KEY`、`KEYS_KEY`。
- Produces:
  - `background.js` 監聽 `chrome.runtime.onMessage`，處理 `{ type: 'bce-ai', tier, messages }`，以 `sendResponse` 回 `{ ok: true, text }` 或 `{ ok: false, error }`（`'no-key'`、`'bad-tier'`、`'http-<status>'`、`'network'`、`'bad-reply'`），listener `return true`。`text` 取 `choices[0].message.content`。
  - 設定頁存 `chrome.storage.local`：`bceSettings`（等級與模型，不含 key）、`bceKeys`（`{ openrouter, gemini }`）。

- [ ] **Step 1: 寫 `background.js`**

開頭 `importScripts('settings.js')`。讀兩個 storage key → `mergeSettings` → `buildChatRequest` → `fetch`。非 2xx 回 `http-<status>`；fetch 丟錯回 `network`；JSON 裡沒有字串 content 回 `bad-reply`。

- [ ] **Step 2: 寫 `options.html` 與 `options.js`**

欄位：預設等級（三個單選，標籤用 `TIER_LABELS`）；OpenRouter key、Gemini key（`type="password"`）；「AI 免費」和「AI 進階」各一組服務下拉（OpenRouter／Gemini）和模型文字欄。按「儲存」寫入 storage，顯示「已儲存」。每個 AI 等級旁邊放「測試」按鈕，送 `{ type: 'bce-ai', tier, messages: [{ role: 'user', content: '請只回覆：連線成功' }] }` 給背景程式，把回覆或錯誤代碼顯示出來。`options.html` 用 `<script src="settings.js">` 再載 `options.js`。

- [ ] **Step 3: 修改 `manifest.json`**

- `version` 改 `0.8.0`，`description` 改成「在 YouTube 顯示英文和繁體中文雙字幕，可選 Chrome 內建翻譯或 AI 翻譯。」
- 加 `"permissions": ["storage"]`
- 加 `"host_permissions": ["https://openrouter.ai/*", "https://generativelanguage.googleapis.com/*"]`
- 加 `"background": { "service_worker": "background.js" }`
- 加 `"options_page": "options.html"`

- [ ] **Step 4: 在 Chrome 手動驗證**

到 `chrome://extensions` 重新載入擴充功能 → 「詳細資料 → 擴充功能選項」打開設定頁。填 Gemini key，按「AI 免費」的「測試」。
Expected：顯示「連線成功」之類的回覆；service worker 的檢查視窗沒有錯誤。清空 key 再測，Expected：顯示 `no-key`。

- [ ] **Step 5: 執行既有測試並 Commit**

Run: `node --test tests/`，Expected: PASS（9 tests）

```bash
git add background.js options.html options.js manifest.json
git commit -m "feat: 新增 AI 翻譯背景程式與設定頁"
```

---

### Task 4: `content.js` 接上翻譯等級

**Files:**
- Modify: `content.js`（`begin` 約 627-699、`translateCaption` 約 592-611、`showTiming` 約 94-105、頂端元素建立約 73-80）
- Modify: `manifest.json`（`content_scripts[1].js`）
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 的 `bceSettings`（`mergeSettings`、`TIERS`、`TIER_LABELS`、`SETTINGS_KEY`）；Task 2 的 `bceAiTranslator.createAiTranslator`；Task 3 的背景訊息 `{ type: 'bce-ai', ... }`。
- Produces: 無（最後載入）。

- [ ] **Step 1: 調整載入順序**

`content_scripts[1].js` 改為 `captions.js`、`subtitle-parser.js`、`transcript.js`、`page-bridge.js`、`settings.js`、`ai-translator.js`、`content.js`。

- [ ] **Step 2: 讀取與保存等級**

`content.js` 新增狀態 `let tier = 'basic'`。啟動時讀 `chrome.storage.local.get(SETTINGS_KEY)` → `mergeSettings` 取 `tier`；監聽 `chrome.storage.onChanged`，等級改變時呼叫 Step 4 的 `switchTier`。

- [ ] **Step 3: 依等級建立翻譯器**

新增 `async function createTranslator(active, wanted)`：`wanted === 'basic'` 時沿用現有 `Translator.create`（含下載進度）；否則回 `createAiTranslator({ tier: wanted, getSentences: () => active.cues.map((cue) => cue.text), send: (payload) => chrome.runtime.sendMessage(payload) })`。`begin` 改用它：只有 `tier === 'basic'` 且沒有 `globalThis.Translator` 時才顯示「這個 Chrome 環境無法使用內建翻譯。」並停止；「正在準備…」提示依等級顯示「Chrome 內建翻譯」或「AI 翻譯（{TIER_LABELS[tier]}）」。

- [ ] **Step 4: 退回內建翻譯與切換等級**

- `translateCaption` 的 catch：`active.translator.kind === 'ai'` 且不是 abort 時，`destroy` 它，改用 `createTranslator(active, 'basic')`，`cache.clear()`，並提示：錯誤 code 為 `no-key` 時顯示「請先在設定頁填入 OpenRouter／Gemini 的 API key，已改用內建翻譯。」，其他顯示 `AI 暫時無法使用，已改用內建翻譯。`。沒有 `globalThis.Translator` 時維持原本的停止與「翻譯中斷」提示。
- 新增 `async function switchTier(next)`：設定 `tier`、`cache.clear()`；有 `job` 時 abort `inFlight`、destroy 舊翻譯器、用 `createTranslator(job, next)` 換上新的，再 `refresh()`。

- [ ] **Step 5: 播放器面板加等級切換**

在 `timing` 面板加一列三個按鈕（class `bce-import`，文字用 `TIER_LABELS`），目前等級的按鈕加 `aria-pressed="true"`，在 `subtitles.css` 加對應的選取樣式。點擊時寫入 `chrome.storage.local`（`SETTINGS_KEY`，只改 `tier`）；實際切換由 Step 2 的 `onChanged` 觸發。`showTiming` 更新按鈕狀態，並在來源文字後加「 · 翻譯：{等級}」。

- [ ] **Step 6: 更新 README**

在「使用」後加「翻譯等級」一節：三個等級說明、設定頁位置（擴充功能選項）、Gemini 免費層與 OpenRouter `:free` 模型有次數限制、AI 失敗時自動改用內建翻譯、字幕會送到所選服務。

- [ ] **Step 7: 在 Chrome 手動驗證**

重新載入擴充功能並重新整理 YouTube，找一部有英文字幕的影片：
1. 基本等級：行為與改版前相同。
2. 右鍵 EN／中 → 切到「AI 免費」：字幕改由 AI 翻譯，換句時幾乎沒有延遲（同批已翻好）。
3. 在設定頁清空 Gemini key 後播放：出現 no-key 提示，字幕繼續以內建翻譯顯示。
4. 拖動進度條到後段：新位置的字幕在一兩秒內出現翻譯。
5. 沒有字幕軌、只能用即時 CC 的影片：AI 等級仍能逐句翻譯。

- [ ] **Step 8: 執行測試並 Commit**

Run: `node --test tests/`，Expected: PASS（9 tests）

```bash
git add content.js manifest.json subtitles.css README.md
git commit -m "feat: 播放器支援切換翻譯等級並在 AI 失敗時退回內建翻譯"
```
