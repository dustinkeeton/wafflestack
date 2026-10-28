import { describe, expect, test } from 'claude-code/testing'

import type { WaffleViewBoard, WaffleViewDoc } from '../types'
import {
  BRAND,
  DEFAULT_EDITOR,
  EMPTY_WAVE,
  EDITOR_KEY,
  LOCAL_BIN,
  LOCAL_CLI,
  PANE,
  WAFFLE_GLYPH,
  boardFlagRejected,
  boardHint,
  boardUnavailable,
  editorArgv,
  editorLabel,
  editorLaunchError,
  formatDue,
  formatProgress,
  isPersonsPrompt,
  itemRef,
  keyTone,
  parseStateOutput,
  promptSkill,
  resolveArgv,
  selectAgents,
  selectBoard,
  selectKeys,
  selectSlice,
  sourceTone,
  statusTone,
  tokensOf,
  updateBadge,
  valueLines,
  valueTone,
  wantsBoard,
  waveCompleted,
  waveMarker,
  waveSpawned,
} from './state'

const STATE_ARGS = ['state', '--json']

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
      configModes: null,
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
      configModes: null,
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
    standup: { keys: [], files: [] },
  },
  agents: [
    { name: 'docs-agent', description: 'Agent-optimized documentation writer.', file: '.claude/agents/docs-agent.md' },
    { name: 'harness-architect', description: 'Expert in designing agent harnesses.', file: '.claude/agents/harness-architect.md' },
  ],
}

const exited = (exitCode: number, stdout: string, stderr = '') => ({
  exitCode,
  stdout,
  stderr,
  isStdoutTruncated: false,
  isStderrTruncated: false,
})

const BOARD: WaffleViewBoard = {
  milestones: [
    { title: 'v1.0', dueOn: '2026-11-01T00:00:00Z' },
    { title: 'Someday', dueOn: null },
  ],
  epics: [
    { number: 610, title: '[epic] /standup', done: 2, total: 5 },
    { number: 552, title: '[epic] mods', done: 3, total: 3 },
  ],
  inProgress: [
    { number: 697, title: 'state --board', kind: 'issue' },
    { number: null, title: 'sketch the focus pane', kind: 'draft' },
  ],
  inReview: [{ number: 704, title: 'feat: read the board', kind: 'pr' }],
  projectName: 'WaffleStack',
  project: { number: 7, title: 'WaffleStack' },
  projectError: null,
  error: null,
  checkedAt: '2026-10-27T00:00:00.000Z',
  source: 'cache',
}

