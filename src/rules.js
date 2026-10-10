'use strict';

/** @typedef {import('./scanner').LanguageRules} LanguageRules */

const QUOTES = ['"', "'", '`'];

// Languages in which """ (or ''') delimits a string that may span lines.
const TRIPLE_QUOTED = new Set([
  'python', 'java', 'kotlin', 'scala', 'swift', 'dart', 'groovy', 'julia', 'elixir', 'csharp', 'toml',
]);

/**
 * Parses JSON that may contain comments and trailing commas, as `language-configuration.json`
 * files do.
 *
 * @param {string} text
 */
function parseJsonc(text) {
  let json = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\') i++;
      }
      json += text.slice(start, i + 1);
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i + 1 < text.length && text[i + 1] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 1;
    } else if (ch === '}' || ch === ']') {
      json = json.replace(/,\s*$/, '') + ch;
    } else {
      json += ch;
    }
  }
  return JSON.parse(json);
}

/**
 * Derives the rules for one language from its language configuration files.
 *
 * @param {string} languageId
 * @param {any[]} configs parsed `language-configuration.json` contents
 * @returns {LanguageRules | undefined} undefined when the language declares no comment syntax
 */
function rulesFromConfigs(languageId, configs) {
  const line = new Set();
  const block = new Map();
  const quotes = new Set();
  let offSide = false;

  for (const config of configs) {
    if (!config) continue;
    const { lineComment, blockComment } = config.comments ?? {};
    // Either a plain token or `{ "comment": "//", "noIndent": true }`.
    const token = typeof lineComment === 'string' ? lineComment : lineComment?.comment;
    if (token) line.add(token);
    if (Array.isArray(blockComment) && blockComment[0] && blockComment[1]) {
      block.set(blockComment[0], blockComment[1]);
    }
    for (const pair of [...(config.autoClosingPairs ?? []), ...(config.surroundingPairs ?? [])]) {
      const [open, close] = Array.isArray(pair) ? pair : [pair.open, pair.close];
      if (open === close && QUOTES.includes(open)) quotes.add(open);
    }
    offSide ||= config.folding?.offSide === true;
  }

  // Python declares """ as its block comment, but that is a string literal and may hold real data.
  for (const open of [...block.keys()]) {
    if (QUOTES.includes(open[0])) block.delete(open);
  }
  if (line.size === 0 && block.size === 0) return undefined;

  let quoteList = quotes.size > 0 ? [...quotes] : ['"', "'"];
  // In markup, a quote character is far more often an apostrophe in prose than a string delimiter.
  if (block.has('<!--')) quoteList = [];

  return {
    // Longest first, so that `--[[` is tried before `--`.
    line: [...line].sort((a, b) => b.length - a.length),
    block: [...block].sort(([a], [b]) => b.length - a.length),
    quotes: quoteList,
    tripleQuotes: TRIPLE_QUOTED.has(languageId),
    offSide,
  };
}

module.exports = { parseJsonc, rulesFromConfigs };
