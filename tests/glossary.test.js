const test = require('node:test');
const assert = require('node:assert/strict');
const s = require('../settings.js');

test('new settings default to an empty glossary with caption fixing and prefetch on', () => {
  const m = s.mergeSettings({ glossary: 42, fixAsr: 'yes', prefetchWhole: null });
  assert.equal(m.glossary, '');
  assert.equal(m.fixAsr, true);
  assert.equal(m.prefetchWhole, true);
  const off = s.mergeSettings({ glossary: 'LLM = 大型語言模型', fixAsr: false, prefetchWhole: false });
  assert.deepEqual([off.glossary, off.fixAsr, off.prefetchWhole], ['LLM = 大型語言模型', false, false]);
  assert.equal(s.mergeSettings({ glossary: 'x'.repeat(5000) }).glossary.length, s.GLOSSARY_MAX_LENGTH);
});

test('parseGlossary reads term = translation lines, lone terms and notes', () => {
  const text = 'LLM = 大型語言模型\n\n# a note\nKubernetes\nAPI→應用程式介面\nGPU -> 顯示卡\nllm = 重複\nTip =  ';
  assert.deepEqual(s.parseGlossary(text), [
    { source: 'LLM', target: '大型語言模型' },
    { source: 'Kubernetes', target: 'Kubernetes' },
    { source: 'API', target: '應用程式介面' },
    { source: 'GPU', target: '顯示卡' },
    { source: 'Tip', target: 'Tip' },
  ]);
  assert.deepEqual(s.parseGlossary(undefined), []);
});

test('the translation profile changes with the glossary and the caption fix only', () => {
  assert.equal(s.translationProfile(s.mergeSettings()), '');
  const withGlossary = s.translationProfile(s.mergeSettings({ glossary: 'LLM = 大型語言模型' }));
  assert.match(withGlossary, /^[0-9a-z]+$/);
  assert.equal(s.translationProfile(s.mergeSettings({ glossary: '  LLM=大型語言模型 \n# note' })), withGlossary);
  assert.notEqual(s.translationProfile(s.mergeSettings({ fixAsr: false })), '');
  assert.equal(s.translationProfile(s.mergeSettings({ prefetchWhole: false })), '');
});
