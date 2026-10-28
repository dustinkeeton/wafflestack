import type { WaffleViewAgent, WaffleViewContext, WaffleViewDoc, WaffleViewKey, WaffleViewLayer, WaffleViewSlice } from '../types'

export const PANE = 'waffle-view'
export const TITLE = 'Waffle view'
export const LOCAL_CLI = 'installer/cli.mjs'
export const LOCAL_BIN = 'node_modules/.bin/wafflestack'
export const TOOLKIT_SPEC = 'github:dustinkeeton/wafflestack'
// No `--offline` (#608): state's identity is offline regardless; the flag would only stop the
// cached newer-release check. `WAFFLESTACK_OFFLINE=1` in the session env still forces it.
const STATE_ARGS = ['state', '--json']

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

const stderrTail = (stderr: string): string => stderr.trim().split('\n').filter(Boolean).slice(-3).join(' · ')

export function parseStateOutput({ exitCode, stdout, stderr }: ProcessOutput): Parsed {
  const tail = stderrTail(stderr)
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

// The roster the `/standup` slice shows (#610): null for any other slice, undefined when the CLI
// predates `agents`, else the document's own (roster) order.
export const STANDUP_SKILL = 'standup'

export function selectAgents(doc: WaffleViewDoc, slice: WaffleViewSlice | null): WaffleViewAgent[] | null | undefined {
  if (slice?.skill !== STANDUP_SKILL) return null
  return doc.agents
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

// The headline badge and its remedy line, or null: no newer release, or an older CLI with no `update`.
export function updateBadge(doc: WaffleViewDoc): { label: string; command: string | null } | null {
  const update = doc.update
  if (!update?.available || !update.latestTag) return null
  return { label: ` · ${update.latestTag} available`, command: update.command }
}

// The editor the bottom Button opens (#616). The key is spelled as a literal: validate counts a
// mod's quoted literal as the reference that keeps a declared key from reading as unused.
export const EDITOR_KEY = 'waffleView.editor'
export const DEFAULT_EDITOR = 'cursor'
export const EDITOR_TIMEOUT_MS = 15_000

// A string is one executable, never split on spaces; an argv array carries flags. Anything else —
// no document, a stack without the key, an empty or malformed value — falls back to Cursor.
export function editorArgv(doc: WaffleViewDoc | null, root: string): string[] {
  const value: unknown = doc?.config[EDITOR_KEY]?.value
  if (typeof value === 'string' && value.trim()) return [value.trim(), root]
  if (Array.isArray(value) && value.length > 0 && value.every(part => typeof part === 'string' && part.trim())) {
    return [...(value as string[]).map(part => part.trim()), root]
  }
  return [DEFAULT_EDITOR, root]
}

const EDITOR_NAMES: Record<string, string> = {
  cursor: 'Cursor',
  code: 'VS Code',
  'code-insiders': 'VS Code Insiders',
  zed: 'Zed',
  idea: 'IntelliJ IDEA',
  webstorm: 'WebStorm',
  subl: 'Sublime Text',
}

export function editorLabel(launcher: string): string {
  const base = launcher.split(/[\\/]/).pop()!.replace(/\.(exe|cmd)$/i, '')
  const name = EDITOR_NAMES[base.toLowerCase()] ?? (base ? base[0]!.toUpperCase() + base.slice(1) : DEFAULT_EDITOR)
  return `Open in ${name}`
}

// What a launch came to, as the pane's inline error; null when it exited 0.
export function editorLaunchError(
  launcher: string,
  outcome: { output: ProcessOutput } | { thrown: unknown; timedOut?: boolean },
): string | null {
  if ('thrown' in outcome && outcome.timedOut) {
    return `${launcher} was still running after ${EDITOR_TIMEOUT_MS / 1000} s — set ${EDITOR_KEY} to a launcher that hands off and exits`
  }
  if ('thrown' in outcome) {
    const message = outcome.thrown instanceof Error ? outcome.thrown.message : String(outcome.thrown)
    return `${launcher} could not start: ${message} — is it on PATH? Set ${EDITOR_KEY} to your editor's launcher`
  }
  const { exitCode, stderr } = outcome.output
  if (exitCode === 0) return null
  const tail = stderrTail(stderr)
  return `${launcher} exited ${exitCode}${tail ? `: ${tail}` : ''}`
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

// The brand palette (assets/README.md, "Palette"): every colour role below resolves to one of
// these, or to a theme status key; a pane with colour stripped keeps bold/dim and the literal words.
export const BRAND = {
  golden: '#F5C752',
  syrup: '#F08A1D',
  pocket: '#DE8127',
  cream: '#FFF3DC',
  caption: '#C9A87C',
} as const

export type Tone = { color?: string; dimColor?: boolean; bold?: boolean }

// The 2-row variant of the CLI waffle (assets/README.md, "CLI waffle"), for the pane header.
export const WAFFLE_GLYPH = ['┏━┳━┳━┓', '┗━┻━┻━┛'] as const
export const TAGLINE = 'one batter, every repo'

export const HEADING_TONE: Tone = { color: BRAND.golden, bold: true }
export const CAPTION_TONE: Tone = { color: BRAND.caption, dimColor: true }

// A key name: Cream, or the theme's warning when its value differs from the lock.
export const keyTone = (key: WaffleViewKey): Tone => (isOverridden(key) ? { color: 'warning' } : { color: BRAND.cream })

// A behavioral value by kind: `true` Golden, `false` muted, `prompt` Syrup, other text Cream, unset dim.
export function valueTone(value: WaffleViewKey['value']): Tone {
  if (value === null || value === undefined) return { dimColor: true }
  if (value === true) return { color: BRAND.golden, bold: true }
  if (value === false) return { color: BRAND.caption, bold: true }
  if (value === 'prompt') return { color: BRAND.syrup, bold: true }
  return { color: BRAND.cream, bold: true }
}

// Where a value came from: the stack default dim, the project's `waffle.yaml` Pocket, the
// machine's local overlay Syrup.
export function sourceTone(source: WaffleViewLayer): Tone {
  if (source === 'local-overlay') return { color: BRAND.syrup }
  if (source === 'waffle.yaml') return { color: BRAND.pocket }
  return { dimColor: true }
}

// A pass/fail state in the theme's status colours; null is no verdict.
export function statusTone(ok: boolean | null, failure: 'error' | 'warning' = 'error'): Tone {
  if (ok === null) return {}
  return { color: ok ? 'success' : failure }
}
