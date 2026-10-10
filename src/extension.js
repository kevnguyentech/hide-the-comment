'use strict';

const vscode = require('vscode');
const { rulesFor, forgetRules } = require('./languages');
const {
  findComments,
  lineStarts,
  positionAt,
  commentOnlyLineRuns,
  indentFoldingRanges,
} = require('./scanner');

/** @typedef {import('./scanner').LineRange} LineRange */

/**
 * @typedef {object} Analysis
 * @property {vscode.Range[]} comments Every comment in the document.
 * @property {LineRange[]} blocks Runs of two or more lines that hold nothing but comments.
 * @property {LineRange[]} indentFolds Indentation-based folding ranges; empty when `blocks` is.
 */

const HIDDEN_KEY = 'hidden';
const FOLDED_KEY = 'folded';
const REFRESH_DELAY_MS = 100;

/** @type {Analysis} */
const NOTHING = { comments: [], blocks: [], indentFolds: [] };

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const hiddenStyle = vscode.window.createTextEditorDecorationType({
    // Decorations cannot remove text from view. Smuggling `display: none` in through a CSS-valued
    // property is the long-standing workaround.
    textDecoration: 'none; display: none;',
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'hideComments.toggle';
  const foldingChanged = new vscode.EventEmitter();

  /** Whether comments are hidden. Applies to every file in the workspace. */
  let hidden = context.workspaceState.get(HIDDEN_KEY, false);
  /** Whether comment blocks are folded away as well: `hidden`, and the setting allows it. */
  let collapsing = false;
  /** Documents (by URI) folded since `collapsing` last came on, so that each is folded only once. */
  const collapsed = new Set();
  /**
   * Documents holding folds of ours that have not been undone yet. VS Code keeps a folded region
   * folded after its provider stops reporting it, and remembers it across restarts, so each of
   * these has to be unfolded explicitly, however much later it is next shown.
   *
   * @type {Set<string>}
   */
  const folded = new Set(context.workspaceState.get(FOLDED_KEY, []));

  /** @type {WeakMap<vscode.TextDocument, { version: number, languageId: string, result: Promise<Analysis> }>} */
  let analyses = new WeakMap();
  /** What each editor currently has hidden, to skip redundant updates. */
  const applied = new WeakMap();
  let refreshTimer;

  /** @param {vscode.TextDocument} document */
  function isAnalysisCurrent(document) {
    const cached = analyses.get(document);
    return cached?.version === document.version && cached.languageId === document.languageId;
  }

  /**
   * @param {vscode.TextDocument} document
   * @returns {Promise<Analysis>}
   */
  function analyze(document) {
    if (isAnalysisCurrent(document)) return analyses.get(document).result;
    const text = document.getText();
    const tabSize = Number(vscode.workspace.getConfiguration('editor', document).get('tabSize')) || 4;
    const result = rulesFor(document.languageId).then((rules) => {
      if (!rules) return NOTHING;
      const starts = lineStarts(text);
      const spans = findComments(text, rules);
      const toPosition = (offset) => {
        const { line, character } = positionAt(starts, offset);
        return new vscode.Position(line, character);
      };
      const blocks = commentOnlyLineRuns(text, spans, starts).filter((run) => run.end > run.start);
      return {
        comments: spans.map((span) => new vscode.Range(toPosition(span.start), toPosition(span.end))),
        blocks,
        indentFolds: blocks.length > 0 ? indentFoldingRanges(text, starts, tabSize, rules.offSide) : [],
      };
    });
    analyses.set(document, { version: document.version, languageId: document.languageId, result });
    return result;
  }

  /** @param {vscode.TextEditor} editor */
  async function decorate(editor) {
    if (!hidden) {
      if (applied.delete(editor)) editor.setDecorations(hiddenStyle, []);
      return;
    }
    const { document } = editor;
    const { version } = document;
    const analysis = await analyze(document);
    if (!hidden || document.version !== version) return;

    // A comment the cursor is inside of, or that is part of the selection, stays visible, so that
    // nobody types into or copies text they cannot see.
    const selections = editor === vscode.window.activeTextEditor ? editor.selections : [];
    const revealed = [];
    const concealed = analysis.comments.filter((range, index) => {
      const touched = selections.some(
        (selection) => selection.end.isAfter(range.start) && selection.start.isBeforeOrEqual(range.end),
      );
      if (touched) revealed.push(index);
      return !touched;
    });

    const key = revealed.join();
    const last = applied.get(editor);
    if (last?.analysis === analysis && last.key === key) return;
    applied.set(editor, { analysis, key });
    editor.setDecorations(hiddenStyle, concealed);
  }

  function refresh() {
    for (const editor of vscode.window.visibleTextEditors) decorate(editor);
  }

  function refreshSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, REFRESH_DELAY_MS);
  }

  /** @type {vscode.FoldingRangeProvider} */
  const foldingProvider = {
    onDidChangeFoldingRanges: foldingChanged.event,
    async provideFoldingRanges(document) {
      // Keep reporting for documents that still hold our folds: unfolding needs the ranges.
      if (!collapsing && !folded.has(document.uri.toString())) return undefined;
      const { blocks, indentFolds } = await analyze(document);
      // Once any provider returns ranges, VS Code drops its indentation-based folding, which is all
      // that languages without a folding provider of their own have. So stay out of the way unless
      // there is something to fold, and then supply the indentation ranges along with ours.
      if (blocks.length === 0) return undefined;
      return [
        ...blocks.map(({ start, end }) => new vscode.FoldingRange(start, end, vscode.FoldingRangeKind.Comment)),
        ...indentFolds.map(({ start, end }) => new vscode.FoldingRange(start, end)),
      ];
    },
  };

  /** @param {vscode.TextEditor} editor */
  function middleVisibleLine(editor) {
    const size = (range) => range.end.line - range.start.line + 1;
    let remaining = Math.floor(editor.visibleRanges.reduce((total, range) => total + size(range), 0) / 2);
    for (const range of editor.visibleRanges) {
      if (remaining < size(range)) return range.start.line + remaining;
      remaining -= size(range);
    }
    return undefined;
  }

  /**
   * Runs a folding command without letting it move the viewport. Folding commands scroll the cursor
   * into view, which is unwelcome when the user is looking at another part of the file.
   *
   * @param {vscode.TextEditor} editor
   * @param {() => Thenable<unknown>} run
   */
  async function keepingScroll(editor, run) {
    const cursorInView = editor.visibleRanges.some((range) => range.contains(editor.selection.active));
    const middle = middleVisibleLine(editor);
    await run();
    if (!cursorInView && middle !== undefined) {
      // Centring is the one way of revealing a line that adds no margin of its own.
      editor.revealRange(new vscode.Range(middle, 0, middle, 0), vscode.TextEditorRevealType.InCenter);
    }
  }

  // Folding commands act on the active editor only, hence the checks below and the bookkeeping in
  // `collapsed` and `folded` for editors that are not in front right now.

  /**
   * @param {vscode.TextEditor} editor
   * @returns {Promise<boolean>} whether anything was folded
   */
  async function collapse(editor) {
    const { document } = editor;
    // With this strategy VS Code ignores folding providers, ours included.
    if (vscode.workspace.getConfiguration('editor', document).get('foldingStrategy') === 'indentation') return false;
    const { blocks } = await analyze(document);
    if (blocks.length === 0 || editor !== vscode.window.activeTextEditor) return false;
    // Folds by range kind, so it can only ever fold comments, whatever state the ranges are in.
    await keepingScroll(editor, () => vscode.commands.executeCommand('editor.foldAllBlockComments'));
    return true;
  }

  /**
   * @param {vscode.TextEditor} editor
   * @returns {Promise<boolean>} false if the editor left the foreground before it could be done
   */
  async function expand(editor) {
    const { blocks } = await analyze(editor.document);
    if (editor !== vscode.window.activeTextEditor) return false;
    if (blocks.length > 0) {
      // `editor.unfold` opens the innermost region around each line. That is the comment block as
      // long as our ranges are still being reported, which `folded` sees to.
      const selectionLines = blocks.map((block) => block.start);
      await keepingScroll(editor, () => vscode.commands.executeCommand('editor.unfold', { selectionLines }));
    }
    return true;
  }

  /**
   * Brings the folding of the active editor in line with `collapsing`.
   *
   * @param {vscode.TextEditor} editor
   */
  async function syncFolding(editor) {
    const key = editor.document.uri.toString();
    if (collapsing) {
      if (collapsed.has(key)) return;
      collapsed.add(key);
      if (await collapse(editor)) folded.add(key);
    } else if (folded.has(key) && (await expand(editor))) {
      folded.delete(key);
      foldingChanged.fire();
    } else {
      return;
    }
    context.workspaceState.update(FOLDED_KEY, [...folded]);
  }

  async function syncCollapsing() {
    const wanted = hidden && vscode.workspace.getConfiguration('hideComments').get('collapseBlocks', true);
    if (wanted !== collapsing) {
      collapsing = wanted;
      collapsed.clear();
      foldingChanged.fire();
    }
    const editor = vscode.window.activeTextEditor;
    if (editor) await syncFolding(editor);
  }

  function showState() {
    vscode.commands.executeCommand('setContext', 'hideComments.hidden', hidden);
    statusBar.text = hidden ? '$(eye-closed) Comments' : '$(eye) Comments';
    statusBar.tooltip = hidden ? 'Comments are hidden. Click to show them.' : 'Click to hide comments';
    statusBar.backgroundColor = hidden ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
  }

  /** @param {boolean} value */
  async function setHidden(value) {
    if (hidden === value) return;
    hidden = value;
    context.workspaceState.update(HIDDEN_KEY, hidden);
    showState();
    refresh();
    await syncCollapsing();
  }

  context.subscriptions.push(
    hiddenStyle,
    statusBar,
    foldingChanged,
    { dispose: () => clearTimeout(refreshTimer) },
    vscode.commands.registerCommand('hideComments.toggle', () => setHidden(!hidden)),
    vscode.commands.registerCommand('hideComments.hide', () => setHidden(true)),
    vscode.commands.registerCommand('hideComments.show', () => setHidden(false)),
    vscode.languages.registerFoldingRangeProvider('*', foldingProvider),
    vscode.window.onDidChangeVisibleTextEditors(refresh),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      refresh();
      if (editor) syncFolding(editor);
    }),
    vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
      // While the document is being edited, the pending refresh picks up the new selection too.
      if (hidden && isAnalysisCurrent(textEditor.document)) decorate(textEditor);
    }),
    vscode.workspace.onDidChangeTextDocument(() => {
      if (hidden) refreshSoon();
    }),
    // Also fires when a document's language is changed.
    vscode.workspace.onDidOpenTextDocument(() => {
      if (hidden) refreshSoon();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('hideComments.collapseBlocks')) syncCollapsing();
    }),
    vscode.extensions.onDidChange(() => {
      forgetRules();
      analyses = new WeakMap();
      if (hidden) refreshSoon();
    }),
  );

  showState();
  statusBar.show();
  refresh();
  syncCollapsing();
}

module.exports = { activate };
