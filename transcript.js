// Turns line-based cues (YouTube's transcript panel, imported SRT/VTT) into
// whole-sentence cues, and reads/opens the transcript panel on the watch page.
(() => {
  'use strict';

  const TRANSCRIPT_ROWS = 'ytd-transcript-segment-renderer, transcript-segment-view-model, yt-transcript-segment-view-model';
  const sentenceSegmenter = new Intl.Segmenter('en', { granularity: 'sentence' });

  // Joins neighbouring lines, re-splits the text into sentences, and gives
  // each sentence a time range interpolated from the lines it spans.
  function sentenceCues(cues) {
    const sentences = [];
    let text = '';
    let spans = [];
    function flush() {
      for (const { segment, index } of sentenceSegmenter.segment(text)) {
        const phrase = segment.trim();
        if (!phrase) continue;
        const startIndex = index + segment.search(/\S/);
        const endIndex = startIndex + phrase.length;
        const first = spans.find((span) => span.to > startIndex);
        const last = spans.find((span) => span.to >= endIndex);
        const cueTime = (span, position) => {
          const ratio = Math.max(0, Math.min(1, (position - span.from) / (span.to - span.from)));
          return span.start + ratio * (span.end - span.start);
        };
        const start = cueTime(first, startIndex);
        const end = cueTime(last, endIndex);
        const marks = spans.flatMap((span) => (span.marks ?? [])
          .map((mark) => ({ index: span.from + mark.index - startIndex, time: mark.time })))
          .filter((mark) => mark.index >= 0 && mark.index < phrase.length);
        const startMark = marks.find((mark) => mark.index === 0);
        const endMark = last.marks?.find((mark) => last.from + mark.index === endIndex + 1);
        const markedStart = startMark?.time ?? start;
        const markedEnd = endMark?.time ?? end;
        if (markedEnd > markedStart) sentences.push({ start: markedStart, end: markedEnd, text: phrase, marks });
      }
      text = '';
      spans = [];
    }
    for (const cue of cues) {
      const line = cue.text.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      const previous = spans[spans.length - 1];
      if (previous && (cue.start - previous.end > 1 || text.length >= 1000)) flush();
      if (text) text += ' ';
      const from = text.length;
      text += line;
      spans.push({ ...cue, from, to: text.length });
    }
    flush();
    sentences.sort((a, b) => a.start - b.start);
    return sentences.map((cue, index) => ({
      ...cue,
      end: Math.min(cue.end, sentences[index + 1]?.start ?? Infinity),
    })).filter((cue) => cue.end > cue.start);
  }

  // Reads the visible transcript panel. Its timestamps only have whole
  // seconds, so each line ends where the next begins (at most 7 s later).
  function readTranscript(video) {
    const rows = [...document.querySelectorAll(TRANSCRIPT_ROWS)].filter((row) => row.getClientRects().length);
    const segments = rows.flatMap((row) => {
      const stamp = row.querySelector('.segment-timestamp, [class*="timestamp"]')?.textContent.trim();
      if (!stamp || !/^\d+(?::\d{2}){1,2}$/.test(stamp)) return [];
      const text = row.querySelector('.segment-text, [class*="segment-text"], [class*="segmentText"], [class*="transcriptSegmentText"]')?.textContent.trim();
      const start = stamp.split(':').reduce((time, part) => time * 60 + Number(part), 0);
      return text ? [{ start, text }] : [];
    }).sort((a, b) => a.start - b.start);
    const cues = segments.filter((cue, i) => cue.start !== segments[i + 1]?.start)
      .map((cue, i, list) => ({
        ...cue,
        end: Math.min(
          list[i + 1]?.start ?? (video.duration || Infinity),
          cue.start + 7,
        ),
      }));
    return sentenceCues(cues.filter((cue) => cue.end > cue.start));
  }

  // Clicks the description's "Show transcript" button; true if it found one.
  function openTranscript() {
    const button = [...document.querySelectorAll(
      'ytd-video-description-transcript-section-renderer button, #description button, ytd-watch-metadata button'
    )].find((item) => {
      const label = item.getAttribute('aria-label') || item.textContent.trim();
      return /^(show transcript|顯示逐字稿|顯示轉錄稿)$/i.test(label) && item.getClientRects().length;
    });
    button?.click();
    return Boolean(button);
  }

  const api = { sentenceCues, readTranscript, openTranscript };
  globalThis.bceTranscript = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
