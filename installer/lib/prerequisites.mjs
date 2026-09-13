import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { normalizeItemRef } from './refs.mjs';

/** The external environment a stack declares it leans on — distinct from `requires:`, which maps render-closure edges. */
export const PREREQ_KINDS = ['tool', 'secret', 'scope', 'label', 'setting', 'service', 'env'];
export const PREREQ_LEVELS = ['require', 'recommend'];

/** The local, no-network kinds cheap enough to probe on every `render`; the rest are left to the `doctor` gate. */
export const RENDER_PROBE_KINDS = new Set(['tool', 'env']);

/** Normalize a raw `prerequisites:` list into typed entries; a malformed entry gets empty fields for `validate` to report. */
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

/** Run a prerequisite's `check`: exit 0 => satisfied; a non-zero exit, signal, timeout, or spawn failure => unmet. */
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

/** The prerequisites a `selection` pulls in, scoped like `requires:`; flat, each carrying its `stackName`, in manifest order. */
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

/** Human-readable identity of an external source: `source@ref`, or `source` for a local path. */
export function describeProvenance(prov) {
  return prov?.ref ? `${prov.source}@${prov.ref}` : prov?.source;
}

/** sha256 over a stack's `prerequisites[].check` strings in manifest order; null when none would run. */
export function checksDigest(stack) {
  const checks = (stack?.prerequisites ?? []).map((p) => p.check ?? '');
  if (!checks.some(Boolean)) return null;
  return createHash('sha256').update(JSON.stringify(checks)).digest('hex');
}

/** A ref that is neither a commit SHA nor a `v1.2.3`-shaped tag is treated as a branch (a moving target). */
export function looksLikeBranchRef(ref) {
  if (!ref) return false;
  return !/^[0-9a-f]{7,40}$/i.test(ref) && !/^v?\d+(\.\d+)*([-+.][0-9A-Za-z.-]+)?$/.test(ref);
}

/**
 * The trust gate on external check commands (#458): one entry per enabled external stack whose
 * `prerequisites[].check` strings would run, with whether the project has acknowledged that exact list.
 */
export function externalCheckGates(toolkit, project) {
  const out = [];
  for (const ext of project.externalStacks ?? []) {
    const stack = toolkit.stacks.get(ext.name);
    if (!stack?.provenance) continue;
    const digest = checksDigest(stack);
    if (!digest) continue;
    const recorded = ext.acknowledgedChecks ?? null;
    out.push({ stackName: ext.name, stack, provenance: stack.provenance, digest, recorded, acknowledged: recorded === digest });
  }
  return out;
}

/** The stack names whose external checks must NOT run yet. */
export function unacknowledgedStacks(gates) {
  return new Set(gates.filter((g) => !g.acknowledged).map((g) => g.stackName));
}

/** The syrup-style trust-boundary listing for one unacknowledged gate: source, ref, every command, and the line to record. */
export function formatCheckGate(gate) {
  const { stackName, stack, provenance, digest, recorded } = gate;
  const checks = stack.prerequisites.filter((p) => p.check);
  const why = recorded
    ? `the recorded \`acknowledgedChecks: ${recorded}\` no longer matches — its check commands CHANGED since they were acknowledged, so review them again`
    : 'they have not been acknowledged';
  const lines = [
    `EXTERNAL prerequisite checks from external source "${stackName}" (${describeProvenance(provenance)}) were NOT run — ` +
      `external stack "${stackName}" awaiting acknowledgement: ${why}. These ${checks.length} command(s) were authored OUTSIDE ` +
      `this repo and would execute as shell commands on this machine and in CI — acknowledge this trust boundary: review each ` +
      `command below and, only if you trust the source, record \`acknowledgedChecks: ${digest}\` on the "${stackName}" entry ` +
      `under \`stacks:\` in .waffle/waffle.yaml (the COMMITTED config — CI cannot answer a prompt), then re-render`,
    ...checks.map((p) => `  - [${p.level}] ${p.kind} ${p.name}: ${p.description} — check: \`${p.check}\``),
  ];
  if (provenance.sourceType === 'git' && looksLikeBranchRef(provenance.ref)) {
    lines.push(
      `  ! ref "${provenance.ref}" looks like a branch, not a tag or commit — these commands can change under the pin ` +
        `(a change re-gates them, since the digest no longer matches); prefer a tag or commit \`ref:\``,
    );
  }
  return lines.join('\n');
}

/**
 * Probe every applicable prerequisite (`kinds` restricts which) into `{ unmetRequired, unmetRecommended, met, notRun }`;
 * a stack in `skipStacks` has its checks skipped, not run, and bucketed under `notRun` (#458).
 */
export function evaluatePrerequisites(prereqs, cwd, { kinds = null, timeoutMs, skipStacks = new Set() } = {}) {
  const unmetRequired = [];
  const unmetRecommended = [];
  const met = [];
  const notRun = [];
  for (const p of prereqs) {
    if (kinds && !kinds.has(p.kind)) continue;
    if (p.stackName && skipStacks.has(p.stackName)) {
      notRun.push(p);
      continue;
    }
    const { ok } = runCheck(p.check, cwd, { timeoutMs });
    if (ok) {
      met.push(p);
    } else if (p.level === 'require') {
      unmetRequired.push(p);
    } else {
      unmetRecommended.push(p);
    }
  }
  return { unmetRequired, unmetRecommended, met, notRun };
}

/** One actionable line describing an (applicable) prerequisite, for CLI + render output. */
export function formatPrereq(p) {
  const verb = p.level === 'require' ? 'requires' : 'recommends';
  const scope = p.items?.length ? ` (needed by ${p.items.join(', ')})` : '';
  const where = p.stackName ? `stack "${p.stackName}" ` : '';
  return `${where}${verb} ${p.kind} ${p.name}: ${p.description}${scope} — check: \`${p.check}\``;
}
