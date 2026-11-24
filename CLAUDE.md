# 專案說明（給 AI agent）

YouTube 英／繁中雙字幕的 Chrome MV3 擴充功能，無打包工具、無相依套件。使用者介面文字一律用繁體中文。

## 檔案分工

| 檔案 | 執行環境 | 負責 | 對外名稱 |
|---|---|---|---|
| `page-hook.js` | 頁面 world（`"world": "MAIN"`） | 攔截播放器的 timedtext 請求、保存 `pot` token、代為下載 json3 字幕軌 | 只透過 `postMessage` 溝通 |
| `captions.js` | content script | json3 事件 → 依字詞時間斷句的 cue（純函式） | `globalThis.bceCaptions` |
| `subtitle-parser.js` | content script | 解析 SRT／VTT（純函式） | `globalThis.bceSubtitleParser` |
| `transcript.js` | content script | 行狀 cue → 整句 cue（`sentenceCues`）、讀取／打開 YouTube 逐字稿面板 | `globalThis.bceTranscript` |
| `page-bridge.js` | content script | 與 `page-hook.js` 的 postMessage 通道、字幕軌快取 | `globalThis.bcePageBridge` |
| `settings.js` | content script、背景程式（`importScripts`）、設定頁 | 翻譯等級與模型的預設值、合併儲存值（`mergeSettings`）、組 chat completions 請求（純函式） | `globalThis.bceSettings` |
| `ai-translator.js` | content script | 分批 AI 翻譯器，介面同內建 `Translator`（`translate`／`destroy`，另有 `kind: 'ai'`），經注入的 `send` 交給背景程式 | `globalThis.bceAiTranslator` |
| `content.js` | content script | 主程式：UI、字幕渲染、`job` 狀態機、翻譯（依等級建立翻譯器、AI 失敗退回內建）、事件綁定 | 無（最後載入） |
| `background.js` | service worker | 讀 API key（設定頁或本機 `.env`）、代為呼叫 OpenRouter | 只透過 `chrome.runtime` 訊息溝通 |
| `options.html`／`options.js` | 擴充功能選項頁 | 編輯預設等級、模型與 API key | 無 |
| `subtitles.css` | content script | 所有樣式，class 前綴 `bce-` | |

## 慣例

- content script 不能用 ES `import`。每個模組包在 IIFE 裡，把 API 掛到 `globalThis.bceXxx`；`content.js` 開頭再解構成區域變數。這些全域只存在於擴充功能的 isolated world，網頁讀不到。
- **載入順序以 `manifest.json` 的 `content_scripts[1].js` 為準**：被依賴的檔案要排在前面，`content.js` 永遠最後。新增模組時記得同步更新 manifest。
- 純函式模組（`captions.js`、`transcript.js`、`settings.js`、`ai-translator.js`）結尾有 `module.exports`，可以直接在 Node 裡 `require` 測試（`node --test tests/`）。
- 兩個 world 之間的訊息：頁面 → content 用 `source: 'bce-timedtext'`，content → 頁面用 `source: 'bce-content'`。
- content → 背景程式：`chrome.runtime.sendMessage({ type: 'bce-ai', tier, messages })`，回覆 `{ ok: true, text }` 或 `{ ok: false, error }`。設定存在 `chrome.storage.local` 的 `bceSettings`，API key 存在 `bceKeys`；**只有 `background.js` 與設定頁可讀 `bceKeys`**，`content.js` 只讀等級。
- 會依賴 `job`、`player`、`currentText` 等共用狀態的邏輯留在 `content.js`，不要拆出去。
