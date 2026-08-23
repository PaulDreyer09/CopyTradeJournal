// Unit tests for the Copier Report parser (parseCopierTrades) and its
// provider aggregation (computeProviderStats) in trade-journal.html.
//
// Zero dependencies — this project has no build step or package manager
// (see CLAUDE.md), so this uses only Node's built-in `assert` and a tiny
// test-registration loop. Run with:
//
//   node tests/test-copier-parser.js
//
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { loadAppSandbox } = require('./harness');

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

// ── Basic single entry ──────────────────────────────────────────
test('parses a single well-formed 4-line entry', (s) => {
  const raw = [
    '🏆CopyADK Gold 10k Challenge',
    'USD 0.07',
    'Buy0.01 XAUUSD @ 4329.71',
    '14/08/2026 06:31:25 | 90623945',
  ].join('\n');

  const { trades, errors, currencies } = s.parseCopierTrades(raw);

  assert.strictEqual(errors.length, 0);
  assert.deepStrictEqual(currencies, ['$']);
  assert.strictEqual(trades.length, 1);

  const t = trades[0];
  assert.strictEqual(t.provider, '🏆CopyADK Gold 10k Challenge');
  assert.strictEqual(t.direction, 'Buy');
  assert.strictEqual(t.volume, 0.01);
  assert.strictEqual(t.symbol, 'XAUUSD');
  assert.strictEqual(t.price, 4329.71);
  assert.strictEqual(t.pnl, 0.07);
  assert.strictEqual(t.currency, '$');
  assert.strictEqual(t.dateStr, '14/08/2026');
  assert.strictEqual(t.timeStr, '06:31:25');
  assert.strictEqual(t.tradeId, '90623945');
  assert.ok(t.dt instanceof Date && !isNaN(t.dt));
});

// ── Sign handling ────────────────────────────────────────────────
test('parses a negative P&L (currency then minus, no separators between entries)', (s) => {
  const raw = [
    'Abdullokh UZB',
    'USD -6.92',
    'Buy0.03 XAUUSD @ 4325.88',
    '14/08/2026 03:42:35 | 90581255',
  ].join('\n');

  const { trades, errors } = s.parseCopierTrades(raw);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].pnl, -6.92);
});

test('parses a negative P&L expressed with a leading minus before the currency', (s) => {
  const raw = [
    'SomeProvider',
    '-USD1.50',
    'Sell0.01 EURUSD @ 1.1',
    '14/08/2026 06:00:00 | 555',
  ].join('\n');

  const { trades, errors } = s.parseCopierTrades(raw);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].pnl, -1.5);
});

// ── Placeholder P&L lines ("USD --.--") ────────────────
// Some platforms print a not-yet-settled trade's P&L as a placeholder of
// dashes and a decimal point instead of an actual number. parsePnlLine treats
// that as a real $0.00 P&L (not a parse failure) — see the CLAUDE.md-adjacent
// comment on RE_PNL_PLACEHOLDER in trade-journal.html for why.
test('parsePnlLine treats a dashes-only placeholder as an actual $0.00, not a parse failure', (s) => {
  assert.deepStrictEqual(s.parsePnlLine('USD --.--'), { currency: '$', pnl: 0 });
  assert.deepStrictEqual(s.parsePnlLine('USD -'), { currency: '$', pnl: 0 });
  assert.deepStrictEqual(s.parsePnlLine('USD ---'), { currency: '$', pnl: 0 });
  assert.deepStrictEqual(s.parsePnlLine('USD 0.07'), { currency: '$', pnl: 0.07 });
  assert.deepStrictEqual(s.parsePnlLine('USD -6.92'), { currency: '$', pnl: -6.92 });
  assert.strictEqual(s.parsePnlLine('not a pnl line'), null);
});

// parsePnlLine is shared by parseTrades (the Copy Simulation page's 3-line
// action/P&L/date format) and parseCopierTrades — confirm the placeholder fix
// reaches that consumer too, not just the copier parser this file is named for.
test('parseTrades (Copy Simulation format) also treats "USD --.--" as pnl 0', (s) => {
  const raw = [
    'Sell0.01 XAUUSD @ 4332.58',
    'USD --.--',
    '14/08/2026 06:00:48 | 90620314',
  ].join('\n');

  const { trades, errors } = s.parseTrades(raw);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(trades[0].pnl, 0);
  assert.strictEqual(trades[0].tradeId, '90620314');
});

