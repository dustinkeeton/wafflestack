// waffle-view's contract: the `wafflestack state --json` document (shape version 1) as the pane
// reads it, the context seam #563 fills, and the values the mod keeps in `$.state`.

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
  skills: Record<string, { keys: string[]; files: string[] }>
}

/** What the user is doing right now, as far as the pane can tell; `skill` is null until #563. */
export type WaffleViewContext = { skill: string | null }

declare module 'claude-code' {
  interface PluginState {
    'waffle-view': { doc: WaffleViewDoc | null; error: string | null; isRefreshing: boolean }
  }
}
