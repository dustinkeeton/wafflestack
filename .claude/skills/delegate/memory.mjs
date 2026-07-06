#!/usr/bin/env node
//
// memory.mjs — validate a delegate run-memory doc against its size cap and entry format.
//
// A delegate run has no durable memory across runs beyond GitHub artifacts and whatever
// survives the orchestrator's context window. The run-memory doc is the fix: ONE curated,
// capped Markdown file per repo of durable, forward-useful facts (repo quirks, recurring
// failures, issue entanglements). The Report phase distils lessons into it — replacing and
// pruning stale entries, never blind-appending — and the Classify / Plan phases read it back.
//
// The whole point is that it stays SMALL: an append-only log bloats until it poisons context
// instead of helping it. So the doc carries a hard byte cap, and this script is the
// deterministic gate that enforces it — the same pattern checkpoint.mjs establishes for phase
// state. Exceeding the cap fails here, loudly, forcing curation before the run may complete;
// it never silently truncates.
//
// It also enforces the entry FORMAT, so pruning is judged rather than FIFO: every entry must
// carry a **Why** (why it is forward-useful), a **Since** (the issue/PR that taught it — its
// staleness anchor), and an **Area** (the module tag that lets Execute hand each agent only
// the entries relevant to its issue). An entry missing any of these fails.
//
// Dependency-free on purpose: it runs inside a consuming repo that may not have any npm deps
// installed, so it uses Node built-ins only.
//
// Usage:
//   node memory.mjs --file <path> [--max-bytes <N>]
//
// A missing file is VALID — a repo with no delegate history yet simply has no memory doc, and
// the first run creates one. Exit 0 = within cap and every entry well-formed. Exit 1 = over
// cap, a malformed entry, or a bad argument — the caller must curate and re-validate, never
// improvise past it.

import fs from 'node:fs';

const DEFAULT_MAX_BYTES = 4096;

// Required labelled fields on every entry. The heading (## …) is the fact/lesson itself.
const REQUIRED_FIELDS = ['Why', 'Since', 'Area'];

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--max-bytes') out.maxBytes = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else return { error: `unknown argument: ${a}` };
  }
  return out;
}

const USAGE = 'Usage: node memory.mjs --file <memory.md> [--max-bytes <N>]';

// ---------------------------------------------------------------------------
// Parse the doc into entries. An entry is an H2 (`## …`) heading — the fact/lesson —
// followed by its labelled `- **Field:** value` lines, up to the next H2 or EOF.
// The H1 title and any preamble prose before the first H2 are not entries (they still
// count toward the byte cap — the cap is on the whole file, which is what loads into context).
// ---------------------------------------------------------------------------

function parseEntries(content) {
  const lines = content.split(/\r?\n/);
  const entries = [];
  let cur = null;
  lines.forEach((line, idx) => {
    const heading = /^##(?!#)\s+(.+?)\s*$/.exec(line); // exactly H2, not H3+
    if (heading) {
      if (cur) entries.push(cur);
      cur = { title: heading[1], line: idx + 1, fields: {} };
    } else if (cur) {
      const field = /^\s*[-*]\s*\*\*([A-Za-z]+):\*\*\s*(.*)$/.exec(line);
      if (field) {
        const name = field[1];
        // First occurrence wins; a duplicate label doesn't clobber the real value.
        if (!(name in cur.fields)) cur.fields[name] = field[2].trim();
      }
    }
  });
  if (cur) entries.push(cur);
  return entries;
}

function validateEntries(entries, errors) {
  for (const e of entries) {
    const where = `entry "${e.title}" (line ${e.line})`;
    for (const f of REQUIRED_FIELDS) {
      const v = e.fields[f];
      if (v === undefined) {
        errors.push(`${where}: missing required field **${f}:**`);
      } else if (v === '') {
        errors.push(`${where}: field **${f}:** is empty`);
      }
    }
    // Since is the staleness anchor — it must point at the issue/PR that taught the lesson,
    // so pruning can be judged ("was #42's area reworked?") instead of FIFO. Require a #N ref.
    if (e.fields.Since && !/#\d+/.test(e.fields.Since)) {
      errors.push(`${where}: **Since:** must reference the issue/PR that taught it (e.g. "#42") — got "${e.fields.Since}"`);
    }
  }
}

// ---------------------------------------------------------------------------

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.error) {
    console.error(`memory: ${args.error}\n${USAGE}`);
    process.exit(1);
  }
  if (!args.file) {
    console.error(`memory: --file is required\n${USAGE}`);
    process.exit(1);
  }

  let maxBytes = DEFAULT_MAX_BYTES;
  if (args.maxBytes !== undefined) {
    maxBytes = Number(args.maxBytes);
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
      console.error(`memory: --max-bytes must be a positive integer (got "${args.maxBytes}")`);
      process.exit(1);
    }
  }

  // A missing file is the fresh-repo case: nothing learned yet, nothing to enforce.
  if (!fs.existsSync(args.file)) {
    console.log(`memory: ${args.file} does not exist yet — no run memory recorded (valid; 0/${maxBytes} bytes)`);
    process.exit(0);
  }

  let content;
  try {
    content = fs.readFileSync(args.file, 'utf8');
  } catch (err) {
    console.error(`memory: cannot read ${args.file}: ${err.message}`);
    process.exit(1);
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  const errors = [];

  if (bytes > maxBytes) {
    errors.push(
      `over the size cap: ${bytes} bytes exceeds the ${maxBytes}-byte limit by ${bytes - maxBytes}. ` +
        `Curate — prune the stalest entries and tighten wording — until it fits. Do NOT raise the cap to dodge curation.`,
    );
  }

  const entries = parseEntries(content);
  validateEntries(entries, errors);

  if (errors.length) {
    console.error(`memory: ${args.file} is INVALID (${errors.length} problem(s)):`);
    for (const e of errors) console.error(`  - ${e}`);
    console.error('STOP: the run may not complete until the memory doc is curated back within the cap and every entry is well-formed.');
    process.exit(1);
  }

  console.log(`memory: ${args.file} is valid — ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}, ${bytes}/${maxBytes} bytes`);
  process.exit(0);
}

main();
