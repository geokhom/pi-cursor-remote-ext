/**
 * Visible-column helpers for pi TUI custom components.
 *
 * pi crashes if any render() row is wider than the terminal:
 *   "Rendered line N exceeds terminal width"
 * Measure with visibleWidth() and clip with truncateToWidth() / wrapToWidth().
 *
 * wrapToWidth is iterative: lone CR (ssh/apt progress) must not recurse.
 */

/** CSI / OSC / simple ANSI — stripped for visible width only. */
export const ANSI_RE =
  /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

const LINE_BREAK_RE = /\r\n|\n|\r/;

/**
 * East-Asian / emoji fullwidth (wcwidth W+F). Cyrillic stays 1 column.
 * @param {number} cp
 */
export function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp === 0x09) return 8;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp >= 0x300 && cp <= 0x36f) return 0;
  if (cp >= 0x20d0 && cp <= 0x20ff) return 0;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return 0;
  if (cp >= 0xfe20 && cp <= 0xfe2f) return 0;
  if (
    cp === 0x200b ||
    cp === 0x200c ||
    cp === 0x200d ||
    cp === 0xfeff
  ) {
    return 0;
  }
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe19) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1aff0 && cp <= 0x1afff) ||
      (cp >= 0x1b000 && cp <= 0x1b122) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x1fa00 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x2fffd) ||
      (cp >= 0x30000 && cp <= 0x3fffd))
  ) {
    return 2;
  }
  return 1;
}

/**
 * Visible column width (ANSI ignored; CJK/emoji = 2; tab = 8).
 * @param {string} text
 */
export function visibleWidth(text) {
  if (!text) return 0;
  const s = String(text).replace(ANSI_RE, "");
  let w = 0;
  for (const ch of s) {
    w += codePointWidth(ch.codePointAt(0));
  }
  return w;
}

/**
 * Truncate to max visible columns, preserving leading ANSI where possible.
 * @param {string} text
 * @param {number} maxWidth
 * @param {string} [ellipsis]
 */
export function truncateToWidth(text, maxWidth, ellipsis = "…") {
  // Newlines must not survive: one render() entry = one TUI row.
  const s = String(text ?? "").replace(/[\r\n]/g, "");
  if (!(maxWidth > 0)) return "";
  if (visibleWidth(s) <= maxWidth) return s;
  const ellW = visibleWidth(ellipsis);
  const budget = Math.max(0, maxWidth - ellW);
  let out = "";
  let w = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = codePointWidth(cp);
    if (cw > 0 && w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return out + ellipsis;
}

/**
 * Wrap one logical line (no CR/LF) to `width` columns.
 * @param {string} line
 * @param {number} width
 * @returns {string[]}
 */
function wrapLineToWidth(line, width) {
  const s = String(line ?? "");
  if (!s) return [""];
  /** @type {string[]} */
  const rows = [];
  let row = "";
  let col = 0;
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\u001b") {
      ANSI_RE.lastIndex = i;
      const m = ANSI_RE.exec(s);
      if (m && m.index === i) {
        row += m[0];
        i += m[0].length;
        continue;
      }
    }
    const cp = s.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    i += ch.length;
    if (cp === 0x09) {
      const spaces = 8 - (col % 8);
      for (let k = 0; k < spaces; k++) {
        if (col >= width) {
          rows.push(row);
          row = "";
          col = 0;
        }
        row += " ";
        col += 1;
      }
      continue;
    }
    const cw = codePointWidth(cp);
    if (cw === 0) {
      if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) continue;
      row += ch;
      continue;
    }
    if (col + cw > width && col > 0) {
      rows.push(row);
      row = "";
      col = 0;
    }
    row += ch;
    col += cw;
  }
  rows.push(row);
  return rows.map((r) =>
    visibleWidth(r) > width ? truncateToWidth(r, width, "") : r
  );
}

/**
 * Split text into width-sized rows (visible columns, not code points).
 * CR / LF / CRLF become extra rows — never kept inside a chunk
 * (pi TUI height is `render().length`; a `\n` inside one row paints extra
 * terminal lines without background). Iterative: a lone `\r` must not recurse.
 * @param {string} text
 * @param {number} width
 * @returns {string[]}
 */
export function wrapToWidth(text, width) {
  const parts = String(text ?? "").split(LINE_BREAK_RE);
  if (!(width > 0)) return parts.length ? parts : [""];
  /** @type {string[]} */
  const out = [];
  for (const part of parts) {
    out.push(...wrapLineToWidth(part, width));
  }
  return out.length ? out : [""];
}

export { LINE_BREAK_RE };
