import { spawnSync } from 'node:child_process';
import { normalizeItemRef } from './refs.mjs';

/**
 * Typed external prerequisites a stack declares (#47/#129) — the environment things a stack
 * leans on that the shadcn-style copy-in install can neither provide nor verify: a CLI tool, a
 * repo secret, a gh auth scope, a trigger label, a repo setting, an external service, or a
 * harness env var. Distinct from the internal-only `requires:` keyword, which maps render-closure
 * edges between waffles (not external dependencies).
 *
 * Each entry names a `kind`, the `name` of the thing needed, a human `description`, a
 * deterministic `check` (a shell command whose exit 0 means satisfied), a `level`, and an
 * optional `items:` list scoping it to specific waffles of the stack (like `requires:`). Only
 * *declared* prerequisites are ever surfaced — no inference.
 */
export const PREREQ_KINDS = ['tool', 'secret', 'scope', 'label', 'setting', 'service', 'env'];
export const PREREQ_LEVELS = ['require', 'recommend'];

/**
 * Kinds cheap and side-effect-free to probe on every `render` — the local, no-network checks
 * the old env-only `checkEnvPrerequisites` warning generalizes from (a `command -v` binary probe,
 * an env-var read). The network/auth kinds (secret, scope, label, setting, service) are verified
 * by the deliberate `doctor` gate instead, so a plain render never shells out to the API.
 */
export const RENDER_PROBE_KINDS = new Set(['tool', 'env']);

/**
 * Normalize a stack manifest's raw `prerequisites:` list into typed entries with defaults.
 * Deliberately tolerant — a malformed entry is normalized to empty fields so `validate` reports
 * it precisely rather than the loader throwing (matching how `requires:`/`optIn:` are loaded
 * loosely and linted in `validate`). `level` defaults to `recommend`, the report-only safe
 * default. `items:` refs are normalized to `kind/name` form so they compare against a
 * selection's refs.
 */
export function normalizePrerequisites(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const e = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : {};
    return {
      kind: e.kind,
      name: e.name !== undefined ? String(e.name) : '',
      description: e.description !== undefined ? String(e.description).trim() : '',
      check: e.check !== undefined ? String(e.check).trim() : '',
      level: e.level ?? 'recommend',
      items: Array.isArray(e.items) ? e.items.map((r) => normalizeItemRef(String(r))) : [],
    };
  });
}

/**
 * Run a prerequisite's `check` shell command. Exit status 0 => satisfied; a non-zero exit, a
 * signal, a timeout, or a spawn failure => unmet. stdio is fully ignored so a check neither
 * pollutes the CLI output nor blocks reading stdin, and a timeout bounds a hung probe. An empty
 * check never runs (reported `ran: false`) — `validate` requires one, so this only guards a
 * hand-constructed entry.
 */
export function runCheck(check, cwd, { timeoutMs = 15000 } = {}) {
  if (!check) return { ran: false, ok: false };
  let res;
  try {
    res = spawnSync(check, { cwd, shell: true, stdio: 'ignore', timeout: timeoutMs });
  } catch {
    return { ran: true, ok: false };
  }
  return { ran: true, ok: res.status === 0 };
}

/**
 * The prerequisites applicable to a computed `selection`, scoped like `requires:`: a stack
 * contributes its prerequisites only when it has a selected item, and an entry with an `items:`
 * list applies only when one of those items is in the selection (no `items:` => stack-wide,
 * matching the legacy env-warning scope). So a partial install is asked only for the
 * prerequisites its own waffles need. Returns a flat list, each entry carrying its `stackName`,
 * in a deterministic order (first-seen stack order, then manifest order).
 */
export function applicablePrerequisites(toolkit, selection) {
  const selectedByStack = new Map();
  const order = [];
  for (const { stackName, kind, item } of selection.items) {
    if (!selectedByStack.has(stackName)) {
      selectedByStack.set(stackName, new Set());
      order.push(stackName);
    }
    selectedByStack.get(stackName).add(`${kind}/${item.name}`);
  }
  const out = [];
  for (const stackName of order) {
    const stack = toolkit.stacks.get(stackName);
    if (!stack) continue;
    const selectedRefs = selectedByStack.get(stackName);
    for (const p of stack.prerequisites ?? []) {
      if (p.items.length && !p.items.some((r) => selectedRefs.has(r))) continue;
      out.push({ ...p, stackName });
    }
  }
  return out;
}

/**
 * Run every applicable prerequisite's `check` and bucket the results by outcome and level.
 * `unmetRequired` are the gate failures — `doctor` exits 1 on any; `unmetRecommended` only
 * report. `kinds`, when given, restricts which kinds are probed (render passes the cheap
 * `RENDER_PROBE_KINDS`; doctor probes all). Returns `{ unmetRequired, unmetRecommended, met }`.
 */
export function evaluatePrerequisites(prereqs, cwd, { kinds = null, timeoutMs } = {}) {
  const unmetRequired = [];
  const unmetRecommended = [];
  const met = [];
  for (const p of prereqs) {
    if (kinds && !kinds.has(p.kind)) continue;
    const { ok } = runCheck(p.check, cwd, { timeoutMs });
    if (ok) {
      met.push(p);
    } else if (p.level === 'require') {
      unmetRequired.push(p);
    } else {
      unmetRecommended.push(p);
    }
  }
  return { unmetRequired, unmetRecommended, met };
}

/** One actionable line describing an (applicable) prerequisite, for CLI + render output. */
export function formatPrereq(p) {
  const verb = p.level === 'require' ? 'requires' : 'recommends';
  const scope = p.items?.length ? ` (needed by ${p.items.join(', ')})` : '';
  const where = p.stackName ? `stack "${p.stackName}" ` : '';
  return `${where}${verb} ${p.kind} ${p.name}: ${p.description}${scope} — check: \`${p.check}\``;
}
