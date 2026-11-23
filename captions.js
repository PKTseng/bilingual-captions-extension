// Turns YouTube json3 caption events into sentence cues whose start and end
// come from real word times instead of character-count guesses.
(() => {
  'use strict';

  const SENTENCE_END = /[.!?…]["'”’)\]]*$/;
  const CLAUSE_END = /(?:[,;:—–]|--)["'”’)\]]*$/;
  const SOUND_TAG = /^[([][^)\]]*[)\]][.,]?$/;
  const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|st|jr|sr|vs|etc|e\.g|i\.e|u\.s|a\.m|p\.m)\.$/i;
  const LONG_PAUSE = 1.2;
  const MAX_WORDS = 22;
  const MAX_SECONDS = 8;
  // Auto-generated tracks give each word a start but no end; a spoken word
  // lasts roughly this long, so a later start than that means a pause.
  const asrWordSeconds = (text) => Math.min(0.9, 0.12 + 0.065 * text.length);
  const HOLD_SECONDS = 0.6;

  // One entry per word: { text, start, end }. Auto-generated tracks carry a
  // time for every word (tOffsetMs); human-made tracks only time each line, so
  // words inside a line are spread across it by character position.
  function wordsFromEvents(events, asr) {
    const words = [];
    let speakerChange = false;
    for (const event of events) {
      if (!event.segs || typeof event.tStartMs !== 'number') continue;
      const eventStart = event.tStartMs / 1000;
      const eventEnd = (event.tStartMs + (event.dDurationMs ?? 0)) / 1000;
      const segs = event.segs
        .map((seg) => ({ text: (seg.utf8 ?? '').replace(/\s+/g, ' ').trim(), time: eventStart + (seg.tOffsetMs ?? 0) / 1000 }))
        .filter((seg) => seg.text);
      segs.forEach((seg, i) => {
        const until = Math.max(seg.time, segs[i + 1]?.time ?? eventEnd);
        const length = seg.text.length;
        for (const match of seg.text.matchAll(/\S+/g)) {
          // ">>" marks a new speaker: start a new sentence, don't show it.
          if (/^>>+$/.test(match[0])) {
            speakerChange = true;
            continue;
          }
          const start = seg.time + (until - seg.time) * (match.index / length);
          words.push({ text: match[0], start, end: eventEnd, breakBefore: speakerChange });
          speakerChange = false;
        }
      });
    }
    words.sort((a, b) => a.start - b.start);
    words.forEach((word, i) => {
      const next = words[i + 1];
      if (next) word.end = Math.min(word.end, next.start);
      if (asr) word.end = Math.min(word.end, word.start + asrWordSeconds(word.text));
      word.end = Math.max(word.end, word.start);
    });
    return words;
  }

  function gapAfter(words, i) {
    return words[i + 1] ? words[i + 1].start - words[i].end : Infinity;
  }

  // Split at punctuation when the track has it, otherwise at pauses. A line
  // that grows too long is cut at its biggest pause in the second half.
  function splitSentences(words) {
    const punctuated = words.filter((word) => /[.!?,]["'”’)\]]*$/.test(word.text)).length
      > words.length * 0.03;
    const sentences = [];
    let from = 0;
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const count = i - from + 1;
      const duration = word.end - words[from].start;
      const gap = gapAfter(words, i);
      const last = i === words.length - 1;
      const sentenceEnd = SENTENCE_END.test(word.text) && !ABBREVIATION.test(word.text);
      const clauseEnd = CLAUSE_END.test(word.text);
      const tagEdge = SOUND_TAG.test(word.text) || SOUND_TAG.test(words[i + 1]?.text ?? '')
        || Boolean(words[i + 1]?.breakBefore);
      let cut = last || gap >= LONG_PAUSE || sentenceEnd || tagEdge
        || (clauseEnd && (count >= 14 || duration >= 5))
        || (!punctuated && gap >= 0.6 && count >= 6)
        || (!punctuated && gap >= 0.35 && count >= 12);
      let at = i;
      if (!cut && (count >= MAX_WORDS || duration >= MAX_SECONDS)) {
        cut = true;
        for (let j = from + Math.floor(count / 2); j < i; j++) {
          if (gapAfter(words, j) > gapAfter(words, at)) at = j;
        }
      }
      if (!cut) continue;
      sentences.push(words.slice(from, at + 1));
      from = at + 1;
      i = at;
    }
    return { sentences, punctuated };
  }

  function toCue(words, punctuated) {
    let text = '';
    const marks = words.map((word) => {
      if (text) text += ' ';
      const mark = { index: text.length, time: word.start };
      text += word.text;
      return mark;
    });
    if (!punctuated) text = text.replace(/\bi\b/g, 'I');
    return { start: words[0].start, end: words[words.length - 1].end, text, marks };
  }

  // A sentence stays on screen a moment after its last word, and is replaced
  // as soon as the next sentence starts.
  function fromJson3(events, { asr = false } = {}) {
    const words = wordsFromEvents(events, asr);
    if (!words.length) return [];
    const { sentences, punctuated } = splitSentences(words);
    const cues = sentences.map((group) => toCue(group, punctuated));
    return cues.map((cue, i) => {
      const next = cues[i + 1];
      const held = cue.end + HOLD_SECONDS;
      const end = next && next.start - cue.end < 1 ? next.start : Math.min(held, next?.start ?? Infinity);
      return { ...cue, end: Math.max(end, cue.start + 0.3) };
    });
  }

  const api = { fromJson3, wordsFromEvents, splitSentences };
  globalThis.bceCaptions = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
