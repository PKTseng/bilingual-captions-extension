// content.js with captions in other languages, corrected auto captions, and
// whole-video prefetch. Uses the same simulated player as model-switch.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../settings.js');

const { openPlayer } = require('./player-harness.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function bridgeWith(timed, details = {}) {
  return {
    bcePageBridge: {
      cachedTimedText: (_id, preference) => (typeof timed === 'function' ? timed(preference) : timed),
      requestTimedText: () => new Promise(() => {}),
      requestVideoDetails: async () => ({ title: 'Video title', channel: 'Channel', description: '', ...details }),
      cachedVideoDetails: () => undefined,
    },
  };
}

const aiTier = () => ({ [settings.SETTINGS_KEY]: { tier: 'ai' } });

test('AI corrects auto-generated captions and the card shows the fixed line', async () => {
  const cues = [{ text: 'so today we test', start: 0, end: 2 }, { text: 'and then', start: 2, end: 4 }];
  const session = await openPlayer(undefined, false, aiTier(), {
    ...bridgeWith({ cues, language: 'en', asr: true, source: 'YouTube 英文自動字幕' }),
    aiReply: (lines) => ({
      t: lines.map((line) => `中 ${line}`),
      s: lines.map((line) => (line === 'so today we test' ? 'So today, we test.' : line)),
    }),
  });
  session.toggleCaptions();
  await flush();
  assert.equal(session.original.textContent, 'so today we test');
  session.respond();
  await flush();
  assert.equal(session.original.textContent, 'So today, we test.');
  assert.equal(session.line.textContent, '中 so today we test');
  const [system, user] = session.payloads[0].messages;
  assert.match(system.content, /自動語音辨識/);
  assert.equal(JSON.parse(user.content).video.title, 'Video title');
});

test('human-made captions are not sent for correction', async () => {
  const cues = [{ text: 'So today, we test.', start: 0, end: 2 }];
  const session = await openPlayer(undefined, false, aiTier(), bridgeWith({ cues, language: 'en', asr: false }));
  session.toggleCaptions();
  await flush();
  assert.doesNotMatch(session.payloads[0].messages[0].content, /自動語音辨識/);
});

test('turning the caption fix off leaves auto captions as they are', async () => {
  const cues = [{ text: 'so today we test', start: 0, end: 2 }];
  const stored = { [settings.SETTINGS_KEY]: { tier: 'ai', fixAsr: false } };
  const session = await openPlayer(undefined, false, stored, bridgeWith({ cues, language: 'en', asr: true }));
  session.toggleCaptions();
  await flush();
  assert.doesNotMatch(session.payloads[0].messages[0].content, /自動語音辨識/);
});

test('the glossary terms in a batch go to the AI', async () => {
  const cues = [{ text: 'We use an LLM here', start: 0, end: 2 }];
  const stored = { [settings.SETTINGS_KEY]: { tier: 'ai', glossary: 'LLM = 大型語言模型\nGPU = 顯示卡' } };
  const session = await openPlayer(undefined, false, stored, bridgeWith({ cues, language: 'en' }));
  session.toggleCaptions();
  await flush();
  assert.deepEqual(JSON.parse(session.payloads[0].messages[1].content).glossary, { LLM: '大型語言模型' });
});

const longVideo = () => Array.from({ length: 120 }, (_, i) => ({ text: `Line ${i}`, start: i * 10, end: i * 10 + 5 }));

test('after a minute of playback the AI translates the rest of the video ahead', async () => {
  const session = await openPlayer(undefined, false, aiTier(), bridgeWith({ cues: longVideo(), language: 'en' }));
  session.toggleCaptions();
  session.respond();
  await flush();
  session.play(30000);
  await flush();
  assert.ok(!session.sent.includes('Line 60'), 'only the lookahead is translated at first');
  session.play(31000);
  await flush();
  assert.ok(session.sent.includes('Line 40'), 'the background pass has started past the lookahead');
  // Turning captions off ends the background pass with the translator.
  session.toggleCaptions();
});

test('with prefetch turned off only the lookahead is translated', async () => {
  const stored = { [settings.SETTINGS_KEY]: { tier: 'ai', prefetchWhole: false } };
  const session = await openPlayer(undefined, false, stored, bridgeWith({ cues: longVideo(), language: 'en' }));
  session.toggleCaptions();
  session.respond();
  await flush();
  session.play(61000);
  await flush();
  assert.ok(!session.sent.includes('Line 40'));
});

test('Chrome translates from the language of the caption track', async () => {
  const pairs = [];
  const session = await openPlayer(undefined, false, {}, {
    ...bridgeWith({ cues: [{ text: '今日は', start: 0, end: 2 }], language: 'ja' }),
    Translator: {
      create: async ({ sourceLanguage, targetLanguage }) => {
        pairs.push([sourceLanguage, targetLanguage]);
        return { translate: async (text) => `本機 ${text}`, destroy() {} };
      },
    },
  });
  session.toggleCaptions();
  await flush();
  assert.deepEqual(pairs, [['ja', 'zh-Hant']]);
  assert.equal(session.status().language, 'ja');
  assert.equal(session.line.textContent, '本機 今日は');
});

test('a language Chrome cannot translate keeps the original captions and says why', async () => {
  const session = await openPlayer(undefined, false, {}, {
    ...bridgeWith({ cues: [{ text: '안녕하세요', start: 0, end: 2 }], language: 'ko' }),
    Translator: {
      availability: async ({ sourceLanguage }) => (sourceLanguage === 'ko' ? 'unavailable' : 'available'),
      create: async () => { throw new Error('NotSupportedError'); },
    },
  });
  session.toggleCaptions();
  await flush();
  assert.equal(session.playingCaptions(), true);
  assert.equal(session.original.textContent, '안녕하세요');
  assert.equal(session.line.textContent, '');
  assert.match(session.notice.textContent, /不支援韓文翻繁中/);
  assert.match(session.status().translation, /不支援韓文，僅顯示原文/);
});

test('live Japanese captions are recognised and joined without spaces', async () => {
  const session = await openPlayer(undefined, true);
  // The player already shows the start of the line when captions turn on.
  session.say('今日はいい天気');
  session.toggleCaptions();
  await flush();
  session.say('今日はいい天気ですね。');
  await flush();
  session.play(500);
  await flush();
  assert.equal(session.status().language, 'ja');
  assert.equal(session.original.textContent, '今日はいい天気ですね。');
  assert.equal(session.line.textContent, '基本 今日はいい天気ですね。');
});

test('choosing another source language starts the captions over with that track', async () => {
  const asked = [];
  const session = await openPlayer(undefined, false, {}, bridgeWith((preference) => {
    asked.push(preference);
    return preference === 'ja'
      ? { cues: [{ text: 'こんにちは', start: 0, end: 2 }], language: 'ja' }
      : { cues: [{ text: 'Hello', start: 0, end: 2 }], language: 'en' };
  }));
  session.toggleCaptions();
  await flush();
  assert.equal(session.original.textContent, 'Hello');
  session.toggle.dispatchEvent(new Event('click'));
  assert.match(session.menuItem('source-language').textContent, /原文語言自動 · 英文/);
  session.sourceLanguage('ja');
  await flush();
  assert.equal(session.playingCaptions(), true);
  assert.equal(session.original.textContent, 'こんにちは');
  assert.equal(session.status().language, 'ja');
  assert.deepEqual(asked, ['auto', 'ja']);
});
