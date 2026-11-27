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

for (const live of [false, true]) {
  test(`a held Korean ${live ? 'live' : 'timed'} caption receives its delayed translation as playback continues`, async () => {
    const cues = [
      { start: 0, end: 2, text: '캐릭터를 알아봐요.' },
      { start: 2, end: 4, text: '다음 캐릭터예요.' },
    ];
    const stored = { bceSourceLanguage: 'ko', bceSettings: { tier: 'ai', ai: { model: 'qwen/qwen3.7-flash' } } };
    const session = await openPlayer(undefined, live, stored, {
      ...bridgeWith(live ? undefined : { cues, language: 'ko', asr: true }),
      aiReply: (lines) => ({ t: lines.map((line) => line === cues[0].text ? '來看看角色。' : '這是下一個角色。') }),
    });
    if (live) session.say(cues[0].text);
    session.toggleCaptions();
    if (live) session.play(250);
    await flush();
    assert.equal(session.line.textContent, '基本 캐릭터를 알아봐요.');
    session.stage.dispatchEvent(new Event('pointerenter'));
    if (live) session.say(cues[1].text);
    else session.go(2);
    session.video.paused = true;
    session.play(5000);
    session.respond();
    await flush();
    assert.equal(session.original.textContent, cues[0].text);
    assert.equal(session.line.textContent, '來看看角色。');
    session.stage.dispatchEvent(new Event('pointerleave'));
    await flush();
    assert.equal(session.original.textContent, cues[1].text);
    assert.equal(session.line.textContent, '這是下一個角色。');
  });
}

test('live Korean CC can finish translating while the next sentence is still being spoken', async () => {
  const session = await openPlayer(undefined, true, { bceSourceLanguage: 'ko', ...aiTier() });
  session.say('첫 문장입니다.');
  session.toggleCaptions();
  session.play(250);
  await flush();
  assert.equal(session.line.textContent, '基本 첫 문장입니다.');
  session.say('두 번째');
  await flush();
  session.respond();
  await flush();
  assert.equal(session.original.textContent, '첫 문장입니다.');
  assert.equal(session.line.textContent, 'AI 첫 문장입니다.');
  session.say('두 번째 문장입니다.');
  await flush();
  assert.equal(session.line.textContent, 'AI 두 번째 문장입니다.');
});

for (const hover of [false, true]) {
  test(`a paused Korean caption with hover=${hover} recovers when the AI never answers`, async () => {
    const cues = [{ start: 0, end: 2, text: '첫 문장입니다.' }];
    let localReady = false;
    const session = await openPlayer(async () => localReady ? '這是第一句。' : new Promise(() => {}),
      false, aiTier(), bridgeWith({ cues, language: 'ko' }));
    session.video.paused = true;
    session.toggleCaptions();
    await flush();
    assert.equal(session.line.textContent, '翻譯中…');
    localReady = true;
    if (hover) session.stage.dispatchEvent(new Event('pointerenter'));
    session.play(60000);
    await flush();
    assert.equal(session.line.textContent, '這是第一句。');
    session.respond();
    session.play(240000);
    await flush();
    assert.equal(session.line.textContent, '這是第一句。');
    assert.match(session.status().translation, /逾時/);
  });
}

test('a paused caption explains when AI fallback needs a model download', async () => {
  const session = await openPlayer(undefined, false, aiTier(), {
    Translator: { availability: async () => 'downloadable', create: async () => ({ translate: async () => '第一句', destroy() {} }) },
  });
  session.video.paused = true;
  session.toggleCaptions();
  await flush();
  session.respond('bad-key');
  await flush();
  assert.match(session.line.textContent, /下載語言模型/);
  session.download.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(session.line.textContent, '第一句');
});

test('on AI startup a local Korean translation stays visible until a slow AI reply replaces it', async () => {
  const cues = [{ start: 0, end: 5, text: '안녕하세요.' }];
  const pairs = [];
  const session = await openPlayer(undefined, false, aiTier(), {
    ...bridgeWith({ cues, language: 'ko' }),
    Translator: {
      availability: async () => 'available',
      create: async ({ sourceLanguage, targetLanguage }) => {
        pairs.push([sourceLanguage, targetLanguage]);
        return { translate: async () => '你好。', destroy() {} };
      },
    },
    aiReply: () => ({ t: ['大家好。'] }),
  });
  session.video.paused = true;
  session.toggleCaptions();
  await flush();
  assert.equal(session.line.textContent, '你好。');
  assert.deepEqual(pairs, [['ko', 'zh-Hant']]);
  session.play(60000);
  assert.equal(session.line.textContent, '你好。');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, '大家好。');
  assert.match(session.toggle.textContent, /AI$/);
});

