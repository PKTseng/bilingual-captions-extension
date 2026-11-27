const test = require('node:test');
const assert = require('node:assert/strict');
const settings = require('../settings.js');
const store = require('../translation-store.js');
const { flush, deferred, openPlayer } = require('./player-harness.js');

async function playerSession(translate, live = false, stored = {}) {
  const session = await openPlayer(translate, live, stored);
  session.toggleCaptions();
  await flush();
  if (live) {
    session.say('One.');
    await flush();
  }
  assert.equal(session.line.textContent, live ? '基本 One.' : '基本 One');
  session.select('ai');
  await flush();
  return session;
}

test('only a manual toggle changes the saved preference across navigation and fresh sessions', async () => {
  const stored = {};
  const first = await openPlayer(undefined, false, stored);
  assert.equal(first.playingCaptions(), false);
  first.menuSwitch();
  assert.equal(first.playingCaptions(), true);
  first.navigate('silent');
  assert.equal(first.playingCaptions(), false);
  first.navigate('next');
  assert.equal(first.playingCaptions(), true);
  const reopened = await openPlayer(undefined, false, stored);
  assert.equal(reopened.playingCaptions(), true);
  reopened.navigate('silent');
  reopened.toggleCaptions();
  reopened.navigate('next');
  assert.equal(reopened.playingCaptions(), false);
  assert.equal((await openPlayer(undefined, false, stored)).playingCaptions(), false);
});

test('other tabs follow both changes to the caption switch', async () => {
  const session = await openPlayer();
  session.readyState(0);
  session.enabledFromOtherTab(true);
  assert.equal(session.playingCaptions(), false);
  session.readyState(4);
  assert.equal(session.playingCaptions(), true);
  session.enabledFromOtherTab(false);
  assert.equal(session.playingCaptions(), false);
  session.navigate('next');
  assert.equal(session.playingCaptions(), false);
});

for (const state of ['downloadable', 'downloading', 'available']) {
  test('automatic basic translation handles a model that is ' + state, async () => {
    const activation = { isActive: false };
    let creates = 0;
    const Translator = {
      availability: async () => state,
      create: async () => {
        creates++;
        if (state !== 'available' && !activation.isActive) throw new Error('User activation required');
        return { translate: async (s) => '本機 ' + s, destroy() {} };
      },
    };
    const session = await openPlayer(undefined, false, { bceCaptionsEnabled: true },
      { Translator, navigator: { userActivation: activation } });
    if (state !== 'available') {
      assert.equal(creates, 0);
      assert.equal(session.playingCaptions(), true);
      assert.equal(session.notice.hidden, false);
      assert.equal(session.download.hidden, false);
      activation.isActive = true;
      session.download.dispatchEvent(new Event('click'));
      activation.isActive = false;
      await flush();
    }
    assert.equal(creates, 1);
    assert.equal(session.line.textContent, '本機 One');
  });
}

test('switching from AI to basic offers the model download and turning off cancels it', async () => {
  let creates = 0;
  const Translator = { availability: async () => 'downloadable', create() { creates++; } };
  const session = await openPlayer(undefined, false, { bceCaptionsEnabled: true, bceSettings: { tier: 'ai' } }, { Translator });
  session.select('basic');
  await flush();
  assert.equal(creates, 0);
  assert.equal(session.download.hidden, false);
  session.toggleCaptions();
  assert.equal(session.download.hidden, true);
  session.download.dispatchEvent(new Event('click'));
  assert.equal(creates, 0);
});

test('a late availability check cannot show the download prompt in original-only mode', async () => {
  const check = deferred();
  const session = await openPlayer(undefined, false, { bceCaptionsEnabled: true },
    { Translator: { availability: () => check.promise } });
  session.display('original');
  check.resolve('downloadable');
  await flush();
  assert.equal(session.download.hidden, true);
  assert.equal(session.playingCaptions(), true);
});

test('manually enabling basic translation can use the current gesture immediately', async () => {
  const activation = { isActive: false };
  let usedGesture = false;
  const session = await openPlayer(undefined, false, {}, {
    navigator: { userActivation: activation },
    Translator: {
      availability: async () => 'downloadable',
      create: async () => {
        usedGesture = activation.isActive;
        return { translate: async (s) => '本機 ' + s, destroy() {} };
      },
    },
  });
  activation.isActive = true;
  session.menuSwitch();
  activation.isActive = false;
  await flush();
  assert.equal(usedGesture, true);
  assert.equal(session.download.hidden, true);
  assert.equal(session.line.textContent, '本機 One');
});

test('a prefetched Chrome caption stays readable until the matching AI caption arrives', async () => {
  const session = await playerSession();
  session.go(2);
  assert.equal(session.line.textContent, '基本 Two');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Two');
});

test('Chrome supplies an uncached visible line during an AI delay', async () => {
  const session = await playerSession();
  session.go(180);
  await flush();
  assert.equal(session.line.textContent, '基本 Three');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
});

test('a late Chrome result cannot overwrite AI', async () => {
  const chromeReply = deferred();
  const session = await playerSession(async (text) => text === 'Three' ? chromeReply.promise : '基本 ' + text);
  session.go(180);
  session.respond();
  await flush();
  chromeReply.resolve('基本 Three');
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
});

