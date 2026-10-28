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
  configModes: WaffleViewMode[] | null
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
  /** Optional: a CLI older than #610 prints no roster. */
  agents?: WaffleViewAgent[]
  /** Optional: a CLI older than #608 prints no `update` block. */
  update?: WaffleViewUpdate
  /** Optional: only with `--board` (#697/#698); absent from an older CLI. */
  board?: WaffleViewBoard
}

export type WaffleViewMilestone = { title: string; dueOn: string | null }

export type WaffleViewEpic = { number: number; title: string; done: number; total: number }

/** A Projects v2 item; a draft has no number. */
export type WaffleViewBoardItem = { number: number | null; title: string; kind: 'issue' | 'pr' | 'draft' }

/** What the team is working on (`board` in the document, #697); every list is empty when `error` is set. */
export type WaffleViewBoard = {
  milestones: WaffleViewMilestone[]
  epics: WaffleViewEpic[]
  inProgress: WaffleViewBoardItem[]
  inReview: WaffleViewBoardItem[]
  projectName: string | null
  project: { number: number; title: string } | null
  projectError: string | null
  error: string | null
  checkedAt: string | null
  source: 'remote' | 'cache' | null
}

/** One rendered agent `/standup` rounds up (`agents` in the document, #610), in roster order. */
export type WaffleViewAgent = { name: string; description: string; file: string }

/** Whether a newer toolkit release exists (`update` in the document, #608). */
export type WaffleViewUpdate = {
  latestTag: string | null
  available: boolean
  command: string | null
  checkedAt: string | null
  source: 'remote' | 'cache' | 'local-tags' | 'changelog' | null
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

/** A subagent's place in a running `/standup` wave (#699); absent is pending. */
export type WaffleViewWaveStatus = 'running' | 'done' | 'failed'
/** The wave by subagent type, and each spawn's `agentId` back to its type. */
export type WaffleViewWave = { byType: Record<string, WaffleViewWaveStatus>; byId: Record<string, string> }

declare module 'claude-code' {
  interface PluginState {
    'waffle-view': {
      doc: WaffleViewDoc | null
      error: string | null
      isRefreshing: boolean
      skill: string | null
      /** The last "Open in editor" failure (#616); a refresh leaves it, a good launch clears it. */
      launchError: string | null
      wave: WaffleViewWave
    }
  }
}