test('switching to Korean ignores a late Chrome preview from the previous language', async () => {
  let finishEnglish;
  const session = await openPlayer(undefined, false, aiTier(), {
    ...bridgeWith((lang) => lang === 'ko'
      ? { language: 'ko', cues: [{ start: 0, end: 5, text: '안녕하세요.' }] }
      : { language: 'en', cues: [{ start: 0, end: 5, text: 'Hello.' }] }),
    Translator: {
      create: async ({ sourceLanguage }) => sourceLanguage === 'en'
        ? new Promise((resolve) => { finishEnglish = resolve; })
        : { translate: async () => '哈囉。', destroy() {} },
    },
    aiReply: () => ({ t: ['你好。'] }),
  });
  session.toggleCaptions();
  await flush();
  session.sourceLanguage('ko');
  await flush();
  assert.equal(session.line.textContent, '哈囉。');
  let destroyed = false;
  finishEnglish({ translate: async () => '英文譯文', destroy() { destroyed = true; } });
  await flush();
  assert.equal(destroyed, true);
  assert.equal(session.line.textContent, '哈囉。');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, '你好。');
});

test('an optional Chrome model download does not hold up the AI caption', async () => {
  const session = await openPlayer(undefined, false, aiTier(), {
    Translator: { availability: async () => 'downloadable', create: async () => ({ translate: async () => '本機', destroy() {} }) },
  });
  session.toggleCaptions();
  await flush();
  assert.equal(session.download.hidden, false);
  assert.equal(session.line.textContent, '翻譯中…');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI One');
  session.download.dispatchEvent(new Event('click'));
  await flush();
  assert.equal(session.line.textContent, 'AI One');
  assert.equal(session.notice.hidden, true);
});

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

test('Korean collaboration captions distinguish transcendence goals from durations in local translation and AI preview', async () => {
  const line = '6초 아닌 분들은 6초인 분들 다 6초 12초 달릴까 말까 고민을 하시면 되겠습니다.';
  const expanded = '초월 6단계 아닌 분들은 초월 6단계인 분들 다 초월 6단계나 초월 12단계까지 올릴까 말까 고민을 하시면 되겠습니다.';
  const game = '세븐나이츠 리버스 - 콜라보';
  for (const [tier, title, text, expected] of [
    ['basic', game, line, expanded],
    ['ai', game, line, expanded],
    ['basic', game, line + ' 기절은 6초 동안 지속됩니다.', expanded + ' 기절은 6초 동안 지속됩니다.'],
    ['basic', game, '6초 뒤에 달리고 12초 동안 기다려요.', '6초 뒤에 달리고 12초 동안 기다려요.'],
    ['basic', '달리기 연습', line, line],
  ]) {
    const session = await openPlayer(undefined, false, { bceSettings: { tier } },
      bridgeWith({ language: 'ko', cues: [{ start: 0, end: 5, text }] }, { title }));
    session.toggleCaptions();
    await flush();
    assert.equal(session.line.textContent, '基本 ' + expected);
    assert.equal(session.original.textContent, text);
    if (tier === 'ai') {
      const [system, user] = session.payloads[0].messages;
      assert.match(system.content, /초월/);
      assert.deepEqual(JSON.parse(user.content).lines, [text]);
    }
  }
});

test('game terms reach the first AI batch for Re:BIRTH titles only, with personal terms first', async () => {
  const stored = { [settings.SETTINGS_KEY]: { tier: 'ai', glossary: '루디 = 我的路迪' } };
  for (const [title, language, text, expected] of [
    ['세븐나이츠 리버스 공략', 'ko', '루디와 델론즈', { 루디: '我的路迪', 델론즈: '戴倫斯' }],
    ['Seven Knights Re:BIRTH', 'th', 'ลูดี้กับคริส', { 'ลูดี้': '路迪', 'คริส': '克里斯' }],
    ['세븐나이츠 리버스', 'ko', '죽음의 일격과 침묵', { '죽음의 일격': '死亡打擊', '침묵': '沉默' }],
    ['Seven Knights Re:BIRTH', 'th', 'ดาบของนักผจญภัยเก่า', { 'ดาบของนักผจญภัยเก่า': '老舊的冒險家的劍' }],
    ['오늘의 브이로그', 'ko', '크리스와 카린', undefined],
  ]) {
    const session = await openPlayer(undefined, false, stored,
      bridgeWith({ language, cues: [{ start: 0, end: 2, text }] }, { title }));
    session.toggleCaptions();
    await flush();
    const payload = JSON.parse(session.payloads[0].messages[1].content);
    const terms = { ...payload.gameTerms, ...payload.glossary };
    assert.deepEqual(terms, expected ?? {});
    assert.equal(payload.gameTerms?.['루디'], undefined, 'a personal translation takes priority');
  }
});