test('parses a trade whose P&L line is a placeholder ("USD --.--") as pnl 0, without disturbing neighboring trades', (s) => {
  const raw = [
    '🥇BaazFx Apex🥇(t.me/BaazFx)',
    'USD 0.05',
    'Sell0.01 XAUUSD @ 4332.58',
    '14/08/2026 06:00:48 | 90620330',
    '🥇BaazFx Apex🥇(t.me/BaazFx)',
    'USD --.--',
    'Sell0.01 XAUUSD @ 4332.58',
    '14/08/2026 06:00:48 | 90620314',
    '🥇BaazFx Apex🥇(t.me/BaazFx)',
    'USD 0.08',
    'Sell0.01 XAUUSD @ 4332.55',
    '14/08/2026 06:00:48 | 90620601',
  ].join('\n');

  const { trades, errors } = s.parseCopierTrades(raw);

  // No warning — the placeholder line is a legitimate $0.00 trade now, not a
  // parse failure. All three trades (before, placeholder, after) come through.
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(trades.length, 3);
  assert.deepStrictEqual(trades.map(t => t.tradeId), ['90620330', '90620314', '90620601']);
  assert.strictEqual(trades.find(t => t.tradeId === '90620314').pnl, 0);
});

// ── Duplicate trade IDs ───────────────────────────────────────────
test('dedupes repeated trade IDs and reports how many were removed', (s) => {
  const block = [
    'ProviderA',
    'USD 1.00',
    'Buy0.01 XAUUSD @ 100',
    '14/08/2026 06:00:00 | 111',
  ].join('\n');
  const raw = [block, block].join('\n'); // same block pasted twice

  const { trades, errors } = s.parseCopierTrades(raw);
  assert.strictEqual(trades.length, 1);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /Removed 1 duplicate trade/);
});

// ── Currency mismatch ──────────────────────────────────────────────
test('flags a currency mismatch across providers without discarding the parsed trades', (s) => {
  const raw = [
    'ProviderA', 'USD 1.00', 'Buy0.01 XAUUSD @ 100', '14/08/2026 06:00:00 | 111',
    'ProviderB', 'EUR 2.00', 'Sell0.02 EURUSD @ 1.1', '14/08/2026 06:05:00 | 222',
  ].join('\n');

  const { trades, errors, currencies } = s.parseCopierTrades(raw);
  assert.strictEqual(trades.length, 2);
  assert.deepStrictEqual(currencies.sort(), ['$', '€'].sort());
  assert.ok(errors.some(e => e.startsWith('CURRENCY MISMATCH')));
});

// ── Malformed / truncated input ────────────────────────────────────
test('reports an error instead of throwing when a trade line has no provider/P&L lines before it', (s) => {
  const { trades, errors } = s.parseCopierTrades('Buy0.01 XAUUSD @ 100');
  assert.strictEqual(trades.length, 0);
  assert.strictEqual(errors.length, 1);
  assert.match(errors[0], /provider\/P&L\/date lines are missing/);
});

test('returns empty results for empty input without throwing', (s) => {
  const { trades, errors, currencies } = s.parseCopierTrades('');
  assert.deepStrictEqual(trades, []);
  assert.deepStrictEqual(errors, []);
  assert.deepStrictEqual(currencies, []);
});

test('returns empty results for unrelated text with no recognisable trade lines', (s) => {
  const { trades, errors } = s.parseCopierTrades('just some notes\nnothing trade-shaped here');
  assert.deepStrictEqual(trades, []);
  assert.deepStrictEqual(errors, []);
});

// ── Multiple providers, no blank-line separators ────────────────────
test('groups interleaved, back-to-back entries by provider with no blank lines between them', (s) => {
  const raw = [
    'Alpha', 'USD 1.00', 'Buy0.01 XAUUSD @ 100', '14/08/2026 06:00:00 | 1',
    'Beta',  'USD 2.00', 'Sell0.02 EURUSD @ 1.1', '14/08/2026 06:01:00 | 2',
    'Alpha', 'USD -0.50', 'Buy0.01 XAUUSD @ 101', '14/08/2026 06:02:00 | 3',
  ].join('\n');

  const { trades, errors } = s.parseCopierTrades(raw);
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(trades.length, 3);
  assert.deepStrictEqual(trades.map(t => t.provider), ['Alpha', 'Beta', 'Alpha']);

  const stats = s.computeProviderStats(trades);
  const alpha = stats.find(p => p.provider === 'Alpha');
  const beta = stats.find(p => p.provider === 'Beta');
  assert.strictEqual(alpha.count, 2);
  assert.strictEqual(alpha.wins, 1);
  assert.strictEqual(alpha.losses, 1);
  assert.strictEqual(Math.round(alpha.totalPnl * 100) / 100, 0.5);
  assert.strictEqual(beta.count, 1);
  assert.strictEqual(beta.totalPnl, 2);
});

