// AI usage per calendar month (local time), summed from the `usage` object
// OpenRouter returns with every reply (its `cost` is in credits, i.e. US
// dollars). Only the background worker writes it; the options page and the
// popup read it. Loaded via importScripts and via <script>.
(() => {
  'use strict';

  const USAGE_KEY = 'bceUsage';

  const monthOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  const emptyMonth = (month) => ({ month, cost: 0, promptTokens: 0, completionTokens: 0, requests: 0 });
  const amount = (value) => (Number.isFinite(value) && value >= 0 ? value : 0);

  function readMonth(value) {
    if (!value || typeof value !== 'object' || !/^\d{4}-\d{2}$/.test(value.month)) return undefined;
    return {
      month: value.month,
      cost: amount(value.cost),
      promptTokens: amount(value.promptTokens),
      completionTokens: amount(value.completionTokens),
      requests: amount(value.requests),
    };
  }

  // { current, previous }: this month (empty when nothing was used yet) and
  // the last month that had use, if any. A new month moves current to previous.
  function mergeUsage(stored, now = new Date()) {
    const month = monthOf(now);
    const src = stored && typeof stored === 'object' ? stored : {};
    const current = readMonth(src.current);
    const previous = readMonth(src.previous);
    if (current?.month === month) return { current, previous };
    return { current: emptyMonth(month), previous: current && current.month < month ? current : previous };
  }

  // One reply's `usage` added to the stored record; a reply without usage
  // still counts as a request.
  function addUsage(stored, usage, now = new Date()) {
    const { current, previous } = mergeUsage(stored, now);
    const next = {
      ...current,
      cost: current.cost + amount(usage?.cost),
      promptTokens: current.promptTokens + amount(usage?.prompt_tokens),
      completionTokens: current.completionTokens + amount(usage?.completion_tokens),
      requests: current.requests + 1,
    };
    return previous ? { current: next, previous } : { current: next };
  }

  // A limit of 0 means no limit.
  function overBudget(stored, limit, now = new Date()) {
    return limit > 0 && mergeUsage(stored, now).current.cost >= limit;
  }

  // Cents for larger sums; tiny ones keep enough digits to not read as zero.
  function formatCost(cost) {
    const value = amount(cost);
    return `US$${value >= 1 ? value.toFixed(2) : value >= 0.01 ? value.toFixed(3) : value.toFixed(4)}`;
  }

  function describeMonth(record) {
    if (!record) return '';
    const month = Number(record.month.slice(5));
    const tokens = (record.promptTokens + record.completionTokens).toLocaleString('en-US');
    return `${month} 月：${formatCost(record.cost)}（${record.requests} 次請求、${tokens} tokens）`;
  }

  const api = { USAGE_KEY, monthOf, mergeUsage, addUsage, overBudget, formatCost, describeMonth };
  globalThis.bceUsage = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