test('Korean game-channel dialogue and everyday Korean receive different translation context', async () => {
  for (const [details, game] of [
    [{ channel: '세븐나이츠 리버스 공식 채널' }, true],
    [{ description: '#세븐나이츠리버스 #공략' }, true],
    [{ description: '게임: 세븐나이츠 리버스' }, true],
    [{ title: '오늘 우리 팀 에이스는?', channel: '주말 예능', description: '다른 영상: 세븐나이츠 리버스 리뷰' }, false],
  ]) {
    const text = game ? '오늘은 세븐나이츠 리버스에서 에이스를 써볼게요' : '오늘은 네가 우리 팀 에이스네!';
    const session = await openPlayer(undefined, false, aiTier(), bridgeWith({
      language: 'ko', cues: [{ start: 0, end: 2, text }],
    }, details));
    session.toggleCaptions();
    await flush();
    const [system, user] = session.payloads[0].messages;
    assert.match(system.content, /반문|反問/);
    assert.equal(system.content.includes('《七騎士 Re:BIRTH》'), game);
    assert.deepEqual(JSON.parse(user.content).gameTerms, game
      ? { '세븐나이츠 리버스': '七騎士 Re:BIRTH', '에이스': '艾斯' } : undefined);
  }
});

test('a manual game glossary applies to the current video and clears on navigation', async () => {
  const session = await openPlayer(undefined, false, aiTier(), bridgeWith({
    language: 'ko', cues: [{ start: 0, end: 2, text: '죽음의 일격' }],
  }));
  session.toggleCaptions();
  await flush();
  const glossary = () => JSON.parse(session.payloads.at(-1).messages[1].content).gameTerms;
  assert.equal(glossary(), undefined);
  session.toggle.dispatchEvent(new Event('click'));
  session.menuItem('game-glossary').dispatchEvent(new Event('click'));
  await flush();
  assert.deepEqual(glossary(), { '죽음의 일격': '死亡打擊' });
  session.respond();
  await flush();
  assert.ok(session.line.textContent.includes('죽음의 일격'));
  const previousBatches = session.payloads.length;
  session.navigate('another-video');
  await flush();
  assert.ok(session.payloads.length > previousBatches, 'the next video translates the repeated line again');
  assert.equal(glossary(), undefined);
});

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

test('live Thai captions keep phrase spaces as the line grows', async () => {
  const session = await openPlayer(undefined, true);
  session.say('สวัสดีครับ');
  session.toggleCaptions();
  await flush();
  session.say('สวัสดีครับ วันนี้เป็นอย่างไร?');
  await flush();
  session.play(500);
  await flush();
  assert.equal(session.status().language, 'th');
  assert.equal(session.original.textContent, 'สวัสดีครับ วันนี้เป็นอย่างไร?');
  assert.equal(session.line.textContent, '基本 สวัสดีครับ วันนี้เป็นอย่างไร?');
});

for (const preference of ['auto', 'en']) {
  test(`an English source ignores a Japanese transcript and live CC (${preference})`, async () => {
    const text = 'こんにちは、皆さん。';
    const session = await openPlayer(undefined, true, { bceSourceLanguage: preference }, {
      ...bridgeWith(undefined, { language: 'en' }),
      bceTranscript: {
        readTranscript: (_video, traits) => {
          traits(text);
          return [{ text, start: 0, end: 2 }];
        },
        openTranscript: () => false,
      },
    });
    session.say(text);
    session.toggleCaptions();
    await flush();
    session.play(500);
    assert.equal(session.status().language, 'en');
    assert.equal(session.original.textContent, '');
    session.say('Welcome back.');
    await flush();
    assert.equal(session.original.textContent, 'Welcome back.');
  });
}

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
