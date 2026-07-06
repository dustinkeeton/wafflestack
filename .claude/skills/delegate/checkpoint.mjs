#!/usr/bin/env node
//
// checkpoint.mjs — validate a delegate run checkpoint at a phase boundary.
//
// The delegate skill writes one JSON checkpoint per run and, at each phase boundary,
// runs this script to prove the checkpoint holds what the NEXT phase needs before
// reading load-bearing fields (branch, worktree path, issue number) from it. A dropped
// field or a hallucinated branch name fails here — loudly, with an exit code — instead
// of surfacing downstream as a confusing agent failure.
//
// Dependency-free on purpose: it runs inside a consuming repo that may not have any npm
// deps installed, so it uses Node built-ins only and reads the co-located schema file.
//
// Usage:
//   node checkpoint.mjs --file <path> --phase <fetch|classify|plan|execute|report>
//
// Exit 0 = valid for that phase. Exit 1 = invalid (JSON parse error, schema violation,
// or a broken cross-reference) — the caller must STOP the run and report, never improvise.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PHASES = ['fetch', 'classify', 'plan', 'execute', 'report'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--phase') out.phase = argv[++i];
    else if (a === '--schema') out.schema = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

const USAGE =
  'Usage: node checkpoint.mjs --file <checkpoint.json> --phase <fetch|classify|plan|execute|report>';

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator — supports exactly the keyword subset used by
// checkpoint.schema.json: type (incl. arrays and "integer"/"null"), const, enum,
// required, properties, additionalProperties(false), items, minItems, minimum,
// pattern. Anything richer is intentionally out of scope.
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer'; // also reports as "number" below
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | ...
}

function matchesType(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value);
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number';
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return false;
  }
}

