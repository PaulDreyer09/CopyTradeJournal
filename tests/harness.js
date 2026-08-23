// Loads the real inline <script> out of trade-journal.html into a sandboxed
// context and hands back its pure, DOM-free functions (parseCopierTrades,
// computeProviderStats, dedupeByTradeId, ...) so tests exercise the actual
// app code — never a re-implementation that could drift from it.
//
// The app is a single HTML file with no build step (see CLAUDE.md), so this
// harness has no dependencies either: just Node's built-in `fs`/`path`/`vm`.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const APP_PATH = path.join(__dirname, '..', 'trade-journal.html');

// A handful of top-level statements run at load time (the final `showPage('landing')`
// call, which cascades into hideReportArea()) and touch document.getElementById(...).style
// and similar. None of that affects the pure parsing/stats functions we care about — this
// stub just needs to not throw while the script loads.
function makeFakeElement() {
  const el = {
    style: {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() {} },
    dataset: {},
    children: [],
    disabled: false,
    checked: false,
    value: '',
    querySelector: () => makeFakeElement(),
    querySelectorAll: () => [],
    addEventListener: () => {},
  };
  return el;
}

// Every function we need to hand back to tests.
const EXPORTED_NAMES = [
  'parseCopierTrades', 'computeProviderStats', 'parsePnlLine',
  'parseTrades', 'dedupeByTradeId', 'normalizeNumberStr', 'normalizeCurrency', 'currencyLabel',
];

function loadAppSandbox() {
  const html = fs.readFileSync(APP_PATH, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error('Could not find the inline <script> block in trade-journal.html');

  const fakeDocument = {
    getElementById: () => makeFakeElement(),
    querySelector: () => makeFakeElement(),
    querySelectorAll: () => [],
  };

  // Run in the *main* realm (vm.runInThisContext), not a separate
  // vm.createContext realm — a separate realm gives back Arrays/Objects that
  // aren't `instanceof` this file's Array/Object, which breaks
  // assert.deepStrictEqual on otherwise-identical values. Top-level
  // `function` declarations in the script attach to the real `global`, so we
  // stash the ones we need and restore whatever `document`/`window`/`XLSX`
  // were before we're done.
  const prev = { document: global.document, window: global.window, XLSX: global.XLSX };
  global.document = fakeDocument;
  global.window = global.window || {};
  global.XLSX = global.XLSX || {};

  try {
    vm.runInThisContext(match[1], { filename: 'trade-journal.html (inline script)' });
    const sandbox = {};
    for (const name of EXPORTED_NAMES) sandbox[name] = global[name];
    return sandbox;
  } finally {
    global.document = prev.document;
    global.window = prev.window;
    global.XLSX = prev.XLSX;
  }
}

module.exports = { loadAppSandbox };
