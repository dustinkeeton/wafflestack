// waffle-view's contract: the `wafflestack state --json` document (shape version 1) as the pane
// reads it, the context the pane slices by (#563), and the values the mod keeps in `$.state`.

export type WaffleViewMode = boolean | 'prompt'

export type WaffleViewLayer = 'local-overlay' | 'waffle.yaml' | 'stack-default'

export type WaffleViewKey = {
  key: string
  stacks: string[]
  value: WaffleViewMode | string | null
  source: WaffleViewLayer
  canonical: WaffleViewMode | string | null
  default: WaffleViewMode | string | null
  modes: WaffleViewMode[]
  prompt: boolean
  nonInteractive: boolean | 'fail' | null
  lockMode: WaffleViewMode | null
  flag: { on: string | null; off: string | null } | null
  description: string
}

export type WaffleViewCheckpoint = {
  file: string
  runId: string
  mtime: string
  lastPhase: string | null
  sections: string[]
  parseError: string | null
}

export type WaffleViewDelegate = {
  checkpoints: { path: string; exists: boolean; runs: number; latest: WaffleViewCheckpoint | null }
  memory: { path: string; exists: boolean; bytes: number; maxBytes: number; overCap: boolean }
}

export type WaffleViewLock = {
  path: string
  present: boolean
  toolkitVersion: string | null
  toolkitStatus: string | null
  toolkitRef: string | null
  files: number
}

/** One declared config key, resolved (`config` in the document, #563). */
export type WaffleViewConfigValue = { value: unknown; source: WaffleViewLayer; stacks: string[] }

/** What one skill cares about (`skills[<name>]` in the document, #563). */
export type WaffleViewSkillContext = { keys: string[]; files: string[] }

export type WaffleViewDoc = {
  version: 1
  cli: { version: string; status: string; commit: string | null }
  project: {
    targets: string[]
    stacks: string[]
    include: string[]
    eject: string[]
    localOverlay: boolean
    errors: string[]
  }
  keys: WaffleViewKey[]
  runFiles: { delegate: WaffleViewDelegate | null }
  locks: {
    committed: WaffleViewLock
    local: WaffleViewLock
    tree: 'committed' | 'local'
    inSync: boolean | null
    divergence: unknown
  }
  drift: { ok: boolean; modified: string[]; missing: string[]; absentDocs: string[]; notes: string[] }
  config: Record<string, WaffleViewConfigValue>
  skills: Record<string, WaffleViewSkillContext>
}

/**
 * What the user is doing right now, as far as the pane can tell: the name the last prompt invoked
 * (`/issue` → `issue`), or null after a plain prompt. A name `doc.skills` does not know (a built-in
 * command, a skill outside the toolkit) reads as the full view.
 */
export type WaffleViewContext = { skill: string | null }

/** A sliced view: the skill, the behavioral keys and other config it reads, the run files it writes. */
export type WaffleViewSlice = {
  skill: string
  keys: WaffleViewKey[]
  config: { key: string; value: unknown; source: WaffleViewLayer }[]
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'waffle-view': { doc: WaffleViewDoc | null; error: string | null; isRefreshing: boolean; skill: string | null }
  }
}
