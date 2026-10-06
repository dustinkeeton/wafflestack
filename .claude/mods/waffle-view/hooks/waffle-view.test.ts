import { describe, expect, test } from 'claude-code/testing'

import type { WaffleViewDoc } from '../types'
import {
  LOCAL_BIN,
  LOCAL_CLI,
  PANE,
  isPersonsPrompt,
  parseStateOutput,
  promptSkill,
  resolveArgv,
  selectKeys,
  selectSlice,
  tokensOf,
  valueLines,
} from './state'

const STATE_ARGS = ['state', '--json', '--offline']

const DOC: WaffleViewDoc = {
  version: 1,
  cli: { version: '0.16.1', status: 'release', commit: '0eefb18535856d6e8e3f9e58853a0afca928fd76' },
  project: {
    targets: ['claude'],
    stacks: ['github-workflow', 'orchestration'],
    include: ['code-quality/skills/qa'],
    eject: [],
    localOverlay: true,
    errors: [],
  },
  keys: [
    {
      key: 'issue.confirmGate',
      stacks: ['github-workflow'],
      value: false,
      source: 'local-overlay',
      canonical: true,
      default: true,
      modes: [true, false, 'prompt'],
      prompt: false,
      nonInteractive: false,
      lockMode: null,
      flag: { on: '--confirm', off: '--yes' },
      description: 'Whether `/issue` pauses at the plan gate.',
    },
    {
      key: 'autopilot.autoMerge',
      stacks: ['orchestration'],
      value: 'prompt',
      source: 'stack-default',
      canonical: 'prompt',
      default: 'prompt',
      modes: [true, false, 'prompt'],
      prompt: true,
      nonInteractive: false,
      lockMode: 'prompt',
      flag: { on: '+automerge', off: null },
      description: 'Per-run auto-merge consent.',
    },
  ],
  runFiles: {
    delegate: {
      checkpoints: {
        path: '.claude/worktrees/.delegate',
        exists: true,
        runs: 1,
        latest: {
          file: '.claude/worktrees/.delegate/delegate-1700000000.json',
          runId: 'delegate-1700000000',
          mtime: '2026-10-06T12:00:00.000Z',
          lastPhase: 'plan',
          sections: ['scope', 'issues', 'classification', 'plan'],
          parseError: null,
        },
      },
      memory: { path: '.claude/worktrees/.delegate/memory.md', exists: true, bytes: 812, maxBytes: 4096, overCap: false },
    },
  },
  locks: {
    committed: { path: '.waffle/waffle.lock.json', present: true, toolkitVersion: '0.16.1', toolkitStatus: 'release', toolkitRef: 'v0.16.1', files: 67 },
    local: { path: '.waffle/waffle.local.lock.json', present: false, toolkitVersion: null, toolkitStatus: null, toolkitRef: null, files: 0 },
    tree: 'committed',
    inSync: null,
    divergence: null,
  },
  drift: { ok: false, modified: [], missing: ['.github/workflows/waffle-label-hook.yml'], absentDocs: ['.waffle/TEAM.md'], notes: [] },
  config: {
    'autopilot.autoMerge': { value: 'prompt', source: 'stack-default', stacks: ['orchestration'] },
    'autopilot.planDir': { value: '.claude/worktrees/.autopilot', source: 'stack-default', stacks: ['orchestration'] },
    'delegate.checkpointDir': { value: '.claude/worktrees/.delegate', source: 'stack-default', stacks: ['orchestration'] },
    'delegate.memoryFile': { value: '.claude/worktrees/.delegate/memory.md', source: 'stack-default', stacks: ['orchestration'] },
    'delegate.memoryMaxBytes': { value: 4096, source: 'stack-default', stacks: ['orchestration'] },
    'issue.confirmGate': { value: false, source: 'local-overlay', stacks: ['github-workflow'] },
    'issue.priorityLabels': {
      value: '| Signal in issue content | Label |\n|---|---|\n| crash, data loss | `priority: critical` |\n| cosmetic | `priority: low` |',
      source: 'stack-default',
      stacks: ['github-workflow'],
    },
    'project.name': { value: 'wafflestack', source: 'waffle.yaml', stacks: ['github-workflow', 'orchestration'] },
  },
  skills: {
    issue: { keys: ['issue.confirmGate', 'issue.priorityLabels', 'project.name'], files: [] },
    delegate: {
      keys: ['delegate.checkpointDir', 'delegate.memoryFile', 'delegate.memoryMaxBytes', 'project.name'],
      files: ['.claude/worktrees/.delegate', '.claude/worktrees/.delegate/delegate-1700000000.json', '.claude/worktrees/.delegate/memory.md'],
    },
    autopilot: { keys: ['autopilot.autoMerge', 'autopilot.planDir'], files: ['.claude/worktrees/.autopilot'] },
    'git-workflow': { keys: [], files: [] },
  },
}

