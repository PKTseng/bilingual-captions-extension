(() => {
  'use strict';

  const gameTitle = /(?:seven\s*knights|7\s*knights|七騎士|เซเว่นไนท์)\s*(?:re\s*:?\s*birth|รีเบิร์ธ)|(?:세븐\s*나이츠|세나)\s*리버스|\b7k(?:r|rebirth)\b/i;
  function isGame(video) {
    if (typeof video === 'string') return gameTitle.test(video);
    if (gameTitle.test(video?.title) || gameTitle.test(video?.channel)) return true;
    // A game label or a hashtag is stronger evidence than a link to another video.
    const description = String(video?.description ?? '').replace(/https?:\/\/\S+/g, '');
    return description.split(/\r?\n/).some((line) =>
      /^(?:게임|game|遊戲|เกม)\s*[:：]/i.test(line.trim()) && gameTitle.test(line))
      || (description.match(/#[^\s#]+/gu) ?? []).some((tag) => gameTitle.test(tag));
  }
  const letter = /[\p{L}\p{M}\p{N}]/u;

  // Local translation has no prompt. Expand the spoken shorthand only when
  // the speaker compares players' current ranks and discusses pursuing a rank.
  function expandKoreanRankGoal(text) {
    const playerRank = /(?<![\p{L}\d.])(12|6|2)\s*초(?=\s*(?:아닌|인)\s*분)/gu;
    const goal = /(?<![\p{L}\d.])(?:(12|6|2)\s*초[ ,]+)?(12|6|2)\s*초\s*달릴까/gu;
    if (!text.match(playerRank) || !text.match(goal)) return text;
    return text.replace(playerRank, '초월 $1단계').replace(goal, (_, first, last) =>
      (first ? `초월 ${first}단계나 ` : '') + `초월 ${last}단계까지 올릴까`);
  }

  function createIndex(terms, column) {
    const targets = new Map();
    for (const row of terms) {
      const source = row[column];
      if (!source) continue;
      const target = row[2];
      // Keep conflicting translations in the downloadable dataset, but do
      // not require the AI to use one without knowing which entity was meant.
      if (targets.has(source) && targets.get(source) !== target) targets.set(source, null);
      else targets.set(source, target);
    }
    if (column === 0) {
      for (const name of ['세븐나이츠', '세븐 나이츠', '세나']) {
        for (const space of ['', ' ']) targets.set(name + space + '리버스', '七騎士 Re:BIRTH');
      }
    }
    const byInitial = new Map();
    for (const [source, target] of targets) {
      if (!byInitial.has(source[0])) byInitial.set(source[0], []);
      byInitial.get(source[0]).push({ source, target });
    }
    for (const group of byInitial.values()) group.sort((a, b) => b.source.length - a.source.length);
    return byInitial;
  }

  function matches(index, lines, language) {
    const picked = new Set();
    for (const line of lines) {
      for (let i = 0; i < line.length;) {
        const group = index.get(line[i]);
        const entry = group?.find(({ source }) => {
          if (!line.startsWith(source, i)) return false;
          // A single Korean syllable such as 리 also occurs in everyday words.
          if (source.length === 1 || /^[\x20-\x7e]+$/.test(source)) {
            return !letter.test(line[i - 1] ?? '') && !letter.test(line[i + source.length] ?? '');
          }
          return language !== 'ko' || !/\p{Script=Hangul}/u.test(line[i - 1] ?? '');
        });
        if (entry?.target) picked.add(entry);
        i += entry?.source.length || 1;
      }
    }
    return [...picked];
  }

  function prepare({ revision, terms }) {
    const indexes = new Map();
    return {
      revision,
      forBatch(language, lines) {
        if (language !== 'ko' && language !== 'th') return [];
        if (!indexes.has(language)) indexes.set(language, createIndex(terms, language === 'ko' ? 0 : 1));
        return matches(indexes.get(language), lines, language);
      },
    };
  }

  const api = { isGame, prepare, expandKoreanRankGoal };
  globalThis.bceSevenKnights = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
