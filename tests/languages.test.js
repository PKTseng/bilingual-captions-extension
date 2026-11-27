const test = require('node:test');
const assert = require('node:assert/strict');
const lang = require('../languages.js');
const captions = require('../captions.js');
const transcript = require('../transcript.js');

test('language codes are reduced to the supported base language', () => {
  assert.equal(lang.normalizeLanguage('en-US'), 'en');
  assert.equal(lang.normalizeLanguage('ja'), 'ja');
  assert.equal(lang.normalizeLanguage('ko_KR'), 'ko');
  assert.equal(lang.normalizeLanguage('th-TH'), 'th');
  assert.equal(lang.normalizeLanguage('zh-Hant'), undefined);
  assert.equal(lang.normalizeLanguage(undefined), undefined);
  assert.equal(lang.traitsOf('fr').code, 'en');
});

test('an unknown preference falls back to auto', () => {
  assert.equal(lang.mergeSourceLanguage('ja'), 'ja');
  assert.equal(lang.mergeSourceLanguage('fr'), 'auto');
  assert.equal(lang.mergeSourceLanguage(undefined), 'auto');
});

test('caption text is recognised by its script', () => {
  assert.equal(lang.detectLanguage('Welcome back to the channel.'), 'en');
  assert.equal(lang.detectLanguage('今日はいい天気ですね'), 'ja');
  assert.equal(lang.detectLanguage('[音楽] さあ、始めましょう'), 'ja');
  assert.equal(lang.detectLanguage('안녕하세요 여러분'), 'ko');
  assert.equal(lang.detectLanguage('วันนี้เราจะพูดถึง YouTube'), 'th');
  // A few Japanese words in an English line do not make it Japanese.
  assert.equal(lang.detectLanguage('We ate sushi at a place called すし with friends today'), 'en');
});

test('the menu shows the language auto has found', () => {
  assert.equal(lang.describePreference('auto'), '自動');
  assert.equal(lang.describePreference('auto', 'ja'), '自動 · 日文');
  assert.equal(lang.describePreference('ko', 'ja'), '韓文');
  assert.equal(lang.describePreference('auto', 'th'), '自動 · 泰文');
  assert.equal(lang.mergeSourceLanguage('th'), 'th');
});

const ja = lang.traitsOf('ja');

test('Thai captions retain phrase spaces and join adjacent timed fragments', () => {
  const segs = ['สวัสดี', 'ครับ', ' ', 'วันนี้ อากาศดี'].map((utf8, i) => ({ utf8, tOffsetMs: i * 120 }));
  const [cue] = captions.fromJson3([{ tStartMs: 0, dDurationMs: 1600, segs }], { asr: true, traits: lang.traitsOf('th') });
  assert.equal(cue.text, 'สวัสดีครับ วันนี้ อากาศดี');
  assert.deepEqual(cue.marks.map(({ index }) => cue.text.slice(index).split(' ')[0]), ['สวัสดีครับ', 'ครับ', 'วันนี้', 'อากาศดี']);
});

test('Japanese json3 lines split at 。 inside a line and join without spaces', () => {
  const events = [
    { tStartMs: 0, dDurationMs: 3000, segs: [{ utf8: '今日は晴れです。明日は' }] },
    { tStartMs: 3000, dDurationMs: 2000, segs: [{ utf8: '雨です。' }] },
  ];
  const cues = captions.fromJson3(events, { traits: ja });
  assert.deepEqual(cues.map((cue) => cue.text), ['今日は晴れです。', '明日は雨です。']);
  assert.ok(cues[1].start > 1 && cues[1].start < 3, 'the second sentence starts inside the first line');
});

test('human-made Japanese lines without 。 each stay a sentence', () => {
  const events = [
    { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'こんにちは' }] },
    { tStartMs: 1500, dDurationMs: 2000, segs: [{ utf8: '今日は iPhone 15 の話です' }] },
  ];
  assert.deepEqual(captions.fromJson3(events, { traits: ja }).map((cue) => cue.text),
    ['こんにちは', '今日はiPhone 15の話です']);
});

test('auto-generated Japanese splits at pauses without inserting spaces', () => {
  const words = ['今日', 'は', 'いい', '天気', 'です', 'ね'].map((utf8, i) => ({ utf8, tOffsetMs: i * 250 }))
    .concat(['さて', '始め', 'ましょう'].map((utf8, i) => ({ utf8, tOffsetMs: 3200 + i * 300 })));
  const cues = captions.fromJson3([{ tStartMs: 0, dDurationMs: 5000, segs: words }], { asr: true, traits: ja });
  assert.deepEqual(cues.map((cue) => cue.text), ['今日はいい天気ですね', 'さて始めましょう']);
});

test('English splitting is unchanged by the language traits', () => {
  const events = [{ tStartMs: 0, dDurationMs: 4000, segs: [{ utf8: 'Hello there. i am here' }] }];
  assert.deepEqual(captions.fromJson3(events).map((cue) => cue.text), ['Hello there.', 'i am here']);
  assert.deepEqual(captions.fromJson3(events, { traits: lang.traitsOf('en') }).map((cue) => cue.text),
    ['Hello there.', 'i am here']);
});

test('Japanese subtitle files join lines without spaces when they use 。', () => {
  const cues = transcript.sentenceCues([
    { start: 0, end: 2, text: '今日は晴れ' },
    { start: 2, end: 4, text: 'です。明日は雨です。' },
  ], ja);
  assert.deepEqual(cues.map((cue) => cue.text), ['今日は晴れです。', '明日は雨です。']);
});

test('subtitle lines with almost no sentence marks are kept line by line', () => {
  const lines = ['こんにちは', '今日はいい天気', 'さあ始めよう'].map((text, i) => ({ start: i * 2, end: i * 2 + 2.5, text }));
  const cues = transcript.sentenceCues(lines, ja);
  assert.deepEqual(cues.map((cue) => cue.text), ['こんにちは', '今日はいい天気', 'さあ始めよう']);
  // Overlapping lines end where the next begins.
  assert.equal(cues[0].end, 2);
});

test('English subtitle lines are still merged into sentences', () => {
  const cues = transcript.sentenceCues([
    { start: 0, end: 2, text: 'This is one' },
    { start: 2, end: 4, text: 'sentence. And another.' },
  ]);
  assert.deepEqual(cues.map((cue) => cue.text), ['This is one sentence.', 'And another.']);
});