const exited = (exitCode: number, stdout: string, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const PANE_PROPS = {
  title: 'Waffle view',
  isFocused: false,
  bodyColumns: 120,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

const COMPOSER = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } }
const TYPED = { wait: false, origin: { kind: 'composer' as const } }
const PEER = { wait: false, origin: { kind: 'peer' as const } }

describe('state helpers', () => {
  test('resolveArgv prefers the checkout CLI, then the installed bin, then npx', () => {
    expect(resolveArgv({ hasLocalCli: true, hasLocalBin: true })).toEqual(['node', LOCAL_CLI, ...STATE_ARGS])
    expect(resolveArgv({ hasLocalCli: false, hasLocalBin: true })).toEqual([LOCAL_BIN, ...STATE_ARGS])
    expect(resolveArgv({ hasLocalCli: false, hasLocalBin: false })).toEqual([
      'npx',
      '--yes',
      'github:dustinkeeton/wafflestack',
      ...STATE_ARGS,
    ])
  })

  test('parseStateOutput accepts version 1 and names every failure', () => {
    expect(parseStateOutput(exited(0, JSON.stringify(DOC), 'provenance warning\n')).doc?.keys).toHaveLength(2)
    expect(parseStateOutput(exited(1, '', 'no .waffle/waffle.yaml here\n')).error).toBe(
      'wafflestack state exited 1: no .waffle/waffle.yaml here',
    )
    expect(parseStateOutput(exited(0, 'not json')).error).toBe('wafflestack state printed no JSON')
    expect(parseStateOutput(exited(0, '{"version":2}')).error).toMatch(/version 2/)
  })

  test('selectKeys narrows to the skill the context names and falls back to every key, and tokensOf names the sides', () => {
    expect(selectKeys(DOC, { skill: null })).toEqual(DOC.keys)
    expect(selectKeys(DOC, { skill: 'issue' })).toEqual([DOC.keys[0]])
    expect(selectKeys(DOC, { skill: 'autopilot' })).toEqual([DOC.keys[1]])
    expect(selectKeys(DOC, { skill: 'git-workflow' })).toEqual([])
    expect(selectKeys(DOC, { skill: 'clear' })).toEqual(DOC.keys)
    expect(tokensOf(DOC.keys[0]!)).toBe('on --confirm · off --yes')
    expect(tokensOf(DOC.keys[1]!)).toBe('on +automerge')
    expect(tokensOf({ ...DOC.keys[1]!, flag: null })).toBe('')
  })

  test('selectSlice carries the non-behavioral config a skill reads and the files it writes; unknown skills read as the full view', () => {
    const issue = selectSlice(DOC, { skill: 'issue' })!
    expect(issue.skill).toBe('issue')
    expect(issue.keys.map(key => key.key)).toEqual(['issue.confirmGate'])
    expect(issue.config.map(entry => entry.key)).toEqual(['issue.priorityLabels', 'project.name'])
    expect(issue.config[1]).toEqual({ key: 'project.name', value: 'wafflestack', source: 'waffle.yaml' })
    expect(issue.files).toEqual([])
    expect(selectSlice(DOC, { skill: 'delegate' })!.files).toHaveLength(3)
    expect(selectSlice(DOC, { skill: null })).toBeNull()
    expect(selectSlice(DOC, { skill: 'clear' })).toBeNull()
    expect(selectSlice({ ...DOC, config: {} }, { skill: 'issue' })!.config).toEqual([])
  })

  test('promptSkill reads the invoked name off a prompt; isPersonsPrompt admits only the person\'s own', () => {
    expect(promptSkill('/issue 12 --yes')).toBe('issue')
    expect(promptSkill('  /pr-response')).toBe('pr-response')
    expect(promptSkill('/waffle-view')).toBe(PANE)
    expect(promptSkill('fix the issue')).toBeNull()
    expect(promptSkill('')).toBeNull()
    expect(isPersonsPrompt(undefined)).toBe(true)
    expect(isPersonsPrompt({ kind: 'composer' })).toBe(true)
    expect(isPersonsPrompt({ kind: 'bridge' })).toBe(true)
    expect(isPersonsPrompt({ kind: 'plugin', asUser: true })).toBe(true)
    expect(isPersonsPrompt({ kind: 'plugin' })).toBe(false)
    expect(isPersonsPrompt({ kind: 'peer' })).toBe(false)
    expect(isPersonsPrompt({ kind: 'task-notification' })).toBe(false)
  })

  test('valueLines splits a string, caps it with a count, and JSON-encodes the rest', () => {
    expect(valueLines('a\nb')).toEqual(['a', 'b'])
    expect(valueLines('1\n2\n3\n4', 2)).toEqual(['1', '2', '… 2 more lines'])
    expect(valueLines('1\n2\n3', 2)).toEqual(['1', '2', '… 1 more line'])
    expect(valueLines(4096)).toEqual(['4096'])
    expect(valueLines({ a: 1 })).toEqual(['{"a":1}'])
    expect(valueLines(null)).toEqual(['—'])
  })
})

