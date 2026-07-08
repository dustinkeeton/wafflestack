#!/usr/bin/env node
//
// evals.mjs — the metered, LLM-driven eval runner (Layer 2 of #89, harness from #109).
//
// This is a SEPARATE entry point from `npm test` on purpose: it calls a real model,
// so it costs money. It is exposed as `npm run evals` and is never part of the default
// per-PR test gate. Every run is bounded by an explicit, enforced call budget.
//
// Usage:
//   node installer/evals.mjs --max-calls <N> [--stack NAME] [--case SUBSTR]
//                            [--model ID] [--json] [--show-transcript]
//   node installer/evals.mjs --dry-run [--stack NAME] [--case SUBSTR]   (no API key, no cost)
//
// Auth: reads ANTHROPIC_API_KEY from the environment for live runs.
// Budget: --max-calls is REQUIRED for a live run (the explicit, visible cost cap);
//         the runner refuses to start a model call once the cap is reached.
//
// Exit 0 when every selected case passes; exit 1 on any failure, skip, or error.

import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  discoverCases,
  runEvals,
  Budget,
  anthropicClient,
  mockClient,
  DEFAULT_MODEL,
} from './lib/evals.mjs';

const toolkitRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

function parseArgs(argv) {
  const opts = { dryRun: false, json: false, showTranscript: false, stack: null, filter: null, maxCalls: null, model: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--show-transcript') opts.showTranscript = true;
    else if (a === '--stack') opts.stack = argv[++i];
    else if (a === '--case') opts.filter = argv[++i];
    else if (a === '--max-calls') opts.maxCalls = Number(argv[++i]);
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--help' || a === '-h') opts.help = true;
    else fail(`unknown argument: ${a}\n\n${USAGE}`);
  }
  return opts;
}

const USAGE = [
  'usage: node installer/evals.mjs --max-calls <N> [--stack NAME] [--case SUBSTR] [--model ID] [--json] [--show-transcript]',
  '       node installer/evals.mjs --dry-run [--stack NAME] [--case SUBSTR]',
  '',
  'The metered LLM eval tier. Cases live in stacks/<stack>/evals/*.eval.yaml.',
  '--max-calls is a required, enforced cap on model calls for a live run (bounds cost).',
  '--dry-run runs the whole harness with a mock model — no API key, no cost.',
].join('\n');

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  const cases = discoverCases(toolkitRoot, { onlyStack: opts.stack }).filter(
    (c) => !opts.filter || c.name.includes(opts.filter) || c.file.includes(opts.filter),
  );
  if (!cases.length) {
    console.error(opts.stack ? `no eval cases found for stack "${opts.stack}"` : 'no eval cases found under stacks/*/evals/');
    process.exit(1);
  }

  const model = opts.model ?? DEFAULT_MODEL;
  let runOpts;
  let budget;

  if (opts.dryRun) {
    budget = new Budget(null); // dry-run: no cost, no cap
    // Each case gets its own mock so a case's `dryRunResponse` drives its scenario text.
    runOpts = { toolkitRoot, budget, model, makeCallModel: (c) => mockClient({ scenarioText: c.dryRunResponse }) };
  } else {
    if (!Number.isFinite(opts.maxCalls) || opts.maxCalls <= 0) {
      fail(
        '--max-calls <N> is required for a live run — it is the explicit, enforced cost cap.\n' +
          'Each case spends 1 call for the scenario plus 1 per `judge` assertion.\n' +
          'Use --dry-run to exercise the harness with no API key and no cost.',
      );
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    let callModel;
    try {
      callModel = anthropicClient({ apiKey, defaultModel: model });
    } catch (err) {
      fail(err.message);
    }
    budget = new Budget(opts.maxCalls);
    runOpts = { toolkitRoot, budget, model, callModel };
  }

  console.error(
    `running ${cases.length} eval case${cases.length === 1 ? '' : 's'}` +
      (opts.dryRun ? ' (dry-run: mock model, no cost)' : ` with model ${model}, budget ${opts.maxCalls} calls`),
  );

  const summary = await runEvals(cases, {
    ...runOpts,
    onResult: (r) => {
      if (!opts.json) console.error(formatResultLine(r, opts.showTranscript));
    },
  });

  if (opts.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    printSummary(summary);
  }
  process.exit(summary.ok ? 0 : 1);
}

function formatResultLine(r, showTranscript) {
  if (r.error) return `  ERROR ${r.stack}/${r.name}: ${r.error}`;
  const mark = r.pass ? 'PASS' : 'FAIL';
  const lines = [`  ${mark} ${r.stack}/${r.name}`];
  for (const a of r.assertions) {
    if (!a.pass || showTranscript) lines.push(`        ${a.pass ? '✓' : '✗'} ${a.type}: ${a.detail}`);
  }
  if (showTranscript && r.transcript != null) {
    lines.push('        --- transcript ---');
    for (const l of String(r.transcript).split('\n')) lines.push(`        | ${l}`);
  }
  return lines.join('\n');
}

function printSummary(summary) {
  const u = summary.usage;
  console.error('');
  console.error(
    `evals: ${summary.passed} passed, ${summary.failed} failed` +
      (summary.skippedCount ? `, ${summary.skippedCount} skipped (budget)` : '') +
      ` of ${summary.total}`,
  );
  console.error(
    `cost: ${u.calls} model call${u.calls === 1 ? '' : 's'}` +
      (u.maxCalls != null ? ` / ${u.maxCalls} budget` : '') +
      `, ${u.inputTokens} in + ${u.outputTokens} out tokens`,
  );
  if (summary.budgetHit) {
    console.error('note: budget exhausted — some cases were skipped. Raise --max-calls to run them.');
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => fail(err.stack || err.message));
