# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

Two standalone, single-file HTML tools. No build step, no package manager, no server, no tests. Everything (HTML, CSS, JS) lives inline in each `.html` file. Open a file directly in a browser to run it.

- `trade-journal.html` — the main app. Parses pasted trade-history text (from a trading platform) into structured trades, filters/sorts them, computes P&L summaries, and supports import/export to Excel via the `xlsx` library loaded from a CDN (`cdnjs.cloudflare.com/.../xlsx.full.min.js`).
- `remove_every_4th_line.html` — a small unrelated text-munging utility (strips every 4th line, swaps lines 1/2 within groups of 3).

## Development

There is no build/lint/test tooling. To work on a file, edit it and open it in a browser (double-click, or a local static server if you need to avoid `file://` restrictions). Verify changes by loading the HTML file and exercising the UI directly — there is no automated test suite.

## Architecture of `trade-journal.html`

Single `<script>` block, no modules, everything as global functions operating on one global array `allTrades`. Key pieces:

- **Parsing (`parseTrades`)**: input textarea text is split into non-empty lines and grouped into fixed chunks of 3 lines per trade:
  1. `Buy0.01 XAUUSD @ 4029.07` — direction+volume, symbol, entry price
  2. `$1.38` (or any other currency symbol) — signed P&L
  3. `30/06/2026 07:21:33 | 4451015068` — date, time, trade ID
  
  Each line is matched with its own regex; failures are collected as per-chunk errors rather than aborting the whole parse. All trades must share one currency — a mismatch blocks rendering entirely (`showEmpty`) rather than just warning.

- **Filtering/sorting (`applyFilters`)**: reads current filter control values (date range, symbol, direction, lot-size comparator) directly from the DOM, filters `allTrades`, sorts by the current `sortKey`/`sortDir` globals, then calls `renderTable` and `renderSummary`. This is the central re-render entrypoint — call it after any state change (filters, sort, simulation settings) rather than re-rendering directly.

- **Simulation feature**: a "what-if" overlay (`getSimResult`, `getSimMode`) that recomputes a hypothetical P&L per trade under one of three copy-trading models — fixed lot size, fixed proportion of the original lot, or balance-ratio-based lot sizing — without mutating the underlying parsed trade data. When active, original values are shown alongside simulated ones (grayed out) in the table and totals.

- **Import/export**: `exportToExcel` builds a sheet from the currently filtered+sorted view (via SheetJS/`xlsx`), including simulation columns if a simulation is active, and includes a summary block appended below the data rows. `importFromExcel` reverses this by locating known header names (case-insensitive) rather than assuming fixed column positions, and re-derives `currentCurrency` from the P&L header text (e.g. `"PnL ($ (USD))"` → `$`).

- **Rendering**: table rows and the per-symbol breakdown table (`renderSummary`) are built via template-string `innerHTML` assembly — no virtual DOM/diffing. `showUI`/`showEmpty` toggle whole sections' visibility rather than conditionally rendering.

When modifying trade parsing or the simulation math, keep in mind every derived value (table cells, summary cards, per-pair breakdown, Excel export) reads from `getPnl`/`getSimResult` per trade rather than a cached total, so changing that function's logic in one place propagates everywhere.
