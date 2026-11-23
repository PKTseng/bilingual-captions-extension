# 播放器選單 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 點播放器上的雙語字幕圖示打開仿 YouTube 設定的選單，在裡面開關雙語字幕、切換翻譯等級（顯示模型名稱）、調字幕時間、匯入字幕、打開設定頁。

**Architecture:** `settings.js` 新增純函式 `describeTier` 產生等級標籤；`content.js` 建立 `bce-menu` 面板（主選單＋「翻譯」「字幕時間」兩個子選單），取代左鍵開關與右鍵卡片；`background.js` 處理 `bce-open-options`。

**Tech Stack:** Chrome MV3、原生 JS、`node --test tests/`。

**Spec:** `docs/superpowers/specs/2026-11-24-player-menu-design.md`

## Global Constraints

- 使用者介面文字一律繁體中文；class 前綴 `bce-`。
- 無打包工具、無相依套件；共用狀態邏輯留在 `content.js`。
- content script 只讀等級與模型名稱（`SETTINGS_KEY`），不讀 `KEYS_KEY`。
- YouTube 有 Trusted Types：DOM 一律用 `createElement`／`textContent`，不用 `innerHTML`。
- 字幕時間範圍維持 ±10 秒、每次 0.5 秒。

## Review Focus

- **在選單裡點擊**：不能讓影片暫停／播放、不能觸發 YouTube 的快捷操作或全螢幕（比照字幕卡片的 stopPropagation 清單）。→ Task 2 Step 2 要求 + 手動檢查 2。
- **全螢幕、劇院模式、換影片**：選單要跟著播放器、換影片時關閉。→ Task 2 Step 2（掛在 player 底下、`syncPage` 換影片時關閉）+ 手動檢查 5。
- **擴充功能重新載入後的舊頁面**：點「API key 與模型設定…」時 `chrome.runtime.sendMessage` 會丟錯，不能讓選單壞掉。→ Task 2 Step 3 try/catch。
- **選單開著時狀態改變**（AI 退回、別的分頁改了等級、字幕來源變了）：選單內容要即時更新。→ Task 2 Step 2 `updateMenu()` 呼叫點。
- **模型名稱很長**（`anthropic/claude-sonnet-5.5`、`xxx:free`）：標籤只顯示最後一段，不撐破選單。→ Task 1 測試。

---

### Task 1: `describeTier` 等級標籤

**Files:**
- Modify: `settings.js`
- Test: `tests/settings.test.js`

**Interfaces:**
- Produces（`globalThis.bceSettings` 與 `module.exports`）：`describeTier(settings, tier) => string`
  - `'basic'` → `'基本（Chrome 內建）'`
  - AI 等級 → `` `${TIER_LABELS[tier]} · ${模型名稱最後一個 '/' 之後的部分}` ``
  - 未知 tier → `TIER_LABELS.basic` 的標籤 `'基本（Chrome 內建）'`

- [ ] **Step 1: 寫失敗的測試**（加在 `tests/settings.test.js`）

```js
test('describeTier labels tiers with short model names', () => {
  const settings = s.mergeSettings({
    aiFree: { provider: 'openrouter', model: 'meta-llama/llama-4:free' },
    aiPro: { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' },
  });
  assert.equal(s.describeTier(settings, 'basic'), '基本（Chrome 內建）');
  assert.equal(s.describeTier(settings, 'aiFree'), 'AI 免費 · llama-4:free');
  assert.equal(s.describeTier(settings, 'aiPro'), 'AI 進階 · claude-sonnet-5.5');
  assert.equal(s.describeTier(s.mergeSettings({}), 'aiFree'), `AI 免費 · ${s.DEFAULT_SETTINGS.aiFree.model}`);
  assert.equal(s.describeTier(settings, 'weird'), '基本（Chrome 內建）');
});
```

- [ ] **Step 2: 執行確認失敗**