// ── computeProviderStats sorting ─────────────────────────────────────
test('computeProviderStats ranks providers by total P&L, best first', (s) => {
  const raw = [
    'Loser',  'USD -5.00', 'Buy0.01 XAUUSD @ 100', '14/08/2026 06:00:00 | 1',
    'Winner', 'USD 10.00', 'Buy0.01 XAUUSD @ 100', '14/08/2026 06:01:00 | 2',
    'Middle', 'USD 1.00',  'Buy0.01 XAUUSD @ 100', '14/08/2026 06:02:00 | 3',
  ].join('\n');

  const { trades } = s.parseCopierTrades(raw);
  const stats = s.computeProviderStats(trades);
  assert.deepStrictEqual(stats.map(p => p.provider), ['Winner', 'Middle', 'Loser']);
});

// ── Real-world fixture (the example from the feature request) ────────
test('parses the full real-world multi-provider fixture without throwing', (s) => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'copier-sample.txt'), 'utf8');
  const { trades, errors, currencies } = s.parseCopierTrades(raw);

  assert.deepStrictEqual(currencies, ['$'], 'the fixture is single-currency (USD) — no mismatch expected');
  // 185 = 174 trades with a real amount + 11 "USD --.--" placeholder lines,
  // which now parse as legitimate $0.00 trades rather than being skipped.
  assert.strictEqual(trades.length, 185, 'every line in the fixture parses, including the 11 placeholder P&Ls');
  assert.strictEqual(errors.length, 0, 'no warnings expected — placeholders are no longer parse failures');
  assert.strictEqual(trades.filter(t => t.pnl === 0).length, 11, 'the 11 placeholder lines became $0.00 trades');

  // No duplicate trade IDs slipped through.
  const ids = trades.map(t => t.tradeId);
  assert.strictEqual(new Set(ids).size, ids.length);
});

test('real-world fixture: spot-checks specific known trades', (s) => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'copier-sample.txt'), 'utf8');
  const { trades } = s.parseCopierTrades(raw);
  const byId = Object.fromEntries(trades.map(t => [t.tradeId, t]));

  const first = byId['90623945'];
  assert.ok(first, 'first entry in the fixture should be present');
  assert.strictEqual(first.provider, '🏆CopyADK Gold 10k Challenge');
  assert.strictEqual(first.direction, 'Buy');
  assert.strictEqual(first.symbol, 'XAUUSD');
  assert.strictEqual(first.price, 4329.71);
  assert.strictEqual(first.pnl, 0.07);

  const negative = byId['90581255'];
  assert.ok(negative, 'a known negative-P&L trade should be present');
  assert.strictEqual(negative.provider, 'Abdullokh UZB');
  assert.strictEqual(negative.pnl, -6.92);

  // The three trades around the fixture's first "USD --.--" line — the
  // placeholder itself (90620314) now comes through too, as pnl 0, and its
  // neighbors (90620330, 90620601) are still parsed correctly around it.
  assert.ok(byId['90620330']);
  assert.ok(byId['90620601']);
  assert.ok(byId['90620314'], 'the placeholder-P&L trade should now be present');
  assert.strictEqual(byId['90620314'].pnl, 0);
});

