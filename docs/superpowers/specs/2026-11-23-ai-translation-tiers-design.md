# AI 翻譯等級設計

日期：2026-11-23
規模：小型變更（簡短設計）

## 目的

現在只有 Chrome 內建翻譯（`Translator` API），品質大約是一般機器翻譯。使用者希望需要更專業的翻譯時能改用 AI：平常用免費的，想要好一點就用免費 AI，要更專業再用 OpenRouter（使用者已有付費額度）或 Gemini 付費。

## 目標

- 三個翻譯等級，可在設定頁選預設、在播放器上隨時切換：

  | 等級 | 引擎 | 費用 |
  |---|---|---|
  | 基本 | Chrome 內建 `Translator` | 免費、本機、不用 key |
  | AI 免費 | Gemini 免費層（Flash 系列）或 OpenRouter `:free` 模型 | 免費，有次數／速率限制 |
  | AI 進階 | OpenRouter 付費模型（Claude、GPT 等）或 Gemini 付費 | 使用者自己的額度 |

- AI 失敗（額度用完、網路、格式錯誤）時自動改用 Chrome 內建翻譯，字幕不中斷，並提示「AI 暫時無法使用，已改用內建翻譯」。
- 有時間碼的影片用整批翻譯（約 40 句一批，附前文），速度快、術語一致。

## 非目標

- DeepL、Azure、Google Cloud Translation 等傳統翻譯 API。
- 各家原生 API 接口（Anthropic、Gemini 原生格式）。
- 上架用的多語系、隱私政策頁、帳號系統。

## 反目標

- AI 慢或出錯時字幕卡住、整個停掉。
- API key 出現在網頁 world 或程式碼裡。

## 做法（已選 B）

- **A. 只接 OpenRouter**：最簡單，但 Gemini 免費額度只能經由 OpenRouter 的 `:free` 模型，受其每日上限。
- **B. 一個 OpenAI 相容引擎 + OpenRouter／Gemini 預設（採用）**：OpenRouter 與 Gemini 都提供 OpenAI 格式 `chat/completions`，一套程式兩者都能用，日後可接 Groq、Ollama 等。
- **C. 每家寫原生接口**：程式量約三倍，個人使用效益低。

選 B 的原因：程式量與 A 相近，卻能同時用到 OpenRouter 額度與 Gemini 免費額度。

## 已決定的設計

- **設定頁**（`options.html`／`options.js`）：OpenRouter key、Gemini key、每個 AI 等級的服務與模型名稱（可編輯）、預設等級。存在 `chrome.storage.local`。
- **播放器切換**：原本右鍵 EN／中開啟的「字幕設定」面板加上等級切換，存回 `chrome.storage`。
- **`background.js`**（service worker）：唯一發出 API 請求的地方，因為 content script 的 fetch 受 youtube.com 的 CORS 限制。key 只在 background 讀取。
- **`ai-translator.js`**（content script 模組，`globalThis.bceAiTranslator`）：提供與 Chrome `Translator` 相同的 `translate(text, { signal })`、`destroy()` 介面，內部負責分批、提示詞、解析回傳；`content.js` 的 `translateCaption` 不需大改。
- **快取**：換等級時清空 `content.js` 的翻譯快取，不會拿到別的引擎的結果。（規劃時改的：比「等級＋原文」當 key 少改六個呼叫點，效果相同。）
- **manifest**：加 `storage` 權限、`host_permissions`（`https://openrouter.ai/*`、`https://generativelanguage.googleapis.com/*`）、`background`、`options_page`；`ai-translator.js` 排在 `content.js` 前面。

## 交給實作者決定

- 預設模型名稱（實作時查目前可用的 Flash 系列與 OpenRouter `:free` 模型）。
- 提示詞內容與批次回傳格式（建議 JSON 陣列，以編號對應原句）。
- 批次大小與前文長度的實際數值。
- 設定頁的版面細節（使用者介面文字一律繁體中文）。