test('live captions use the local translation while waiting for AI', async () => {
  const session = await playerSession(undefined, true);
  session.say('Two.');
  await flush();
  assert.equal(session.line.textContent, '基本 Two.');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Two.');
});

test('switching back to Chrome ignores a pending AI response', async () => {
  const session = await playerSession();
  session.go(2);
  session.select('basic');
  session.respond();
  await flush();
  assert.equal(session.line.textContent, '基本 Two');
});

test('the player button pulses until an AI translation reaches the screen', async () => {
  const session = await playerSession();
  const { toggle } = session;
  assert.match(toggle.textContent, /AI…/);
  assert.ok(session.indicator.classList.contains('bce-waiting'));
  session.go(100); // No visible cue, even after AI finishes prefetching.
  session.respond();
  await flush();
  assert.match(toggle.textContent, /AI…/);
  assert.equal(session.toast.textContent, '');
  session.go(180);
  assert.match(toggle.textContent, /AI$/);
  assert.equal(session.toast.textContent, '已切換為 AI 翻譯');
  assert.equal(session.toast.classList.contains('bce-visible'), true);
  assert.equal(session.indicator.classList.contains('bce-waiting'), false);
  assert.equal(session.line.textContent, 'AI Three');
  session.select('basic');
  await flush();
  assert.match(toggle.textContent, /Chrome$/);
  assert.equal(session.toast.classList.contains('bce-visible'), false);
});

test('identical Chrome and AI wording still completes the switch', async () => {
  const session = await playerSession(async (text) => text === 'Two' ? 'AI Two' : '基本 ' + text);
  session.go(2);
  assert.match(session.toggle.textContent, /AI…/);
  assert.equal(session.toast.textContent, '');
  session.respond();
  await flush();
  assert.match(session.toggle.textContent, /AI$/);
  assert.equal(session.toast.textContent, '已切換為 AI 翻譯');
  session.toast.classList.remove('bce-visible'); // After the notification has faded.
  session.go(180);
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
  assert.equal(session.toast.classList.contains('bce-visible'), false);
});

test('fallback, original-only mode and stopping clear the AI indicator', async () => {
  const session = await playerSession();
  session.respond('no-key');
  await flush();
  assert.match(session.toggle.textContent, /Chrome$/);
  session.display('original');
  assert.match(session.toggle.textContent, /原文$/);
  session.toggleCaptions();
  assert.equal(session.toggle.textContent, 'Dual');
});

test('AI translations saved on an earlier visit show at once and are not sent again', async () => {
  const model = settings.DEFAULT_SETTINGS.ai;
  const key = store.recordKey('test', `${model.provider}/${model.model}`);
  const session = await playerSession(undefined, false, { [key]: { lines: [['One', '存 One'], ['Two', '存 Two']] } });
  await flush();
  assert.equal(session.line.textContent, '存 One');
  session.go(2);
  await flush();
  assert.equal(session.line.textContent, '存 Two');
  assert.match(session.toggle.textContent, /AI$/);
  assert.deepEqual(session.sent, []);
  // Only the line that was never translated goes to the AI service.
  session.go(180);
  await flush();
  assert.deepEqual(session.sent, ['Three']);
  session.respond();
  await flush();
  assert.equal(session.line.textContent, 'AI Three');
});

test('replay starts the held sentence over just before its first word and resumes playback', async () => {
  const session = await openPlayer();
  session.toggleCaptions();
  await flush();
  session.go(3);
  assert.equal(session.replay.hidden, false);
  session.video.paused = true;
  session.replay.dispatchEvent(new Event('click'));
  assert.ok(Math.abs(session.video.currentTime - 1.8) < 1e-9);
  assert.equal(session.video.paused, false);
});

test('replay undoes the caption timing shift so the sentence still starts on its first word', async () => {
  const session = await openPlayer();
  session.toggleCaptions();
  await flush();
  // Captions 0.5 s earlier: the cue starting at 2 s shows from 1.5 s of video.
  session.toggle.dispatchEvent(new Event('click'));
  session.menuItem('timing').dispatchEvent(new Event('click'));
  session.menuItem('earlier').dispatchEvent(new Event('click'));
  session.go(2.5);
  session.replay.dispatchEvent(new Event('click'));
  assert.ok(Math.abs(session.video.currentTime - 1.3) < 1e-9);
});

test('live captions have no start time, so replay stays hidden', async () => {
  const session = await playerSession(undefined, true);
  assert.equal(session.replay.hidden, true);
  const before = session.video.currentTime;
  session.replay.dispatchEvent(new Event('click'));
  assert.equal(session.video.currentTime, before);
});

test('the toolbar popup hears what the tab is showing', async () => {
  const session = await openPlayer();
  assert.deepEqual(
    { ...session.status(), translation: undefined },
    { videoId: 'test', enabled: false, running: false, source: '', language: undefined, translation: undefined, notice: '' },
  );
  session.toggleCaptions();
  await flush();
  const status = session.status();
  assert.equal(status.enabled, true);
  assert.equal(status.running, true);
  assert.match(status.translation, /基本/);
});
