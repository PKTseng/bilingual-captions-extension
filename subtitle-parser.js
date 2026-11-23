(() => {
  'use strict';

  function parseSubtitleFile(source) {
    const timestamp = String.raw`((?:\d{2,}:)?\d{2}:\d{2}[,.]\d{3})`;
    const range = new RegExp(`^${timestamp}\\s+-->\\s+${timestamp}(?:\\s+.*)?$`);
    const seconds = (stamp) => {
      const parts = stamp.split(/[:,.]/).map(Number);
      const milli = parts.pop();
      return parts.reduce((time, part) => time * 60 + part, 0) + milli / 1000;
    };
    return source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim()
      .split(/\n[ \t]*\n/).flatMap((block) => {
        const lines = block.split('\n');
        const index = lines.findIndex((line) => range.test(line.trim()));
        if (index === -1) return [];
        const [, from, to] = lines[index].trim().match(range);
        const [start, end] = [seconds(from), seconds(to)];
        const pieces = lines.slice(index + 1).join(' ').split(/(<[^>]+>)/);
        let text = '';
        let pendingTime;
        const marks = [];
        for (const piece of pieces) {
          if (piece.startsWith('<')) {
            const marker = piece.slice(1, -1);
            if (/^(?:\d{2,}:)?\d{2}:\d{2}\.\d{3}$/.test(marker)) pendingTime = seconds(marker);
            continue;
          }
          const clean = piece.replace(/\s+/g, ' ');
          const leading = clean.search(/\S/);
          if (pendingTime !== undefined && leading >= 0 && pendingTime >= start && pendingTime <= end) {
            marks.push({ index: text.length + leading, time: pendingTime });
            pendingTime = undefined;
          }
          text += clean;
        }
        const leading = text.length - text.trimStart().length;
        return text.trim() && end > start ? [{
          start, end, text: text.trim(),
          marks: marks.map((mark) => ({ ...mark, index: mark.index - leading })),
        }] : [];

      }).sort((a, b) => a.start - b.start);
  }

  globalThis.bceSubtitleParser = { parseSubtitleFile };
})();
