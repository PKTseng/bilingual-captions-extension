const test = require('node:test');
const assert = require('node:assert/strict');
const u = require('../usage.js');
const settings = require('../settings.js');
const { flush, openPlayer } = require('./player-harness.js');

const nov = new Date(2026, 10, 25);
const dec = new Date(2026, 11, 1);

test('months are named in local time', () => {
  assert.equal(u.monthOf(nov), '2026-11');
  assert.equal(u.monthOf(new Date(2026, 0, 31, 23, 59)), '2026-01');
});

test('usage adds up within a month and starts over in the next', () => {
  let record;
  record = u.addUsage(record, { cost: 0.002, prompt_tokens: 100, completion_tokens: 30 }, nov);
  record = u.addUsage(record, { cost: 0.001, prompt_tokens: 50, completion_tokens: 20 }, nov);
  // A reply without usage still counts as a request.
  record = u.addUsage(record, undefined, nov);
  assert.deepEqual(u.mergeUsage(record, nov).current,
    { month: '2026-11', cost: 0.003, promptTokens: 150, completionTokens: 50, requests: 3 });
  const next = u.mergeUsage(record, dec);
  assert.deepEqual(next.current, { month: '2026-12', cost: 0, promptTokens: 0, completionTokens: 0, requests: 0 });
  assert.equal(next.previous.month, '2026-11');
  const written = u.addUsage(record, { cost: 0.01 }, dec);
  assert.equal(written.previous.cost, 0.003);
  assert.equal(written.current.cost, 0.01);
});

test('bad stored values and bad usage numbers are ignored', () => {
  assert.deepEqual(u.mergeUsage('junk', nov).current.cost, 0);
  const record = u.addUsage({ current: { month: '2026-11', cost: -5, requests: 'x' } }, { cost: Number.NaN, prompt_tokens: -1 }, nov);
  assert.deepEqual(record.current, { month: '2026-11', cost: 0, promptTokens: 0, completionTokens: 0, requests: 1 });
});

test('the limit counts only this month, and 0 means no limit', () => {
  const record = { current: { month: '2026-11', cost: 1.5, promptTokens: 0, completionTokens: 0, requests: 1 } };
  assert.equal(u.overBudget(record, 1, nov), true);
  assert.equal(u.overBudget(record, 2, nov), false);
  assert.equal(u.overBudget(record, 0, nov), false);
  assert.equal(u.overBudget(record, 1, dec), false);
});

test('costs keep enough digits to be read', () => {
  assert.equal(u.formatCost(0.00042), 'US$0.0004');
  assert.equal(u.formatCost(0.0123), 'US$0.012');
  assert.equal(u.formatCost(3.456), 'US$3.46');
  assert.equal(u.describeMonth({ month: '2026-11', cost: 0.0123, promptTokens: 12000, completionTokens: 345, requests: 45 }),
    '11 月：US$0.012（45 次請求、12,345 tokens）');
});

test('the monthly limit is a positive amount in cents, or 0', () => {
  assert.equal(settings.mergeSettings().monthlyLimit, 0);
  assert.equal(settings.mergeSettings({ monthlyLimit: 2.499 }).monthlyLimit, 2.5);
  assert.equal(settings.mergeSettings({ monthlyLimit: -3 }).monthlyLimit, 0);
  assert.equal(settings.mergeSettings({ monthlyLimit: '5' }).monthlyLimit, 0);
  assert.equal(settings.describeAiError('budget'), '已達本月 AI 費用上限');
});

test('a reached limit falls back to Chrome and disables the AI models in the menu', async () => {
  const session = await openPlayer(undefined, false, { [settings.SETTINGS_KEY]: { tier: 'ai' } });
  session.toggleCaptions();
  await flush();
  session.respond('budget');
  await flush();
  assert.match(session.notice.textContent, /本月 AI 費用已達設定的上限/);
  assert.equal(session.line.textContent, '基本 One');
  assert.match(session.status().translation, /已達本月 AI 費用上限，改用 Chrome 內建/);
  session.toggle.dispatchEvent(new Event('click'));
  session.menuItem('tier').dispatchEvent(new Event('click'));
  const model = session.menuItem(`ai/${settings.DEFAULT_SETTINGS.ai.provider}/${settings.DEFAULT_SETTINGS.ai.model}`);
  assert.match(model.textContent, /已達本月上限/);
});