const UPDATE = {
  latestTag: 'v0.18.0',
  available: true,
  command: 'npx --yes github:dustinkeeton/wafflestack#v0.18.0 upgrade',
  checkedAt: '2026-10-11T00:00:00.000Z',
  source: 'cache' as const,
}

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
  test('selectAgents answers only for /standup, in document order, undefined from an older CLI (#610)', () => {
    const standup = selectSlice(DOC, { skill: 'standup' })
    expect(selectAgents(DOC, standup)?.map(agent => agent.name)).toEqual(['docs-agent', 'harness-architect'])
    expect(selectAgents(DOC, selectSlice(DOC, { skill: 'issue' }))).toBeNull()
    expect(selectAgents(DOC, null)).toBeNull()
    const { agents: _omitted, ...older } = DOC
    expect(selectAgents(older, standup)).toBeUndefined()
  })

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

  test('resolveArgv no longer passes --offline, so the cached newer-release check can run (#608)', () => {
    expect(resolveArgv({ hasLocalCli: true, hasLocalBin: false })).not.toContain('--offline')
  })

  test('updateBadge names a newer release and its remedy; no block (an older CLI) or no release reads as none', () => {
    expect(updateBadge(DOC)).toBeNull()
    expect(updateBadge({ ...DOC, update: { ...UPDATE, available: false } })).toBeNull()
    expect(updateBadge({ ...DOC, update: UPDATE })).toEqual({ label: ' · v0.18.0 available', command: UPDATE.command })
    expect(updateBadge({ ...DOC, update: { ...UPDATE, command: null } })?.command).toBeNull()
  })

  // The backstop behind the marketplace ref pin (#595): a mod from another release refuses the doc.
  test('parseStateOutput refuses any schema version but 1, naming what it got', () => {
    const refused = (stdout: string) => parseStateOutput(exited(0, stdout))
    expect(refused('{"version":2}')).toEqual({ doc: null, error: 'state document version 2 is not the version 1 this pane reads' })
    expect(refused('{"version":"1"}').error).toBe('state document version 1 is not the version 1 this pane reads')
    expect(refused('{}').error).toBe('state document version undefined is not the version 1 this pane reads')
    expect(refused('[1]').error).toBe('state document version undefined is not the version 1 this pane reads')
    expect(refused('null').error).toBe('state document version undefined is not the version 1 this pane reads')
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

  // The colour roles (#604): brand palette for content, theme status keys for pass/fail only.
  test('tones tell value kinds, source layers and overrides apart, and status stays theme-coloured', () => {
    expect(valueTone(true)).toEqual({ color: BRAND.golden, bold: true })
    expect(valueTone(false)).toEqual({ color: BRAND.caption, bold: true })
    expect(valueTone('prompt')).toEqual({ color: BRAND.syrup, bold: true })
    expect(valueTone('v0.16.1')).toEqual({ color: BRAND.cream, bold: true })
    expect(valueTone(null)).toEqual({ dimColor: true })
    expect(sourceTone('stack-default')).toEqual({ dimColor: true })
    expect(sourceTone('waffle.yaml')).toEqual({ color: BRAND.pocket })
    expect(sourceTone('local-overlay')).toEqual({ color: BRAND.syrup })
    expect(keyTone(DOC.keys[0]!)).toEqual({ color: 'warning' })
    expect(keyTone(DOC.keys[1]!)).toEqual({ color: BRAND.cream })
    expect(statusTone(true)).toEqual({ color: 'success' })
    expect(statusTone(false)).toEqual({ color: 'error' })
    expect(statusTone(false, 'warning')).toEqual({ color: 'warning' })
    expect(statusTone(null)).toEqual({})
    expect(WAFFLE_GLYPH).toEqual(['┏━┳━┳━┓', '┗━┻━┻━┛'])
    expect(Object.values(BRAND).every(hex => /^#[0-9A-F]{6}$/.test(hex))).toBe(true)
  })
})

const withEditor = (value: unknown): WaffleViewDoc => ({
  ...DOC,
  config: { ...DOC.config, [EDITOR_KEY]: { value, source: 'waffle.yaml', stacks: ['wafflestack'] } },
})

describe('open in editor (#616)', () => {
  test('editorArgv runs the configured launcher on the root, Cursor when unset or malformed', () => {
    expect(EDITOR_KEY).toBe('waffleView.editor')
    expect(DEFAULT_EDITOR).toBe('cursor')
    expect(editorArgv(null, '/repo')).toEqual(['cursor', '/repo'])
    expect(editorArgv(DOC, '/repo')).toEqual(['cursor', '/repo'])
    expect(editorArgv(withEditor('code'), '/repo')).toEqual(['code', '/repo'])
    expect(editorArgv(withEditor(' /Applications/My Editor/bin/ed '), '/repo')).toEqual(['/Applications/My Editor/bin/ed', '/repo'])
    expect(editorArgv(withEditor(['code', '--new-window']), '/repo')).toEqual(['code', '--new-window', '/repo'])
    expect(editorArgv(withEditor([' code ', ' --new-window']), '/repo')).toEqual(['code', '--new-window', '/repo'])
    for (const junk of ['', '  ', [], [1], ['code', ''], {}, 7, null]) {
      expect(editorArgv(withEditor(junk), '/repo')).toEqual(['cursor', '/repo'])
    }
  })

  test('editorLabel names the editor, by table or by the launcher\'s own name', () => {
    expect(editorLabel('cursor')).toBe('Open in Cursor')
    expect(editorLabel('code')).toBe('Open in VS Code')
    expect(editorLabel('/usr/local/bin/zed')).toBe('Open in Zed')
    expect(editorLabel('C:\\Tools\\subl.exe')).toBe('Open in Sublime Text')
    expect(editorLabel('idea')).toBe('Open in IntelliJ IDEA')
    expect(editorLabel('helix')).toBe('Open in Helix')
  })

  test('editorLaunchError names a non-zero exit and a launcher that cannot start; exit 0 is no error', () => {
    expect(editorLaunchError('code', { output: exited(0, '') })).toBeNull()
    expect(editorLaunchError('code', { output: exited(1, '', 'no such workspace\n') })).toBe('code exited 1: no such workspace')
    expect(editorLaunchError('code', { output: exited(2, '') })).toBe('code exited 2')
    expect(editorLaunchError('cursor', { thrown: new Error('spawn cursor ENOENT') })).toBe(
      'cursor could not start: spawn cursor ENOENT — is it on PATH? Set waffleView.editor to your editor\'s launcher',
    )
    expect(editorLaunchError('idea', { thrown: new Error('timed out'), timedOut: true })).toBe(
      'idea was still running after 15 s — set waffleView.editor to a launcher that hands off and exits',
    )
    expect(editorLaunchError('idea', { thrown: new Error('spawn idea ENOENT'), timedOut: false })).toMatch(/^idea could not start: .* is it on PATH\?/)
  })

  test('the Button reads Open in Cursor by default, even before a read, and launches on the session directory', async ($, on) => {
    const launched: (readonly string[])[] = []
    on('fs.exists', () => ({ value: false }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', (_$, e) => {
      if (e.argv[0] !== 'npx') launched.push(e.argv)
      return { value: exited(0, JSON.stringify(DOC)) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Button', key: 'open-editor' }))?.props.label).toBe('Open in Cursor')
    await ui.unmount()

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Button', key: 'open-editor' }))?.props.label).toBe('Open in Cursor')
    await ui.press({ key: 'open-editor' })
    expect(launched).toEqual([['cursor', '/repo']])
    expect(await ui.find({ type: 'Text', text: /open in editor failed/ })).toBeUndefined()
    await ui.unmount()
  })

  test('waffleView.editor: code switches the label and the launch, and the sliced view keeps the Button', async ($, on) => {
    const launched: (readonly string[])[] = []
    on('fs.exists', () => ({ value: false }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', (_$, e) => {
      if (e.argv[0] !== 'npx') launched.push(e.argv)
      return { value: exited(0, JSON.stringify(withEditor('code'))) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))

    await $.command.run({ command: 'issue', args: '12', ...COMPOSER })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /issue' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 'open-editor' }))?.props.label).toBe('Open in VS Code')
    await ui.press({ key: 'open-editor' })
    expect(launched).toEqual([['code', '/repo']])
    await ui.unmount()
  })

  test('a missing launcher fails inline, the pane keeps working, a refresh keeps the error and a good launch clears it', async ($, on) => {
    let launcherExists = false
    on('fs.exists', () => ({ value: false }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', (_$, e) => {
      if (e.argv[0] === 'npx') return { value: exited(0, JSON.stringify(DOC)) }
      return launcherExists ? { value: exited(0, '') } : { deny: 'spawn cursor ENOENT' }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    await ui.press({ key: 'open-editor' })
    await ui.unmount()

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /^open in editor failed: cursor could not start: .*ENOENT.* is it on PATH\?/ }))?.props.color).toBe('error')
    expect(await ui.find({ type: 'Text', text: 'Keys (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /last refresh failed/ })).toBeUndefined()

    launcherExists = true
    await ui.press({ key: 'open-editor' })
    await ui.unmount()
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /open in editor failed/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a launcher that exits non-zero shows its exit code and stderr inline', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('process.run', (_$, e) => ({
      value: e.argv[0] === 'npx' ? exited(0, JSON.stringify(DOC)) : exited(3, '', 'cursor: workspace locked\n'),
    }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    await ui.press({ key: 'open-editor' })
    await ui.unmount()
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'open in editor failed: cursor exited 3: cursor: workspace locked' })).toBeDefined()
    await ui.unmount()
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
      expect((await ui.find({ type: 'Text', text: WAFFLE_GLYPH[0] }))?.props.color).toBe(BRAND.golden)
      expect((await ui.find({ type: 'Text', text: 'Keys (2)' }))?.props).toMatchObject({ color: BRAND.golden, bold: true, underline: true })
      expect((await ui.find({ type: 'Text', text: 'issue.confirmGate' }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Text', text: /^false$/ }))?.props).toMatchObject({ color: BRAND.caption, bold: true })
      expect((await ui.find({ type: 'Text', text: ' (lock: true)' }))?.props.color).toBe('warning')
      expect((await ui.find({ type: 'Text', text: /^prompt$/ }))?.props).toMatchObject({ color: BRAND.syrup, bold: true })
      expect((await ui.find({ type: 'Text', text: 'autopilot.autoMerge' }))?.props.color).toBe(BRAND.cream)
      expect((await ui.find({ type: 'Text', text: /^local-overlay$/ }))?.props.color).toBe(BRAND.syrup)
      expect((await ui.find({ type: 'Text', text: /^stack-default$/ }))?.props).toMatchObject({ dimColor: true })
      expect((await ui.find({ type: 'Text', text: 'on --confirm · off --yes' }))?.props).toMatchObject({ color: BRAND.caption, dimColor: true })
      expect(await ui.find({ type: 'Text', text: /latest delegate-1700000000 · phase plan/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /812\/4096 bytes/ }))?.props.color).toBe('success')
      expect(await ui.find({ type: 'Text', text: /toolkit 0\.16\.1 \(release, v0\.16\.1\) · 67 files/ })).toBeDefined()
      expect((await ui.find({ type: 'Text', text: /^local: none$/ }))?.props).toMatchObject({ dimColor: true })
      expect((await ui.find({ type: 'Text', text: '0 modified · 1 missing' }))?.props.color).toBe('error')
      expect(await ui.find({ type: 'Text', text: /stacks: github-workflow, orchestration/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /last refresh failed/ })).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: / available$/ })).toBeUndefined()
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

  test('a narrow pane folds each key onto one row of toned segments', async ($, on) => {
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
    expect(await ui.find({ type: 'Text', text: 'key' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'issue.confirmGate' }))?.props.color).toBe('warning')
    expect((await ui.find({ type: 'Text', text: /^  false$/ }))?.props).toMatchObject({ color: BRAND.caption, bold: true })
    expect(await ui.find({ type: 'Text', text: ' (lock: true)' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /^  local-overlay$/ }))?.props.color).toBe(BRAND.syrup)
    expect((await ui.find({ type: 'Text', text: '  on --confirm · off --yes' }))?.props).toMatchObject({ dimColor: true })
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

  test('after /standup the pane shows the agent roster in its order instead of an empty keys list (#610)', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.prompt.submit({ text: '/standup', ...TYPED })

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: ' · /standup' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Agents (2)' })).toBeDefined()
    const names = (await ui.findAll({ type: 'Text', text: /^(docs-agent|harness-architect)$/ })).map(node => node.text)
    expect(names).toEqual(['docs-agent', 'harness-architect'])
    expect(await ui.find({ type: 'Text', text: 'Agent-optimized documentation writer.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reads no behavioral key/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Keys / })).toBeUndefined()
    await ui.unmount()

    await $.prompt.submit({ text: '/issue 12', ...TYPED })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
    await ui.unmount()

    await $.prompt.submit({ text: 'back to normal', ...TYPED })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^Agents/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'Locks' })).toBeDefined()
    await ui.unmount()
  })

  test('a /standup that also reads a behavioral key shows both the roster and the keys (#610)', async ($, on) => {
    const reading: WaffleViewDoc = { ...DOC, skills: { ...DOC.skills, standup: { keys: ['issue.confirmGate'], files: [] } } }
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(reading)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.prompt.submit({ text: '/standup', ...TYPED })

    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Agents (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Keys (1)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'issue.confirmGate' })).toBeDefined()
    await ui.unmount()
  })

  test('a narrow /standup pane keeps the roster in served order, description on the name row (#610)', async ($, on) => {
    const unsorted: WaffleViewDoc = { ...DOC, agents: [...DOC.agents!].reverse() }
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(unsorted)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.prompt.submit({ text: '/standup', ...TYPED })

    const ui = await $.ui.mount({
      plugin: PANE,
      surface: 'terminal',
      component: 'Pane',
      requestId: PANE,
      props: { ...PANE_PROPS, bodyColumns: 60 },
    })
    const names = (await ui.findAll({ type: 'Text', text: /^(docs-agent|harness-architect)$/ })).map(node => node.text)
    expect(names).toEqual(['harness-architect', 'docs-agent'])
    expect(await ui.find({ type: 'Text', text: '  Expert in designing agent harnesses.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Expert in designing/ })).toBeUndefined()
    await ui.unmount()
  })

  test('/standup degrades: an empty roster and an older CLI each say so dim (#610)', async ($, on) => {
    const { agents: _omitted, ...older } = DOC
    let served: WaffleViewDoc = { ...DOC, agents: [] }
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(served)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'no installed agents to round up' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()

    served = older as WaffleViewDoc
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: /predates the agent roster/ }))?.props).toMatchObject({ dimColor: true })
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

  test('a clean render reads green; a diverged local lock reads as a warning', async ($, on) => {
    const clean: WaffleViewDoc = {
      ...DOC,
      drift: { ok: true, modified: [], missing: [], absentDocs: [], notes: [] },
      locks: { ...DOC.locks, local: { ...DOC.locks.committed, path: '.waffle/waffle.local.lock.json' }, tree: 'local', inSync: false },
    }
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(clean)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'clean — the render matches the lock' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: /DIVERGED from committed/ }))?.props.color).toBe('warning')
    await ui.unmount()
  })

  test('a newer release wears a Syrup badge in the headline and its remedy dim beneath (#608)', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify({ ...DOC, update: UPDATE })) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('ui.panes', () => ({ value: [] }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))

    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: ' · v0.18.0 available' }))?.props.color).toBe(BRAND.syrup)
    expect((await ui.find({ type: 'Text', text: UPDATE.command }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  })

  test('before any read the pane still wears the waffle and says so instead of drawing nothing', async $ => {
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'no state read yet' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: WAFFLE_GLYPH[1] })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'one batter, every repo' })).toBeDefined()
    await ui.unmount()
  })
})

