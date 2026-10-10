'use strict';

/**
 * @typedef {object} LanguageRules
 * @property {string[]} line Tokens that start a comment running to the end of the line.
 * @property {[string, string][]} block Opening and closing tokens of block comments.
 * @property {string[]} quotes Characters that delimit string literals.
 * @property {boolean} tripleQuotes Whether """ and ''' delimit strings that may span lines.
 * @property {boolean} offSide Whether blocks are delimited by indentation alone, as in Python.
 *
 * @typedef {{ start: number, end: number }} Span Offsets into the text; `end` is exclusive.
 * @typedef {{ start: number, end: number }} LineRange Zero-based line numbers; `end` is inclusive.
 */

/**
 * Finds every comment in `text`.
 *
 * This is a scan for comment tokens that steps over string literals, not a parser, so unusual
 * constructs (a regex literal holding a quote, a here-document) can fool it.
 *
 * @param {string} text
 * @param {LanguageRules} rules
 * @returns {Span[]} in document order
 */
function findComments(text, rules) {
  const interesting = new Set(['\\', ...rules.quotes]);
  for (const token of rules.line) interesting.add(token[0]);
  for (const [open] of rules.block) interesting.add(open[0]);

  const comments = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!interesting.has(ch)) {
      i++;
      continue;
    }
    const end = commentEnd(text, i, rules);
    if (end !== -1) {
      comments.push({ start: i, end });
      i = end;
    } else if (ch === '\\') {
      i += 2;
    } else if (rules.quotes.includes(ch)) {
      i = stringEnd(text, i, rules.tripleQuotes);
    } else {
      i++;
    }
  }
  return comments;
}

/** @returns {number} where the comment starting at `i` ends, or -1 if none starts there */
function commentEnd(text, i, rules) {
  for (const [open, close] of rules.block) {
    if (text.startsWith(open, i)) {
      const closeAt = text.indexOf(close, i + open.length);
      return closeAt === -1 ? text.length : closeAt + close.length;
    }
  }
  for (const token of rules.line) {
    if (text.startsWith(token, i) && opensLineComment(text, i, token)) {
      let end = text.indexOf('\n', i);
      if (end === -1) end = text.length;
      return text[end - 1] === '\r' ? end - 1 : end;
    }
  }
  return -1;
}

// Two common tokens also turn up inside ordinary code: `$#` and `${#name}` in shell scripts, and
// the `//` of a bare URL.
function opensLineComment(text, i, token) {
  const before = text[i - 1];
  if (token === '#') return before === undefined || /\s/.test(before);
  if (token === '//') return before !== ':';
  return true;
}

/** @returns {number} the offset just past the string literal that opens at `i` */
function stringEnd(text, i, tripleQuotes) {
  const quote = text[i];
  if (tripleQuotes && quote !== '`' && text.startsWith(quote.repeat(3), i)) {
    const closeAt = text.indexOf(quote.repeat(3), i + 3);
    return closeAt === -1 ? text.length : closeAt + 3;
  }
  const spansLines = quote === '`';
  for (let j = i + 1; j < text.length; j++) {
    const ch = text[j];
    if (ch === '\\') j++;
    else if (ch === quote) return j + 1;
    // A stray quote (an apostrophe, say) must not swallow the lines that follow it.
    else if (ch === '\n' && !spansLines) return j;
  }
  return text.length;
}

/** @returns {number[]} the offset at which each line of `text` begins */
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return starts;
}

/**
 * @param {number[]} starts
 * @param {number} offset
 * @returns {{ line: number, character: number }}
 */
function positionAt(starts, offset) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (starts[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return { line: low, character: offset - starts[low] };
}

function isBlank(charCode) {
  return charCode === 32 || (charCode >= 9 && charCode <= 13);
}

/**
 * Finds the maximal runs of consecutive lines that hold comments and nothing else. Empty lines
 * count only when they sit inside a block comment.
 *
 * @param {string} text
 * @param {Span[]} comments as returned by `findComments`
 * @param {number[]} starts as returned by `lineStarts`
 * @returns {LineRange[]}
 */
function commentOnlyLineRuns(text, comments, starts) {
  const lineCount = starts.length;
  const commented = new Uint8Array(lineCount);
  const hasCode = new Uint8Array(lineCount);

  // Offsets are only ever looked up in increasing order, so one cursor serves them all.
  let line = 0;
  const lineOf = (offset) => {
    while (line + 1 < lineCount && starts[line + 1] <= offset) line++;
    return line;
  };
  const markCode = (from, to) => {
    for (let i = from; i < to; i++) {
      if (isBlank(text.charCodeAt(i))) continue;
      const at = lineOf(i);
      hasCode[at] = 1;
      if (at + 1 === lineCount) break;
      i = starts[at + 1] - 1;
    }
  };

  let codeFrom = 0;
  for (const { start, end } of comments) {
    markCode(codeFrom, start);
    const first = lineOf(start);
    commented.fill(1, first, lineOf(Math.max(start, end - 1)) + 1);
    codeFrom = end;
  }
  markCode(codeFrom, text.length);

  const runs = [];
  for (let at = 0; at < lineCount; at++) {
    if (!commented[at] || hasCode[at]) continue;
    let end = at;
    while (end + 1 < lineCount && commented[end + 1] && !hasCode[end + 1]) end++;
    runs.push({ start: at, end });
    at = end;
  }
  return runs;
}

/** @returns {number} the indentation of the line starting at `offset`, or -1 if it is blank */
function indentOf(text, offset, tabSize) {
  let indent = 0;
  for (let i = offset; i < text.length; i++) {
    const ch = text[i];
    if (ch === ' ') indent++;
    else if (ch === '\t') indent += tabSize - (indent % tabSize);
    else return ch === '\n' || ch === '\r' ? -1 : indent;
  }
  return -1;
}

/**
 * Folding ranges derived from indentation: each line folds the more deeply indented lines below
 * it. Mirrors the folding VS Code falls back on for languages without a folding provider.
 *
 * @param {string} text
 * @param {number[]} starts as returned by `lineStarts`
 * @param {number} tabSize
 * @param {boolean} offSide when set, blank lines after a block are left out of its range
 * @returns {LineRange[]}
 */
function indentFoldingRanges(text, starts, tabSize, offSide) {
  const ranges = [];
  // Walking upwards: the blocks still open above the current line, innermost last. `below` is the
  // first line under a block that is no longer part of it.
  const open = [{ indent: -1, below: starts.length }];
  for (let line = starts.length - 1; line >= 0; line--) {
    const indent = indentOf(text, starts[line], tabSize);
    let top = open[open.length - 1];
    if (indent === -1) {
      if (offSide) top.below = line;
      continue;
    }
    if (top.indent > indent) {
      do {
        open.pop();
        top = open[open.length - 1];
      } while (top.indent > indent);
      const end = top.below - 1;
      if (end > line) ranges.push({ start: line, end });
    }
    if (top.indent === indent) top.below = line;
    else open.push({ indent, below: line });
  }
  return ranges.reverse();
}

module.exports = { findComments, lineStarts, positionAt, commentOnlyLineRuns, indentFoldingRanges };