Run: `node --test tests/`
Expected: FAIL，`s.describeTier is not a function`

- [ ] **Step 3: 在 `settings.js` 實作並匯出 `describeTier`**

- [ ] **Step 4: 執行確認通過**

Run: `node --test tests/`
Expected: PASS（20 tests）

- [ ] **Step 5: Commit**

```bash
git add settings.js tests/settings.test.js
git commit -m "feat: 新增翻譯等級標籤函式"
```

---

### Task 2: 播放器選單

**Files:**
- Modify: `content.js`、`subtitles.css`、`background.js`、`README.md`

**Interfaces:**
- Consumes: Task 1 的 `describeTier`；既有的 `begin()`（有 job 時停止、沒有時開始）、`chooseTier(name)`、`shiftTiming(amount)`、`advanceSeconds`、`job.fellBack`（`'basic'`／`'english'`／undefined）、`fileInput`、`stop()`、`syncPage()`。
- Produces: 背景訊息 `{ type: 'bce-open-options' }`。

- [ ] **Step 1: 背景程式打開設定頁**

`background.js` 的 `onMessage`：`type === 'bce-open-options'` 時呼叫 `chrome.runtime.openOptionsPage()`，不回應（`return` 非 true）。既有 `bce-ai` 處理不變。

- [ ] **Step 2: 建立選單**

- 新增 `.bce-menu` 面板（`role="menu"`、`dataset.bce = 'current'`），與 `overlay`／`notice` 一起掛在 `player` 底下、位置在控制列上方靠右（對齊圖示附近）；`syncPage` 移除／重掛時一併處理，換影片時關閉選單；`bce-takeover` 時移除。
- `let settings = mergeSettings()`：`loadTier` 與 `onSettingsChanged` 時更新（只讀 `SETTINGS_KEY`）。
- 三個頁面，由 `renderMenu()` 依 `menuPage`（`'main'`／`'tier'`／`'timing'`）重建內容：
  - **main**：
    - `雙語字幕` ＋ 開關（`role="menuitemcheckbox"`、`aria-checked` 依 `Boolean(job)`），點擊呼叫 `begin()`。
    - `翻譯` ＋ 右側目前值 ＋ `›`：目前值為 `describeTier(settings, tier)`；`job?.fellBack` 且 `tier !== 'basic'` 時改為 `基本（AI 已暫停）` 或 `僅英文（AI 已暫停）`。點了進 `tier` 頁。
    - `字幕時間` ＋ 右側目前值 ＋ `›`：`原始`、`提早 N.N 秒`、`延後 N.N 秒`；沒有時間碼（沿用舊 `showTiming` 的 `timed` 判斷）時停用。點了進 `timing` 頁。
    - `匯入英文 SRT／VTT`：`fileInput.click()`，關閉選單。
    - `API key 與模型設定…`：Step 3，關閉選單。
    - 底部小字：字幕來源（沿用舊 `showTiming` 的 `sourceText` 組法：來源、是否含字詞時間碼；沒有來源時顯示 `尚未選擇字幕來源`）。
  - **tier**：`‹ 翻譯`（回 main）、三列 `describeTier(settings, name)`，`tier === name` 的打勾（`role="menuitemradio"`、`aria-checked`）。點擊呼叫 `chooseTier(name)` 後回 main。
  - **timing**：`‹ 字幕時間`（回 main）、`提早 0.5 秒`（`shiftTiming(0.5)`，`advanceSeconds >= 10` 時停用）、`延後 0.5 秒`（`shiftTiming(-0.5)`，`<= -10` 停用）、`重設`（`advanceSeconds = 0` 後 `refresh()`）；停留在本頁並更新數值。