describe('current focus (#698)', () => {
  test('resolveArgv appends --board on every path only when asked; wantsBoard reads /standup alone', () => {
    expect(resolveArgv({ hasLocalCli: true, hasLocalBin: false, board: true })).toEqual(['node', LOCAL_CLI, ...STATE_ARGS, '--board'])
    expect(resolveArgv({ hasLocalCli: false, hasLocalBin: true, board: true })).toEqual([LOCAL_BIN, ...STATE_ARGS, '--board'])
    expect(resolveArgv({ hasLocalCli: false, hasLocalBin: false, board: true }).slice(-3)).toEqual([...STATE_ARGS, '--board'])
    expect(resolveArgv({ hasLocalCli: true, hasLocalBin: false, board: false })).toEqual(['node', LOCAL_CLI, ...STATE_ARGS])
    expect(wantsBoard('standup')).toBe(true)
    expect(wantsBoard('issue')).toBe(false)
    expect(wantsBoard(null)).toBe(false)
  })

  test('selectBoard answers only for /standup; boardUnavailable covers absent and errored', () => {
    const withBoard = { ...DOC, board: BOARD }
    expect(selectBoard(withBoard, selectSlice(withBoard, { skill: 'standup' }))).toBe(BOARD)
    expect(selectBoard(withBoard, selectSlice(withBoard, { skill: 'issue' }))).toBeNull()
    expect(selectBoard(withBoard, null)).toBeNull()
    expect(selectBoard(DOC, selectSlice(DOC, { skill: 'standup' }))).toBeUndefined()
    expect(boardUnavailable(undefined)).toBe(true)
    expect(boardUnavailable({ ...BOARD, error: 'offline' })).toBe(true)
    expect(boardUnavailable(BOARD)).toBe(false)
  })

  test('formatDue, formatProgress and itemRef', () => {
    expect(formatDue('2026-11-01T00:00:00Z')).toBe('due 2026-11-01')
    expect(formatDue(null)).toBe('no due date')
    expect(formatProgress({ done: 2, total: 5 })).toBe('2 of 5')
    expect(itemRef({ number: 697, kind: 'issue' })).toBe('#697')
    expect(itemRef({ number: 704, kind: 'pr' })).toBe('PR #704')
    expect(itemRef({ number: null, kind: 'draft' })).toBe('draft')
  })

  test('boardHint names why the board lists are empty, or nothing', () => {
    expect(boardHint(BOARD)).toBeNull()
    expect(boardHint({ ...BOARD, projectName: null, project: null })).toMatch(/^set project\.name/)
    expect(boardHint({ ...BOARD, project: null, projectError: 'gh failed: missing required scopes [read:project]' })).toBe(
      'board lookup failed: gh failed: missing required scopes [read:project] — run gh auth refresh -s project',
    )
    expect(boardHint({ ...BOARD, project: null, projectError: 'timed out' })).toBe('board lookup failed: timed out')
    expect(boardHint({ ...BOARD, project: null })).toBe('no board titled "WaffleStack"')
  })

  test('boardFlagRejected spots an older CLI refusing the flag, nothing else', () => {
    expect(boardFlagRejected(exited(1, '', 'error: state takes no refs (got --board)\n'))).toBe(true)
    expect(boardFlagRejected(exited(1, '', 'error: no .waffle/waffle.yaml\n'))).toBe(false)
    expect(boardFlagRejected(exited(0, '{}', 'note: --board read from cache\n'))).toBe(false)
  })

  test('only a /standup read passes --board', async ($, on) => {
    const argvs: (readonly string[])[] = []
    on('fs.exists', () => ({ value: false }))
    on('process.run', (_$, e) => {
      argvs.push(e.argv)
      return { value: exited(0, JSON.stringify({ ...DOC, board: BOARD })) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    for (const text of ['plain', '/standup', '/issue 12', '/standup']) {
      await $.prompt.submit({ text, ...TYPED })
      await $.command.run({ command: PANE, args: '', ...COMPOSER })
    }
    expect(argvs.map(argv => argv.includes('--board'))).toEqual([false, true, false, true])
  })

  test('/standup shows milestones, epics and board items, wide and narrow', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', (_$, e) => ({ value: exited(0, JSON.stringify(e.argv.includes('--board') ? { ...DOC, board: BOARD } : DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    const headings = (await ui.findAll({ type: 'Text', text: /^(Current focus|Agents \(2\))$/ })).map(node => node.text)
    expect(headings).toEqual(['Current focus', 'Agents (2)'])
    for (const label of ['milestones', 'epics', 'in progress', 'in review']) {
      expect((await ui.find({ type: 'Text', text: label }))?.props).toMatchObject({ color: BRAND.caption })
    }
    expect((await ui.find({ type: 'Text', text: 'due 2026-11-01' }))?.props).toMatchObject({ color: BRAND.cream, bold: true })
    expect((await ui.find({ type: 'Text', text: 'v1.0' }))?.props).toMatchObject({ color: BRAND.caption })
    expect(await ui.find({ type: 'Text', text: 'no due date' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: '#610 · 2 of 5' }))?.props.color).toBe(BRAND.cream)
    expect((await ui.find({ type: 'Text', text: '#552 · 3 of 3' }))?.props.color).toBe('success')
    expect(await ui.find({ type: 'Text', text: '[epic] /standup' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ #697' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '◌ draft' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '⇄ PR #704' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'feat: read the board' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /board unavailable/ })).toBeUndefined()
    await ui.unmount()

    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns: 60 } })
    expect(await ui.find({ type: 'Text', text: '  v1.0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '  state --board' })).toBeDefined()
    await ui.unmount()
  })

  test('switching to /standup reads `reading board…` until the --board read lands, never board unavailable', async ($, on) => {
    let release: (() => void) | undefined
    on('fs.exists', () => ({ value: false }))
    on('process.run', async (_$, e) => {
      if (!e.argv.includes('--board')) return { value: exited(0, JSON.stringify(DOC)) }
      await new Promise<void>(resolve => (release = resolve))
      return { value: exited(0, JSON.stringify({ ...DOC, board: BOARD })) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: 'plain', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    await $.prompt.submit({ text: '/standup', ...TYPED })
    const pending = $.command.run({ command: PANE, args: '', ...COMPOSER })
    for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(release).toBeDefined()

    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'reading board…' }))?.props).toMatchObject({ dimColor: true })
    expect(await ui.find({ type: 'Text', text: /board unavailable/ })).toBeUndefined()
    await ui.unmount()

    release!()
    await pending
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'reading board…' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'v1.0' })).toBeDefined()
    await ui.unmount()
  })

  test('/standup submitted mid-read reads the board again, never board unavailable', async ($, on) => {
    const argvs: (readonly string[])[] = []
    let release: (() => void) | undefined
    let open = false
    on('fs.exists', () => ({ value: false }))
    on('process.run', async (_$, e) => {
      argvs.push(e.argv)
      if (e.argv.includes('--board')) return { value: exited(0, JSON.stringify({ ...DOC, board: BOARD })) }
      await new Promise<void>(resolve => (release = resolve))
      return { value: exited(0, JSON.stringify(DOC)) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: open ? [{ id: PANE, title: 'Waffle view', isShown: true, isFocused: false, isPlaced: true }] : [] }))

    await $.prompt.submit({ text: 'plain', ...TYPED })
    const pending = $.command.run({ command: PANE, args: '', ...COMPOSER })
    for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(release).toBeDefined()
    open = true
    await $.prompt.submit({ text: '/standup', ...TYPED })
    release!()
    await pending

    expect(argvs.map(argv => argv.includes('--board'))).toEqual([false, true])
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /board unavailable/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: 'v1.0' })).toBeDefined()
    await ui.unmount()
  })

  test('a plain prompt submitted mid --board read reads again without the flag', async ($, on) => {
    const argvs: (readonly string[])[] = []
    let release: (() => void) | undefined
    let open = false
    on('fs.exists', () => ({ value: false }))
    on('process.run', async (_$, e) => {
      argvs.push(e.argv)
      if (!e.argv.includes('--board')) return { value: exited(0, JSON.stringify(DOC)) }
      await new Promise<void>(resolve => (release = resolve))
      return { value: exited(0, JSON.stringify({ ...DOC, board: BOARD })) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: open ? [{ id: PANE, title: 'Waffle view', isShown: true, isFocused: false, isPlaced: true }] : [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    const pending = $.command.run({ command: PANE, args: '', ...COMPOSER })
    for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 0))
    expect(release).toBeDefined()
    open = true
    await $.prompt.submit({ text: 'plain', ...TYPED })
    release!()
    await pending

    expect(argvs.map(argv => argv.includes('--board'))).toEqual([true, false])
  })

  test('an empty board list shows a dim none', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify({ ...DOC, board: { ...BOARD, inReview: [] } })) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: '⇄ PR #704' })).toBeUndefined()
    expect((await ui.find({ type: 'Text', text: 'none' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  })

  test('a long list shows eight rows and a count', async ($, on) => {
    const many = Array.from({ length: 11 }, (_, i) => ({ number: 800 + i, title: `item ${i}`, kind: 'issue' as const }))
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify({ ...DOC, board: { ...BOARD, inProgress: many } })) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.findAll({ type: 'Text', text: /^○ #8\d\d$/ })).toHaveLength(8)
    expect((await ui.find({ type: 'Text', text: '… 3 more' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()
  })

  test('an errored board, an absent one and a CLI that rejects --board each read as board unavailable', async ($, on) => {
    const argvs: (readonly string[])[] = []
    let mode: 'error' | 'absent' | 'rejected' = 'error'
    on('fs.exists', () => ({ value: false }))
    on('process.run', (_$, e) => {
      argvs.push(e.argv)
      if (mode === 'rejected' && e.argv.includes('--board')) return { value: exited(1, '', 'error: state takes no refs (got --board)\n') }
      const errored = { ...BOARD, milestones: [], epics: [], inProgress: [], inReview: [], project: null, error: 'offline', source: null }
      return { value: exited(0, JSON.stringify(mode === 'error' ? { ...DOC, board: errored } : DOC)) }
    })
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'board unavailable: offline' }))?.props).toMatchObject({ dimColor: true })
    expect(await ui.find({ type: 'Text', text: 'milestones' })).toBeUndefined()
    await ui.unmount()

    mode = 'absent'
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect((await ui.find({ type: 'Text', text: 'board unavailable' }))?.props).toMatchObject({ dimColor: true })
    await ui.unmount()

    mode = 'rejected'
    argvs.length = 0
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    expect(argvs.map(argv => argv.includes('--board'))).toEqual([true, false])
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'board unavailable' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Agents (2)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /last refresh failed/ })).toBeUndefined()
    await ui.unmount()
  })

  test('a failed or unconfigured board lookup keeps milestones and epics and hints the fix', async ($, on) => {
    let board: WaffleViewBoard = { ...BOARD, project: null, inProgress: [], inReview: [], projectError: 'gh failed: missing required scopes [read:project]' }
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify({ ...DOC, board })) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'v1.0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '#610 · 2 of 5' })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: /gh auth refresh -s project$/ }))?.props).toMatchObject({ dimColor: true })
    expect(await ui.find({ type: 'Text', text: /board unavailable/ })).toBeUndefined()
    await ui.unmount()

    board = { ...BOARD, projectName: null, project: null, inProgress: [], inReview: [] }
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: /^set project\.name/ })).toBeDefined()
    await ui.unmount()
  })

  test('no Current focus outside /standup, even when the document carries a board', async ($, on) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify({ ...DOC, board: BOARD })) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [] }))

    await $.prompt.submit({ text: '/issue 12', ...TYPED })
    await $.command.run({ command: PANE, args: '', ...COMPOSER })
    let ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Current focus' })).toBeUndefined()
    await ui.unmount()

    await $.prompt.submit({ text: 'plain', ...TYPED })
    ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await ui.find({ type: 'Text', text: 'Current focus' })).toBeUndefined()
    await ui.unmount()
  })
})

