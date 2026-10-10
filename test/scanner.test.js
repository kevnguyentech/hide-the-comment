'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  findComments,
  lineStarts,
  positionAt,
  commentOnlyLineRuns,
  indentFoldingRanges,
} = require('../src/scanner');
const { parseJsonc, rulesFromConfigs } = require('../src/rules');

const C_LIKE = { line: ['//'], block: [['/*', '*/']], quotes: ['"', "'", '`'], tripleQuotes: false, offSide: false };
const PYTHON = { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: true, offSide: true };
const SHELL = { line: ['#'], block: [], quotes: ['"', "'", '`'], tripleQuotes: false, offSide: false };
const HTML = { line: [], block: [['<!--', '-->']], quotes: [], tripleQuotes: false, offSide: false };
const LUA = { line: ['--'], block: [['--[[', ']]']], quotes: ['"', "'"], tripleQuotes: false, offSide: false };

/** The text of each comment found, which reads better in assertions than offsets. */
function comments(text, rules) {
  return findComments(text, rules).map(({ start, end }) => text.slice(start, end));
}

test('finds line and block comments', () => {
  const text = 'let a = 1; // one\n/* two\n   lines */\nlet b = /* inline */ 2;\n';
  assert.deepEqual(comments(text, C_LIKE), ['// one', '/* two\n   lines */', '/* inline */']);
});

test('ignores comment tokens inside strings', () => {
  const text = [
    'const url = "http://example.com"; // real',
    "const s = '/* not */';",
    'const t = `multi',
    '// still the template',
    '`; // after',
    'const e = "escaped \\" // quote";',
  ].join('\n');
  assert.deepEqual(comments(text, C_LIKE), ['// real', '// after']);
});

test('ignores escaped slashes in a regex and the slashes of a bare URL', () => {
  assert.deepEqual(comments('const re = /https?:\\/\\//; // c', C_LIKE), ['// c']);
  assert.deepEqual(comments('<a>see http://example.com</a>', C_LIKE), []);
});

test('an unterminated quote does not swallow the following lines', () => {
  assert.deepEqual(comments("it's fine\n// comment", C_LIKE), ['// comment']);
});

test('an unterminated block comment runs to the end of the text', () => {
  assert.deepEqual(comments('a /* open\nmore', C_LIKE), ['/* open\nmore']);
});

test('a line comment stops before a carriage return', () => {
  assert.deepEqual(comments('a // one\r\nb // two\r\n', C_LIKE), ['// one', '// two']);
});

test('python: hash comments, but not hashes inside strings or docstrings', () => {
  const text = [
    '# top',
    'def f():',
    '    """Docstring with a # inside',
    '    # not a comment either',
    '    """',
    "    x = '#no'  # yes",
  ].join('\n');
  assert.deepEqual(comments(text, PYTHON), ['# top', '# yes']);
});

test('shell: $# and ${#name} are not comments', () => {
  const text = 'echo $# ${#name} # count\nfoo#bar\n';
  assert.deepEqual(comments(text, SHELL), ['# count']);
});

test('markup: apostrophes in prose do not hide a later comment', () => {
  assert.deepEqual(comments("<p>don't</p> <!-- note -->", HTML), ['<!-- note -->']);
});

test('prefers a block comment over a line comment sharing its prefix', () => {
  assert.deepEqual(comments('--[[ a\nb ]] x -- c', LUA), ['--[[ a\nb ]]', '-- c']);
});

test('positionAt maps offsets to lines and characters', () => {
  const starts = lineStarts('ab\ncd\n');
  assert.deepEqual(starts, [0, 3, 6]);
  assert.deepEqual(positionAt(starts, 0), { line: 0, character: 0 });
  assert.deepEqual(positionAt(starts, 4), { line: 1, character: 1 });
  assert.deepEqual(positionAt(starts, 6), { line: 2, character: 0 });
});

