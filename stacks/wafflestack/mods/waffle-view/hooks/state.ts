import type { WaffleViewContext, WaffleViewDoc, WaffleViewKey, WaffleViewSlice } from '../types'

export const PANE = 'waffle-view'
export const TITLE = 'Waffle view'
export const LOCAL_CLI = 'installer/cli.mjs'
export const LOCAL_BIN = 'node_modules/.bin/wafflestack'
export const TOOLKIT_SPEC = 'github:dustinkeeton/wafflestack'
const STATE_ARGS = ['state', '--json', '--offline']

export type Probe = { hasLocalCli: boolean; hasLocalBin: boolean }
export type ProcessOutput = { exitCode: number; stdout: string; stderr: string }
export type Parsed = { doc: WaffleViewDoc; error: null } | { doc: null; error: string }

// The toolkit's own checkout first (dogfooding), then an installed dependency, then npx over
// the toolkit's default branch: `state` is read-only, so the unpinned spec `render` refuses
// (#373) is safe here.
export function resolveArgv({ hasLocalCli, hasLocalBin }: Probe): string[] {
  if (hasLocalCli) return ['node', LOCAL_CLI, ...STATE_ARGS]
  if (hasLocalBin) return [LOCAL_BIN, ...STATE_ARGS]
  return ['npx', '--yes', TOOLKIT_SPEC, ...STATE_ARGS]
}

export function parseStateOutput({ exitCode, stdout, stderr }: ProcessOutput): Parsed {
  const tail = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' · ')
  if (exitCode !== 0) {
    return { doc: null, error: `wafflestack state exited ${exitCode}${tail ? `: ${tail}` : ''}` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { doc: null, error: `wafflestack state printed no JSON${tail ? ` (${tail})` : ''}` }
  }
  const version = typeof parsed === 'object' && parsed !== null ? (parsed as { version?: unknown }).version : undefined
  if (version !== 1) {
    return { doc: null, error: `state document version ${String(version)} is not the version 1 this pane reads` }
  }
  return { doc: parsed as WaffleViewDoc, error: null }
}

// The context seam (#563): the behavioral keys the pane shows for what the user is doing — every
// key, in the CLI's order, unless `context.skill` names a skill the document knows.
export function selectKeys(doc: WaffleViewDoc, context: WaffleViewContext): WaffleViewKey[] {
  const slice = selectSlice(doc, context)
  return slice ? slice.keys : doc.keys
}

// Null restores the full view: no skill, or one `doc.skills` does not know (a built-in command, a
// skill outside the toolkit). `config` is what the skill reads beyond its behavioral keys.
export function selectSlice(doc: WaffleViewDoc, context: WaffleViewContext): WaffleViewSlice | null {
  if (context.skill === null) return null
  const skill = doc.skills[context.skill]
  if (!skill) return null
  const wanted = new Set(skill.keys)
  const keys = doc.keys.filter(key => wanted.has(key.key))
  const behavioral = new Set(keys.map(key => key.key))
  const config = skill.keys
    .filter(key => !behavioral.has(key) && key in doc.config)
    .map(key => ({ key, value: doc.config[key]!.value, source: doc.config[key]!.source }))

  return { skill: context.skill, keys, config, files: skill.files }
}

// What a prompt invoked: `/issue 12` → `issue`; a plain prompt → null.
export function promptSkill(text: string): string | null {
  const m = /^\s*\/([\w][\w.-]*)/.exec(text)
  return m ? m[1]! : null
}

// Whether a prompt is the person's own: typed, bridged, the SDK host's, or a plugin's `asUser`
// one — never a peer's message, a task notification or a scheduled trigger delivered meanwhile.
// A session always stamps an origin; one that is absent (a test's own submit) counts as the person's.
export function isPersonsPrompt(origin: { kind: string; asUser?: true } | undefined): boolean {
  if (!origin) return true
  if (origin.kind === 'plugin') return origin.asUser === true
  return origin.kind === 'composer' || origin.kind === 'bridge' || origin.kind === 'sdk' || origin.kind === 'unclassified'
}

// A config value as pane lines: strings line by line (the first `max`, then a count), anything
// else as one JSON line.
export function valueLines(value: unknown, max = 8): string[] {
  if (value === null || value === undefined) return ['—']
  if (typeof value !== 'string') return [JSON.stringify(value)]
  const lines = value.split('\n')
  if (lines.length <= max) return lines
  return [...lines.slice(0, max), `… ${lines.length - max} more line${lines.length - max === 1 ? '' : 's'}`]
}

export function formatMode(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function tokensOf(key: WaffleViewKey): string {
  if (!key.flag) return ''
  const sides: string[] = []
  if (key.flag.on) sides.push(`on ${key.flag.on}`)
  if (key.flag.off) sides.push(`off ${key.flag.off}`)
  return sides.join(' · ')
}

export const isOverridden = (key: WaffleViewKey): boolean => key.value !== key.canonical
