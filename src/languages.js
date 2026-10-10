'use strict';

const vscode = require('vscode');
const { parseJsonc, rulesFromConfigs } = require('./rules');

/** @typedef {import('./scanner').LanguageRules} LanguageRules */

/** @type {Map<string, Promise<LanguageRules | undefined>>} */
const cache = new Map();

/**
 * The comment syntax of a language, taken from the language configuration that the extension
 * providing the language ships with. VS Code offers no API for this, so the files are read directly.
 *
 * @param {string} languageId
 * @returns {Promise<LanguageRules | undefined>} undefined for languages without comments
 */
function rulesFor(languageId) {
  let rules = cache.get(languageId);
  if (!rules) {
    rules = loadRules(languageId);
    cache.set(languageId, rules);
  }
  return rules;
}

async function loadRules(languageId) {
  const configs = [];
  for (const extension of vscode.extensions.all) {
    for (const language of extension.packageJSON?.contributes?.languages ?? []) {
      if (language.id !== languageId || !language.configuration) continue;
      try {
        const file = vscode.Uri.joinPath(extension.extensionUri, language.configuration);
        const bytes = await vscode.workspace.fs.readFile(file);
        configs.push(parseJsonc(new TextDecoder().decode(bytes)));
      } catch {
        // A missing or malformed configuration only means this extension has nothing to tell us.
      }
    }
  }
  return rulesFromConfigs(languageId, configs);
}

/** Forgets everything loaded so far; call when extensions are installed or removed. */
function forgetRules() {
  cache.clear();
}

module.exports = { rulesFor, forgetRules };