test('commentOnlyLineRuns groups lines that hold only comments', () => {
  const text = [
    '// a', //              0
    '  // b', //            1
    'code(); // trailing', // 2
    '', //                  3
    '/* c', //              4
    '', //                  5  blank, but inside the block comment
    '   d */', //           6
    '/* e */ code();', //   7
    '// f', //              8
  ].join('\n');
  const runs = commentOnlyLineRuns(text, findComments(text, C_LIKE), lineStarts(text));
  assert.deepEqual(runs, [{ start: 0, end: 1 }, { start: 4, end: 6 }, { start: 8, end: 8 }]);
});

test('commentOnlyLineRuns handles a trailing newline and no comments', () => {
  const text = '// a\n// b\n';
  assert.deepEqual(commentOnlyLineRuns(text, findComments(text, C_LIKE), lineStarts(text)), [{ start: 0, end: 1 }]);
  assert.deepEqual(commentOnlyLineRuns('x\ny', [], lineStarts('x\ny')), []);
});

test('indentFoldingRanges follows indentation', () => {
  const text = [
    'def a():', //      0
    '    if x:', //     1
    '        y', //     2
    '    z', //         3
    '', //              4
    'def b():', //      5
    '\treturn 1', //    6
  ].join('\n');
  const starts = lineStarts(text);
  assert.deepEqual(indentFoldingRanges(text, starts, 4, true), [
    { start: 0, end: 3 },
    { start: 1, end: 2 },
    { start: 5, end: 6 },
  ]);
  // Without the off-side rule a block keeps the blank lines that follow it.
  assert.deepEqual(indentFoldingRanges(text, starts, 4, false)[0], { start: 0, end: 4 });
});

test('parseJsonc accepts comments and trailing commas', () => {
  const text = '{\n  // line\n  "a": "x // y", /* block */\n  "b": [1, 2,],\n  "c": ",]",\n}';
  assert.deepEqual(parseJsonc(text), { a: 'x // y', b: [1, 2], c: ',]' });
});

test('rulesFromConfigs reads comment tokens and quote characters', () => {
  const rules = rulesFromConfigs('javascript', [{
    comments: { lineComment: { comment: '//' }, blockComment: ['/*', '*/'] },
    autoClosingPairs: [{ open: '{', close: '}' }, { open: '"', close: '"' }, ['`', '`']],
    surroundingPairs: [["'", "'"]],
  }]);
  assert.deepEqual(rules, {
    line: ['//'],
    block: [['/*', '*/']],
    quotes: ['"', '`', "'"],
    tripleQuotes: false,
    offSide: false,
  });
});

test('rulesFromConfigs treats python triple quotes as strings, not comments', () => {
  const rules = rulesFromConfigs('python', [{
    comments: { lineComment: '#', blockComment: ['"""', '"""'] },
    folding: { offSide: true },
  }]);
  assert.deepEqual(rules, { line: ['#'], block: [], quotes: ['"', "'"], tripleQuotes: true, offSide: true });
});

test('rulesFromConfigs: no strings in markup, nothing for languages without comments', () => {
  const html = rulesFromConfigs('html', [{
    comments: { blockComment: ['<!--', '-->'] },
    autoClosingPairs: [{ open: "'", close: "'" }],
  }]);
  assert.deepEqual(html.quotes, []);
  assert.equal(rulesFromConfigs('plaintext', []), undefined);
  assert.equal(rulesFromConfigs('x', [{ brackets: [] }]), undefined);
});

test('rulesFromConfigs drops a block comment that only repeats the line token', () => {
  const rules = rulesFromConfigs('ini', [{ comments: { lineComment: ';', blockComment: [';', ' '] } }]);
  assert.deepEqual(rules.block, []);
  assert.deepEqual(comments(';comment\n[section]\nkey=value\n', rules), [';comment']);
  assert.deepEqual(comments('; a comment here\nkey = value\n', rules), ['; a comment here']);
});