test('real-world fixture: every individual trade matches its raw source lines (all 185, not just a sample)', (s) => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'copier-sample.txt'), 'utf8');
  const lines = raw.split('\n').map(l => l.trim()).filter(l => l.length > 0);
  const { trades } = s.parseCopierTrades(raw);
  const byId = Object.fromEntries(trades.map(t => [t.tradeId, t]));

  // Independently (and much more simply than the real parser) re-derive the
  // expected block for every trade ID by anchoring on its datetime line and
  // reading the three lines immediately before it — this fixture never
  // separates entries with blank lines, so provider/P&L/action/date always
  // sit in exactly that order relative to one another.
  const DATETIME_RE = /^(\d{2}\/\d{2}\/\d{4})\s+(\d{2}:\d{2}:\d{2})\s*\|\s*(\d+)$/;
  const ACTION_RE = /^(Buy|Sell)([\d.]+)\s+(\S+)\s+@\s+([\d.]+)$/;
  const PNL_RE = /^USD\s+(-?[\d.]+)$/;         // an actual numeric amount
  const PNL_PLACEHOLDER_RE = /^USD\s+-[-.]*$/; // "USD --.--" and friends

  let checked = 0;
  for (let i = 0; i < lines.length; i++) {
    const dm = lines[i].match(DATETIME_RE);
    if (!dm) continue;
    const am = lines[i - 1] && lines[i - 1].match(ACTION_RE);
    if (!am) continue; // not a trade-shaped block at all

    const tradeId = dm[3];
    const providerLine = lines[i - 3];
    const pnlLine = lines[i - 2];
    const pm = pnlLine.match(PNL_RE);
    const isPlaceholder = !pm && PNL_PLACEHOLDER_RE.test(pnlLine);
    if (!pm && !isPlaceholder) continue; // not a recognisable P&L line either

    const parsed = byId[tradeId];
    assert.ok(parsed, `trade ${tradeId} should have been parsed`);
    assert.strictEqual(parsed.provider, providerLine, `trade ${tradeId} provider`);
    assert.strictEqual(parsed.direction, am[1], `trade ${tradeId} direction`);
    assert.strictEqual(parsed.volume, parseFloat(am[2]), `trade ${tradeId} volume`);
    assert.strictEqual(parsed.symbol, am[3], `trade ${tradeId} symbol`);
    assert.strictEqual(parsed.price, parseFloat(am[4]), `trade ${tradeId} price`);
    assert.strictEqual(parsed.pnl, isPlaceholder ? 0 : parseFloat(pm[1]), `trade ${tradeId} pnl`);
    assert.strictEqual(parsed.dateStr, dm[1], `trade ${tradeId} dateStr`);
    assert.strictEqual(parsed.timeStr, dm[2], `trade ${tradeId} timeStr`);
    checked++;
  }

  assert.strictEqual(checked, 185, 'expected to individually verify every trade in the fixture');
  assert.strictEqual(trades.length, checked);
});

test('real-world fixture: provider aggregation matches expected performance table', (s) => {
  const raw = fs.readFileSync(path.join(__dirname, 'fixtures', 'copier-sample.txt'), 'utf8');
  const { trades } = s.parseCopierTrades(raw);
  const stats = s.computeProviderStats(trades);

  // Counts now include the placeholder ($0.00) trades — wins/losses/totalPnl
  // are unaffected since a $0.00 trade is neither a win nor a loss.
  const expected = {
    '🏆CopyADK Gold 10k Challenge':      { count: 36,  wins: 27, losses: 8,  totalPnl: 2.72 },
    '🥇BaazFx Apex🥇(t.me/BaazFx)':      { count: 36,  wins: 23, losses: 8,  totalPnl: 1.36 },
    '小悟好运连连🍭🍭🍭':                  { count: 1,   wins: 1,  losses: 0,  totalPnl: 0.72 },
    'Rainy Strategies':                  { count: 9,   wins: 5,  losses: 4,  totalPnl: 0.37 },
    'GOLD PRECISION SCALPER':            { count: 1,   wins: 1,  losses: 0,  totalPnl: 0.19 },
    'ImpulseNet':                        { count: 1,   wins: 1,  losses: 0,  totalPnl: 0.15 },
    'Abdullokh UZB':                     { count: 101, wins: 43, losses: 53, totalPnl: -324.67 },
  };

  assert.strictEqual(stats.length, Object.keys(expected).length);
  for (const s2 of stats) {
    const exp = expected[s2.provider];
    assert.ok(exp, `unexpected provider in stats: ${s2.provider}`);
    assert.strictEqual(s2.count, exp.count, `${s2.provider} count`);
    assert.strictEqual(s2.wins, exp.wins, `${s2.provider} wins`);
    assert.strictEqual(s2.losses, exp.losses, `${s2.provider} losses`);
    assert.strictEqual(Math.round(s2.totalPnl * 100) / 100, exp.totalPnl, `${s2.provider} totalPnl`);
  }

  // Sum of every provider's total must equal the sum of all individual trades —
  // the "Overall Report" button relies on this: it just concatenates every
  // provider's trades, so nothing should be lost or double-counted along the way.
  const sumOfProviderTotals = stats.reduce((sum, p) => sum + p.totalPnl, 0);
  const sumOfAllTrades = trades.reduce((sum, t) => sum + t.pnl, 0);
  assert.strictEqual(Math.round(sumOfProviderTotals * 100) / 100, Math.round(sumOfAllTrades * 100) / 100);
});

// ── Run ────────────────────────────────────────────────────────────
function main() {
  const sandbox = loadAppSandbox();
  let pass = 0, fail = 0;

  for (const { name, fn } of tests) {
    try {
      fn(sandbox);
      console.log(`  ok - ${name}`);
      pass++;
    } catch (err) {
      console.log(`  FAIL - ${name}`);
      console.log(`    ${err.message}`);
      fail++;
    }
  }

  console.log(`\n${pass} passed, ${fail} failed, ${tests.length} total`);
  process.exit(fail ? 1 : 0);
}

main();