- 開關：圖示 `click` 改為切換選單開／關（打開時 `menuPage = 'main'`）；移除 `contextmenu` 處理。點選單與圖示以外的地方（document 捕捉階段 `pointerdown`）或按 `Escape` 關閉。
- 選單上的 pointer／mouse／click／dblclick／contextmenu／keydown 事件 `stopPropagation`，比照字幕卡片的做法，避免 YouTube 暫停或觸發快捷鍵。
- `updateMenu()`：選單開著時呼叫 `renderMenu()`；在 `updateToggle`、`switchTier`、`fallBack`、`shiftTiming`、`onSettingsChanged`、字幕來源改變（`loadTimedText` 完成、匯入完成）後呼叫。
- 移除舊的 `timing` 面板、`sourceLabel`、`earlier`／`later`、`tierRow`／`tierButtons`、`showTiming`，以及 `setNotice`／`setPassingNotice` 裡對 `timing.hidden` 的依賴（`setPassingNotice` 只比對文字）。提示卡片保留 `message`、`importButton`、`fileInput`。
- 圖示的 `title`／`aria-label` 改為 `雙語字幕選單`，`aria-pressed` 照舊表示雙語字幕開啟中；加上 `aria-haspopup="menu"`、`aria-expanded`。

- [ ] **Step 3: 打開設定頁**

`API key 與模型設定…` 送 `{ type: 'bce-open-options' }`，用 `try { chrome.runtime.sendMessage(...)?.catch?.(() => {}) } catch {}` 包住，失敗時 `setPassingNotice('無法打開設定頁，請重新整理頁面。')`。

- [ ] **Step 4: 調整提示文字**

- `翻譯中斷，請再按一次 EN／中。` → `翻譯中斷，請在雙語字幕選單重新開啟。`
- `AI 暫時無法使用，內建翻譯也無法啟動。請切到「基本」並按 EN／中下載語言模型。` → `AI 暫時無法使用，內建翻譯也無法啟動。請在選單把翻譯切到「基本」，再重新開啟雙語字幕下載語言模型。`
- `已讀取 ${n} 段字幕。請按 EN／中開始翻譯。` → `已讀取 ${n} 段字幕。請在雙語字幕選單開啟。`
- 播放器讀不到字幕時的提示 `…可匯入從 DownSub 下載的英文 SRT。` 保持不變（卡片上仍有匯入按鈕）。

- [ ] **Step 5: 樣式**

`subtitles.css` 新增 `.bce-menu` 系列：參考 YouTube 設定選單（深色半透明背景約 `rgba(28,28,28,.9)`、圓角 12px、白字、列高約 40px、hover 淡色底、右側值為淺灰、子選單返回列有下框線、開關為小型膠囊開關、停用列半透明）；寬度約 300px、最大高度不超過播放器高度減控制列；`[hidden]` 時 `display: none !important`。移除不再使用的 `.bce-timing`、`.bce-source`、`.bce-tiers` 規則。

- [ ] **Step 6: README**

把「右鍵點 EN／中」「右鍵面板」等說明改成選單操作：點圖示打開選單、各列用途、`API key 與模型設定…` 打開設定頁、退回後在「翻譯」子選單點原本的 AI 等級重試。

- [ ] **Step 7: 靜態檢查與測試**

Run: `node --check content.js`、`node --check background.js`、`node --test tests/`
Expected: 語法檢查無輸出；測試 PASS（20 tests）

給使用者的 Chrome 手動檢查：
1. 點圖示打開選單，再點一次、點外面、按 Esc 都會關閉。
2. 在選單上點擊不會讓影片暫停。
3. 開關雙語字幕、切換三個等級（標籤顯示模型名稱）、調整字幕時間都正常，選單內容即時更新。
4. 「API key 與模型設定…」會打開設定頁；在設定頁改模型後，選單的標籤跟著變。
5. 全螢幕和劇院模式下選單位置正確；換影片時選單關閉。

- [ ] **Step 8: Commit**

```bash
git add content.js subtitles.css background.js README.md
git commit -m "feat: 播放器圖示改為打開雙語字幕選單"
```