function validateNode(value, schema, pathStr, errors) {
  if (!schema || typeof schema !== 'object') return;

  if ('const' in schema && value !== schema.const) {
    errors.push(`${pathStr}: must equal ${JSON.stringify(schema.const)} (got ${JSON.stringify(value)})`);
    return;
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${pathStr}: expected type ${types.join(' | ')} but got ${typeOf(value)}`);
      return; // further keyword checks assume the type held
    }
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${pathStr}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }

  if (typeof value === 'string' && schema.pattern) {
    if (!new RegExp(schema.pattern).test(value)) {
      errors.push(`${pathStr}: ${JSON.stringify(value)} does not match pattern /${schema.pattern}/`);
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${pathStr}: ${value} is below the minimum ${schema.minimum}`);
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pathStr}: needs at least ${schema.minItems} item(s), has ${value.length}`);
    }
    if (schema.items) {
      value.forEach((item, i) => validateNode(item, schema.items, `${pathStr}[${i}]`, errors));
    }
  }

  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${pathStr}: missing required property "${key}"`);
    }
    const props = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${pathStr}: unexpected property "${key}"`);
      }
    }
    for (const [key, subSchema] of Object.entries(props)) {
      if (key in value) validateNode(value[key], subSchema, `${pathStr}.${key}`, errors);
    }
  }
}

// ---------------------------------------------------------------------------
// Referential cross-checks — the part a pure shape validator can't do. These are
// what actually catch a dropped issue, a mis-wired worktree, or a hallucinated
// branch name. Each runs only once the sections it needs are in scope for `phase`.
// ---------------------------------------------------------------------------

function crossChecks(doc, sectionsInScope, errors) {
  const issueNumbers = new Set((doc.issues ?? []).map((i) => i.number));

  if (sectionsInScope.has('classification')) {
    const seen = new Set();
    for (const c of doc.classification ?? []) {
      if (!issueNumbers.has(c.number)) errors.push(`classification: issue #${c.number} is not in the fetched issue set`);
      if (seen.has(c.number)) errors.push(`classification: issue #${c.number} is classified more than once`);
      seen.add(c.number);
    }
    for (const n of issueNumbers) {
      if (!seen.has(n)) errors.push(`classification: issue #${n} was fetched but never classified`);
    }
  }

  if (sectionsInScope.has('plan')) {
    const planned = new Map(); // number -> branch
    for (const g of doc.plan?.groups ?? []) {
      for (const a of g.assignments ?? []) {
        if (!issueNumbers.has(a.number)) errors.push(`plan: group ${g.id} assigns issue #${a.number}, which is not in the fetched issue set`);
        if (planned.has(a.number)) errors.push(`plan: issue #${a.number} is assigned in more than one group`);
        planned.set(a.number, a.branch);
        const hasWorktree = typeof a.worktree === 'string' && a.worktree.length > 0;
        if (g.mode === 'parallel' && !hasWorktree) {
          errors.push(`plan: issue #${a.number} is in parallel group ${g.id} but has no worktree path`);
        }
        if (g.mode === 'serial' && hasWorktree) {
          errors.push(`plan: issue #${a.number} is in serial group ${g.id} but has a worktree path (serial runs in the main checkout)`);
        }
      }
    }
    for (const n of issueNumbers) {
      if (!planned.has(n)) errors.push(`plan: issue #${n} was fetched but has no assignment in the plan`);
    }
    doc.__planned = planned; // stash for the execute cross-check below
  }

  if (sectionsInScope.has('execution')) {
    const planned = doc.__planned ?? new Map();
    const executed = new Set();
    for (const e of doc.execution ?? []) {
      if (!planned.has(e.number)) {
        errors.push(`execution: issue #${e.number} has no assignment in the plan`);
      } else if (e.branch !== planned.get(e.number)) {
        errors.push(
          `execution: issue #${e.number} reports branch "${e.branch}" but the plan assigned "${planned.get(e.number)}" — branch mismatch (possible hallucinated branch)`,
        );
      }
      if (e.status === 'done' && !e.pr) errors.push(`execution: issue #${e.number} is "done" but has no PR recorded`);
      // Approval gate (delegate.approveBeforePush): a rejected push must leave no PR behind —
      // the work stays committed locally and the issue is "skipped", never a merged-looking "done".
      if (e.approval === 'rejected') {
        if (e.status !== 'skipped') errors.push(`execution: issue #${e.number} was rejected at the approval gate but status is "${e.status}" (a rejected push must be "skipped")`);
        if (e.pr) errors.push(`execution: issue #${e.number} was rejected at the approval gate but has a PR recorded (a rejected push is never opened)`);
      }
      if (e.approvedBy !== undefined && e.approval === undefined) {
        errors.push(`execution: issue #${e.number} records approvedBy but no approval decision`);
      }
      executed.add(e.number);
    }
    for (const n of planned.keys()) {
      if (!executed.has(n)) errors.push(`execution: issue #${n} was planned but has no execution result`);
    }
  }

  delete doc.__planned;
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.error) {
    console.error(`checkpoint: ${args.error}\n${USAGE}`);
    process.exit(1);
  }
  if (!args.file || !args.phase) {
    console.error(`checkpoint: --file and --phase are both required\n${USAGE}`);
    process.exit(1);
  }
  if (!PHASES.includes(args.phase)) {
    console.error(`checkpoint: unknown phase "${args.phase}" — expected one of ${PHASES.join(', ')}`);
    process.exit(1);
  }

  const here = path.dirname(fileURLToPath(import.meta.url));
  const schemaPath = args.schema || path.join(here, 'checkpoint.schema.json');

  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
  } catch (err) {
    console.error(`checkpoint: cannot read schema at ${schemaPath}: ${err.message}`);
    process.exit(1);
  }

  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  } catch (err) {
    console.error(`checkpoint: cannot read/parse ${args.file}: ${err.message}`);
    process.exit(1);
  }

  const errors = [];
  validateNode(doc, schema, '$', errors);

  const phaseSections = schema['x-phaseSections']?.[args.phase] ?? [];
  const sectionsInScope = new Set(phaseSections);
  for (const section of phaseSections) {
    if (!(section in doc)) errors.push(`$: phase "${args.phase}" requires section "${section}", which is missing`);
  }

  // Cross-checks only make sense once the shape is sound; a malformed doc would throw.
  if (!errors.length) crossChecks(doc, sectionsInScope, errors);

  if (errors.length) {
    console.error(`checkpoint: ${args.file} is INVALID for phase "${args.phase}" (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('STOP: do not enter the next phase. Fix the checkpoint (or the phase that wrote it) and re-validate.');
    process.exit(1);
  }

  console.log(`checkpoint: ${args.file} is valid for phase "${args.phase}" (sections: ${phaseSections.join(', ')})`);
  process.exit(0);
}

main();