describe('the pane', () => {
  test('/waffle-view opens the pane and draws the state on each surface', async ($, on) => {
    const argvs: (readonly string[])[] = []
    const probed: string[] = []
    on('fs.exists', (_$, e) => {
      probed.push(e.path)
      return { value: e.path.endsWith(LOCAL_CLI) }
    })
    on('process.run', (_$, e) => {
      argvs.push(e.argv)
      return { value: exited(0, JSON.stringify(DOC)) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('session.start', (_$, e) => ({ cwd: e.cwd }))

    await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
    const ran = await $.command.run({ command: PANE, args: '', ...COMPOSER })
    expect(ran.text).toBe('Waffle view pane opened.')
    expect(probed).toHaveLength(2)
    expect(argvs).toEqual([['node', LOCAL_CLI, ...STATE_ARGS]])

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: PANE, surface, component: 'Pane', requestId: PANE, props: PANE_PROPS })
      expect(await ui.find({ type: 'Text', text: /wafflestack 0\.16\.1/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'false (lock: true)' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: 'on --confirm · off --yes' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /latest delegate-1700000000 · phase plan/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /812\/4096 bytes/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /toolkit 0\.16\.1 \(release, v0\.16\.1\) · 67 files/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '0 modified · 1 missing' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /stacks: github-workflow, orchestration/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /last refresh failed/ })).toBeUndefined()
      await ui.unmount()
    }
  })

  test('/waffle-view closes the pane when it is already open, without a read', async ($, on) => {
    const closed: string[] = []
    let reads = 0
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => {
      reads += 1
      return { value: exited(0, JSON.stringify(DOC)) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [{ id: PANE, title: 'Waffle view', isShown: true, isFocused: false, isPlaced: true }] }))
    on('ui.close', (_$, e) => {
      closed.push(e.id)
      return { value: undefined }
    })
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    const ran = await $.command.run({ command: PANE, args: '', ...COMPOSER })
    expect(ran.text).toBe('Waffle view pane closed.')
    expect(closed).toEqual([PANE])
    expect(reads).toBe(0)
  })

  test('a narrow pane folds each key onto one line', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({
      plugin: PANE,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: { ...PANE_PROPS, bodyColumns: 60, placement: 'inline' },
    })
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate  false (lock: true)  local-overlay  on --confirm · off --yes' })).toBeDefined()
    await ui.unmount()
  })

  test('a failing CLI shows the error and keeps the last good document', async ($, on) => {
    let healthy = true
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({
      value: healthy ? exited(0, JSON.stringify(DOC)) : exited(1, '', 'error: no .waffle/waffle.yaml in /repo\n'),
    }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    healthy = false
    await $.command.run({ command: PANE, args: '', ...COMPOSER })

    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'last refresh failed: wafflestack state exited 1: error: no .waffle/waffle.yaml in /repo' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
    await ui.unmount()
  })

  test('after /issue the pane shows only what /issue reads; a plain prompt restores the full view', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: 'issue', args: '12', ...COMPOSER })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /issue' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'autopilot.autoMerge' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Config /issue reads (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue.priorityLabels' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /crash, data loss \| `priority: critical`/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /latest delegate-1700000000/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Locks' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Drift' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /stacks: github-workflow/ })).toBeUndefined()
    await ui.unmount()

    await $.prompt.submit({ text: 'what does the pane show now?', ...TYPED })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /issue' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'autopilot.autoMerge' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Locks' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /stacks: github-workflow/ })).toBeDefined()
    await ui.unmount()
  })

  test('after /delegate the pane shows the newest run, its last phase and the memory file; a built-in command reads as the full view', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.prompt.submit({ text: '/delegate --batch', ...TYPED })

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /delegate' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /delegate checkpoints: 1 run in \.claude\/worktrees\/\.delegate/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /latest delegate-1700000000 · phase plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /delegate memory: 812\/4096 bytes/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'delegate.checkpointDir' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /reads no behavioral key/ })).toBeDefined()
    await ui.unmount()

    await $.command.run({ command: 'clear', args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /delegate' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
    await ui.unmount()
  })

  test('a peer\'s message delivered meanwhile does not move the context', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: 'autopilot', args: '', ...COMPOSER })
    await $.prompt.submit({ text: 'Another Claude session sent a message', ...PEER })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })

    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /autopilot' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '.claude/worktrees/.autopilot' })).toBeDefined()
    await ui.unmount()
  })

  test('before any read the pane says so instead of drawing nothing', async $ => {
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'no state read yet' })).toBeDefined()
    await ui.unmount()
  })
})
