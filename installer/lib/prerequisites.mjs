import { spawnSync } from 'node:child_process';
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

/** Probe every applicable prerequisite (`kinds` restricts which) into `{ unmetRequired, unmetRecommended, met }`. */
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
