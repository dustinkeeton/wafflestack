import type { WaffleViewContext, WaffleViewDoc, WaffleViewKey } from '../types'

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

// The context seam (#563): which keys the pane shows for what the user is doing. Every key
// today, in the CLI's order; #563 narrows by `context.skill` through `doc.skills`.
export function selectKeys(doc: WaffleViewDoc, _context: WaffleViewContext): WaffleViewKey[] {
  return doc.keys
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
