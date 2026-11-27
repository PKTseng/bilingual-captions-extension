# 專案說明（給 AI agent）

YouTube 原文（英文、日文、韓文、泰文）／繁中雙字幕的 Chrome MV3 擴充功能，無打包工具、無相依套件。使用者介面文字一律用繁體中文。

## 檔案分工

| 檔案 | 執行環境 | 負責 | 對外名稱 |
|---|---|---|---|
| `page-hook.js` | 頁面 world（`"world": "MAIN"`） | 攔截播放器的 timedtext 請求、保存 `pot` token、依原文語言挑選並下載 json3 字幕軌、回報影片標題／頻道／說明 | 只透過 `postMessage` 溝通 |
| `languages.js` | content script、工具列小視窗 | 支援的原文語言與斷句特性（`traitsOf`）、偏好值合併、依文字判斷語言（純函式） | `globalThis.bceLanguages` |
| `captions.js` | content script | json3 事件 → 依字詞時間斷句的 cue，依語言特性處理無空格語言（純函式） | `globalThis.bceCaptions` |
| `subtitle-parser.js` | content script | 解析 SRT／VTT（純函式） | `globalThis.bceSubtitleParser` |
| `transcript.js` | content script | 行狀 cue → 整句 cue（`sentenceCues`）、讀取／打開 YouTube 逐字稿面板 | `globalThis.bceTranscript` |
| `page-bridge.js` | content script | 與 `page-hook.js` 的 postMessage 通道、字幕軌與影片資訊快取 | `globalThis.bcePageBridge` |
| `settings.js` | content script、背景程式（`importScripts`）、設定頁 | 翻譯等級、模型、詞彙表、修正自動字幕、整部預翻的預設值與合併（`mergeSettings`）、詞彙表解析、組 chat completions 請求（純函式） | `globalThis.bceSettings` |
| `ai-translator.js` | content script、設定頁 | 分批 AI 翻譯器，介面同內建 `Translator`（`translate`／`destroy`，另有 `kind: 'ai'`、`prefetch`、`sourceOf`），每批從注入的 `getContext` 讀語言／影片資訊／詞彙表，經注入的 `send` 交給背景程式 | `globalThis.bceAiTranslator` |
| `translation-store.js` | content script、設定頁 | 把 AI 譯文（與修正後的原文）依影片＋模型存進 `chrome.storage.local`（延遲合併寫入、超過 300 筆刪最舊）、統計與清除 | `globalThis.bceTranslationStore` |
| `usage.js` | 背景程式（`importScripts`）、設定頁、工具列小視窗 | 按月累計 OpenRouter 回報的 AI 費用與 token（`bceUsage`）、判斷是否超過每月上限、格式化（純函式） | `globalThis.bceUsage` |
| `content.js` | content script | 主程式：UI、字幕渲染、`job` 狀態機、原文語言、翻譯（依等級建立翻譯器、AI 失敗退回內建、整部預翻）、回應工具列小視窗、事件綁定 | 無（最後載入） |
| `background.js` | service worker | 讀 API key（設定頁或本機 `.env`）、代為呼叫 OpenRouter、記錄用量並在超過每月上限時回 `budget` | 只透過 `chrome.runtime` 訊息溝通 |
| `options.html`／`options.js` | 擴充功能選項頁 | 編輯預設等級、模型、API key、詞彙表與 AI 選項 | 無 |
| `popup.html`／`popup.js` | 工具列小視窗（`action`） | 開關雙語字幕、選原文語言、顯示目前分頁狀態 | 無 |
| `welcome.html` | 擴充功能頁 | 從工具列小視窗開啟的使用說明（靜態，沒有 script） | 無 |
| `subtitles.css` | content script | 所有樣式，class 前綴 `bce-` | |

## 慣例

- content script 不能用 ES `import`。每個模組包在 IIFE 裡，把 API 掛到 `globalThis.bceXxx`；`content.js` 開頭再解構成區域變數。這些全域只存在於擴充功能的 isolated world，網頁讀不到。
- **載入順序以 `manifest.json` 的 `content_scripts[1].js` 為準**：被依賴的檔案要排在前面（`languages.js` 第一個），`content.js` 永遠最後。新增模組時記得同步更新 manifest。
- AI 用量只由 `background.js` 寫入 `bceUsage`，寫入要串成一條 promise 鏈（同時回來的請求不能互相覆蓋）。每月上限存在 `bceSettings.monthlyLimit`。
- 純函式模組（`languages.js`、`usage.js`、`captions.js`、`transcript.js`、`settings.js`、`ai-translator.js`、`translation-store.js`；後者的 storage 由參數注入）結尾有 `module.exports`，可以直接在 Node 裡 `require` 測試（`node --test tests/`）。`content.js` 與 `page-hook.js` 用 `vm` 跑在模擬環境裡測試；`content.js` 的模擬播放器在 `tests/player-harness.js`。
- 原文語言：偏好值存在 `bceSourceLanguage`（`'auto'` 或語言代碼），`job.language` 是目前實際使用的語言。`page-hook.js` 在頁面 world，讀不到 `languages.js`，它自己的 `SOURCE_CODES` 要和 `languages.js` 的 `LANGUAGES` 保持一致。新增語言時兩邊都要改，並確認 `captions.js`／`transcript.js` 的斷句規則適用。
- 兩個 world 之間的訊息：頁面 → content 用 `source: 'bce-timedtext'`，content → 頁面用 `source: 'bce-content'`，`type` 是 `'load'`（下載字幕軌）或 `'details'`（影片資訊），都帶 `language` 偏好值。
- content → 背景程式：`chrome.runtime.sendMessage({ type: 'bce-ai', tier, messages })`，回覆 `{ ok: true, text }` 或 `{ ok: false, error }`。工具列小視窗 → content：`chrome.tabs.sendMessage(tabId, { type: 'bce-status' })`。設定存在 `chrome.storage.local` 的 `bceSettings`，API key 存在 `bceKeys`；**只有 `background.js` 與設定頁可讀 `bceKeys`**，`content.js` 只讀等級與 AI 選項。
- 會依賴 `job`、`player`、`currentText` 等共用狀態的邏輯留在 `content.js`，不要拆出去。
- 已存譯文的 key 是 `bceTx<版本>:<videoId>|<provider/model>`，詞彙表或修正設定不是預設值時後面再加 `~<translationProfile>`；索引在 `bceTx<版本>Index`。**改了 `ai-translator.js` 的 prompt 或回覆格式時，要把 `translation-store.js` 的 `VERSION` 加一**，舊譯文就不會再被使用。