describe('live wave (#699)', () => {
  const turn = (agentId: string | undefined, reason: 'answer' | 'error' | 'aborted' = 'answer') => ({
    answer: 'ok',
    durationMs: 1,
    isAborted: reason === 'aborted',
    turnId: `t-${agentId ?? 'main'}`,
    ...(agentId === undefined ? {} : { agentId }),
    reason,
  })

  test('a spawn runs, its answer is done, an error or abort failed; an unknown id changes nothing', () => {
    const running = waveSpawned(EMPTY_WAVE, 'docs-agent', 'a1')
    expect(running.byType).toEqual({ 'docs-agent': 'running' })
    expect(waveCompleted(running, 'a1', 'answer').byType).toEqual({ 'docs-agent': 'done' })
    expect(waveCompleted(running, 'a1', 'error').byType).toEqual({ 'docs-agent': 'failed' })
    expect(waveCompleted(running, 'a1', 'aborted').byType).toEqual({ 'docs-agent': 'failed' })
    expect(waveCompleted(running, 'other', 'answer')).toBe(running)
    expect(EMPTY_WAVE.byType).toEqual({})
  })

  test('each status wears its own glyph and tone; pending is dim', () => {
    expect(waveMarker(undefined)).toEqual({ glyph: '○', tone: { dimColor: true } })
    expect(waveMarker('running')).toEqual({ glyph: '◐', tone: { color: BRAND.syrup, bold: true } })
    expect(waveMarker('done')).toEqual({ glyph: '●', tone: { color: 'success' } })
    expect(waveMarker('failed')).toEqual({ glyph: '✗', tone: { color: 'error' } })
  })

  const stubCore = (on: Parameters<Parameters<typeof test>[1]>[1]) => {
    on('fs.exists', () => ({ value: false }))
    on('process.run', () => ({ value: exited(0, JSON.stringify(DOC)) }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('command.register', (_$, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({ text: '' }))
    on('prompt.submit', (_$, e) => ({ text: e.text }))
    on('ui.panes', () => ({ value: [{ id: PANE, title: 'Waffle view', isShown: true, isFocused: false, isPlaced: true }] }))
    on('agent.spawn', (_$, e) => ({ model: 'sonnet', agentId: `id-${e.subagentType}` }))
    on('turn.complete', (_$, e) => ({ text: e.answer }))
  }
  type Mounted = Awaited<ReturnType<Parameters<Parameters<typeof test>[1]>[0]['ui']['mount']>>
  const markers = async (ui: Mounted) =>
    (await ui.findAll({ type: 'Text', text: /^[○◐●✗] $/ })).map(node => node.text.trim())

  test('an open pane follows the wave live: pending, running, done, and the next /standup resets it', async ($, on) => {
    stubCore(on)
    await $.prompt.submit({ text: '/standup', ...TYPED })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await markers(ui)).toEqual(['○', '○'])
    expect((await ui.find({ type: 'Text', text: '○ ' }))?.props).toMatchObject({ dimColor: true })

    await $.agent.spawn({ prompt: 'p', subagentType: 'docs-agent' })
    expect(await markers(ui)).toEqual(['◐', '○'])
    expect((await ui.find({ type: 'Text', text: '◐ ' }))?.props.color).toBe(BRAND.syrup)

    await $.turn.complete(turn('id-docs-agent'))
    await $.agent.spawn({ prompt: 'p', subagentType: 'harness-architect' })
    await $.turn.complete(turn('id-harness-architect', 'error'))
    expect(await markers(ui)).toEqual(['●', '✗'])
    expect((await ui.find({ type: 'Text', text: '● ' }))?.props.color).toBe('success')
    expect((await ui.find({ type: 'Text', text: '✗ ' }))?.props.color).toBe('error')

    await $.command.run({ command: 'standup', args: '', ...COMPOSER })
    expect(await markers(ui)).toEqual(['○', '○'])
    await ui.unmount()
  })

  test('the marker sits beside the name, wide and narrow, leaving the name its own Text', async ($, on) => {
    stubCore(on)
    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.agent.spawn({ prompt: 'p', subagentType: 'docs-agent' })
    for (const bodyColumns of [PANE_PROPS.bodyColumns, 60]) {
      const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: { ...PANE_PROPS, bodyColumns } })
      expect(await markers(ui)).toEqual(['◐', '○'])
      const names = (await ui.findAll({ type: 'Text', text: /^(docs-agent|harness-architect)$/ })).map(node => node.text)
      expect(names).toEqual(['docs-agent', 'harness-architect'])
      await ui.unmount()
    }
  })

  test('a spawn before /standup and a main-loop turn leave the wave pending', async ($, on) => {
    stubCore(on)
    await $.prompt.submit({ text: '/issue 12', ...TYPED })
    await $.agent.spawn({ prompt: 'p', subagentType: 'docs-agent' })
    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.turn.complete(turn('id-docs-agent'))
    await $.turn.complete(turn(undefined))
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await markers(ui)).toEqual(['○', '○'])
    await ui.unmount()
  })

  test('a peer\'s /standup neither resets the wave nor arms it', async ($, on) => {
    stubCore(on)
    await $.prompt.submit({ text: '/standup', ...TYPED })
    await $.agent.spawn({ prompt: 'p', subagentType: 'docs-agent' })
    await $.prompt.submit({ text: '/standup', ...PEER })
    const ui = await $.ui.mount({ plugin: PANE, surface: 'terminal', component: 'Pane', requestId: PANE, props: PANE_PROPS })
    expect(await markers(ui)).toEqual(['◐', '○'])
    await ui.unmount()
  })
})
