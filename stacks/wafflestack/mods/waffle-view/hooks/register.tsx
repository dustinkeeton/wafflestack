import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { WaffleViewAgent, WaffleViewBoard, WaffleViewBoardItem, WaffleViewDoc, WaffleViewKey, WaffleViewSlice } from '../types'
import {
  BRAND,
  CAPTION_TONE,
  EMPTY_WAVE,
  EDITOR_TIMEOUT_MS,
  FOCUS_MAX_ROWS,
  HEADING_TONE,
  KIND_GLYPH,
  LOCAL_BIN,
  LOCAL_CLI,
  PANE,
  TAGLINE,
  TITLE,
  WAFFLE_GLYPH,
  boardFlagRejected,
  boardHint,
  boardUnavailable,
  editorArgv,
  editorLabel,
  editorLaunchError,
  formatDue,
  formatMode,
  formatProgress,
  isOverridden,
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
  STANDUP_SKILL,
  updateBadge,
  valueLines,
  valueTone,
  wantsBoard,
  waveClosed,
  waveCompleted,
  waveMarker,
  waveReset,
  waveSpawned,
} from './state'
import type { Tone } from './state'

const doc = atom({ plugin: 'waffle-view', key: 'doc' } as const, null)
const error = atom({ plugin: 'waffle-view', key: 'error' } as const, null)
const isRefreshing = atom({ plugin: 'waffle-view', key: 'isRefreshing' } as const, false)
// The last thing the person invoked (#563): `issue` after `/issue`, null after a plain prompt.
// Tracked whether or not the pane is open, so opening it after `/issue` already slices.
const skill = atom({ plugin: 'waffle-view', key: 'skill' } as const, null)
const launchError = atom({ plugin: 'waffle-view', key: 'launchError' } as const, null)
// The running /standup wave (#699): emptied by each typed /standup, filled by its spawns.
const wave = atom({ plugin: 'waffle-view', key: 'wave' } as const, EMPTY_WAVE)

type Dollar = Pick<EngineInterface, 'state' | 'process' | 'fs' | 'ui' | 'session'>

// The only read path: `wafflestack state --json` through `$.process`. The last good
// document survives a failed refresh; the failure is shown beside it.
async function refresh($: Dollar): Promise<void> {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    // A refresh dropped above may have switched to or from /standup: read again until --board matches.
    let board: boolean
    do {
      board = wantsBoard(await read($, skill))
      const probe = { hasLocalCli: await $.fs.exists(LOCAL_CLI), hasLocalBin: await $.fs.exists(LOCAL_BIN) }
      let output = await $.process.run(resolveArgv({ ...probe, board }), { timeoutMs: 120_000 })
      if (board && boardFlagRejected(output)) output = await $.process.run(resolveArgv(probe), { timeoutMs: 120_000 })
      const parsed = parseStateOutput(output)
      if (parsed.doc) await update($, doc, () => parsed.doc)
      await update($, error, () => parsed.error)
    } while (wantsBoard(await read($, skill)) !== board)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, isRefreshing, () => false)
  }
}

// The bottom Button (#616): the configured launcher on the session's directory. Inert until a
// state read lands — no document means no known editor. Never throws: any failure lands inline.
async function openEditor($: Dollar): Promise<void> {
  let launcher: string | null = null
  // `process.run` rejects both for a launcher that cannot start and one still running at the
  // timeout; only the elapsed time tells them apart.
  let started = 0
  let failure: string | null
  try {
    const state = await read($, doc)
    if (!state) return
    const argv = editorArgv(state, await $.session.cwd())
    launcher = argv[0]!
    started = Date.now()
    failure = editorLaunchError(launcher, { output: await $.process.run(argv, { timeoutMs: EDITOR_TIMEOUT_MS }) })
  } catch (err) {
    failure = launcher
      ? editorLaunchError(launcher, { thrown: err, timedOut: Date.now() - started >= EDITOR_TIMEOUT_MS })
      : err instanceof Error ? err.message : String(err)
  }
  await update($, launchError, () => failure)
}

const isOpen = async ($: Dollar) => (await $.ui.panes()).some(pane => pane.id === PANE)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: PANE,
      description: "Toggle the waffle view: this repo's resolved wafflestack state.",
    })

    return next(e)
  })

  // `/waffle-view` toggles: a second invocation closes the pane instead of re-opening it.
  on('command.run', { command: PANE }, async $ => {
    if (await isOpen($)) {
      await $.ui.close({ id: PANE })

      return { text: 'Waffle view pane closed.' }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    await refresh($)

    return { text: 'Waffle view pane opened.' }
  })

  on('command.run', async ($, e, next) => {
    if (e.command !== PANE && isPersonsPrompt(e.origin)) {
      await update($, skill, () => e.command)
      if (e.command === STANDUP_SKILL) await update($, wave, w => waveReset(w.queued))
    }
    const ran = await next(e)
    if (e.command !== PANE && (await isOpen($))) void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const invoked = promptSkill(e.text)
    if (invoked !== PANE && isPersonsPrompt(e.origin)) {
      await update($, skill, () => invoked)
      if (invoked === STANDUP_SKILL) await update($, wave, () => waveReset(e.turnId !== undefined))
    }
    const entered = await next(e)
    if (await isOpen($)) void refresh($)

    return entered
  }).catch(($, e, next) => next(e))

  // Observes only: the spawn always goes through, and only the main loop's spawns join the wave.
  on('agent.spawn', async ($, e, next) => {
    const inWave = e.parentAgentId === undefined && (await read($, skill)) === STANDUP_SKILL
    const started = await next(e)
    const { agentId } = started
    if (agentId !== undefined && inWave) {
      await update($, wave, w => waveSpawned(w, e.subagentType, agentId))
    }

    return started
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const { agentId } = e
    if (agentId !== undefined) await update($, wave, w => waveCompleted(w, agentId, e.reason))
    else {
      await update($, wave, waveClosed)
      if (await isOpen($)) void refresh($)
    }

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const state = await read($, doc)
    const failure = await read($, error)
    const launchFailure = await read($, launchError)
    const busy = await read($, isRefreshing)
    const context = { skill: await read($, skill) }
    const running = await read($, wave)
    const slice = state ? selectSlice(state, context) : null
    const agents = state ? selectAgents(state, slice) : null
    const board = state ? selectBoard(state, slice) : null
    // The roster replaces an empty keys list; a /standup that reads keys shows both.
    const showKeys = agents === null || (slice?.keys.length ?? 0) > 0
    const wide = e.props.bodyColumns >= 100

    const section = (title: string, rows: RenderNode[]) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text underline {...HEADING_TONE}>{title}</Text>
        {rows}
      </Box>
    )
    const dim = (text: string) => <Text dimColor>{text}</Text>
    const caption = (text: string) => <Text {...CAPTION_TONE}>{text}</Text>
    const lockNote = (key: WaffleViewKey) =>
      isOverridden(key) ? <Text color="warning">{` (lock: ${formatMode(key.canonical)})`}</Text> : null

    const keyRow = (key: WaffleViewKey) => {
      const tokens = tokensOf(key)
      if (!wide) {
        return (
          <Box>
            <Text {...keyTone(key)}>{key.key}</Text>
            <Text {...valueTone(key.value)}>{`  ${formatMode(key.value)}`}</Text>
            {lockNote(key)}
            <Text {...sourceTone(key.source)}>{`  ${key.source}`}</Text>
            {tokens && <Text wrap="truncate-end" {...CAPTION_TONE}>{`  ${tokens}`}</Text>}
          </Box>
        )
      }

      return (
        <Box>
          <Box width={30}>
            <Text wrap="truncate-end" {...keyTone(key)}>{key.key}</Text>
          </Box>
          <Box width={26}>
            <Text {...valueTone(key.value)}>{formatMode(key.value)}</Text>
            {lockNote(key)}
          </Box>
          <Box width={16}>
            <Text {...sourceTone(key.source)}>{key.source}</Text>
          </Box>
          <Text wrap="truncate-end" {...CAPTION_TONE}>{tokens}</Text>
        </Box>
      )
    }

    const keysSection = (state: WaffleViewDoc) => {
      const keys = selectKeys(state, context)
      const header = wide ? (
        <Box>
          <Box width={30}>{caption('key')}</Box>
          <Box width={26}>{caption('value')}</Box>
          <Box width={16}>{caption('source')}</Box>
          {caption('tokens')}
        </Box>
      ) : null
      const rows: RenderNode[] =
        keys.length === 0
          ? [dim(slice ? `/${slice.skill} reads no behavioral key` : 'no behavioral keys in the selected stacks')]
          : keys.map(keyRow)

      return section(`Keys (${keys.length})`, header ? [header, ...rows] : rows)
    }

    // A short lead (ref, progress, milestone) and its detail: a column when wide, one row when narrow.
    const focusRow = (lead: string, tone: Tone, detail: string) =>
      wide ? (
        <Box>
          <Box width={24}>
            <Text wrap="truncate-end" {...tone}>{lead}</Text>
          </Box>
          <Text wrap="truncate-end" {...CAPTION_TONE}>{detail}</Text>
        </Box>
      ) : (
        <Box>
          <Text {...tone}>{lead}</Text>
          <Text wrap="truncate-end" {...CAPTION_TONE}>{`  ${detail}`}</Text>
        </Box>
      )
    const focusBlock = <T,>(label: string, items: T[], row: (item: T) => RenderNode): RenderNode[] => {
      const shown = items.slice(0, FOCUS_MAX_ROWS).map(row)
      const more = items.length - FOCUS_MAX_ROWS
      return [caption(label), ...(items.length === 0 ? [dim('none')] : shown), ...(more > 0 ? [dim(`… ${more} more`)] : [])]
    }
    const LEAD: Tone = { color: BRAND.cream, bold: true }
    const itemRow = (item: WaffleViewBoardItem) => focusRow(`${KIND_GLYPH[item.kind]} ${itemRef(item)}`, LEAD, item.title)

    // What the team is working on (#698), from `state --board`.
    const focusSection = (board: WaffleViewBoard | undefined) => {
      if (board === undefined && busy) return section('Current focus', [dim('reading board…')])
      if (boardUnavailable(board)) return section('Current focus', [dim(`board unavailable${board?.error ? `: ${board.error}` : ''}`)])
      const { milestones, epics, inProgress, inReview } = board!
      const hint = boardHint(board!)
      const rows: RenderNode[] = [
        ...focusBlock('milestones', milestones, m => focusRow(formatDue(m.dueOn), LEAD, m.title)),
        ...focusBlock('epics', epics, epic =>
          focusRow(
            `#${epic.number} · ${formatProgress(epic)}`,
            epic.total > 0 && epic.done === epic.total ? { ...statusTone(true), bold: true } : LEAD,
            epic.title,
          ),
        ),
        ...(hint
          ? [caption('in progress · in review'), dim(hint)]
          : [...focusBlock('in progress', inProgress, itemRow), ...focusBlock('in review', inReview, itemRow)]),
      ]

      return section('Current focus', rows)
    }

    // The `/standup` roster (#610), in the order the skill spawns it.
    const agentsSection = (roster: WaffleViewAgent[] | undefined) => {
      if (roster === undefined) return section('Agents', [dim('this CLI predates the agent roster — upgrade wafflestack')])
      if (roster.length === 0) return section('Agents (0)', [dim('no installed agents to round up')])
      const marker = (agent: WaffleViewAgent) => {
        const { glyph, tone } = waveMarker(running.byType[agent.name])
        return <Text {...tone}>{`${glyph} `}</Text>
      }
      const rows: RenderNode[] = roster.map(agent =>
        wide ? (
          <Box>
            {marker(agent)}
            <Box width={22}>
              <Text bold wrap="truncate-end" color={BRAND.cream}>{agent.name}</Text>
            </Box>
            <Text wrap="truncate-end" {...CAPTION_TONE}>{agent.description}</Text>
          </Box>
        ) : (
          <Box>
            {marker(agent)}
            <Text bold color={BRAND.cream}>{agent.name}</Text>
            <Text wrap="truncate-end" {...CAPTION_TONE}>{`  ${agent.description}`}</Text>
          </Box>
        ),
      )

      return section(`Agents (${roster.length})`, rows)
    }

    // The other config a sliced skill reads: name, layer, and the value's lines.
    const configSection = ({ skill: name, config }: WaffleViewSlice) => {
      if (config.length === 0) return null
      const rows: RenderNode[] = config.flatMap(({ key, value, source }) => [
        <Box>
          <Text bold color={BRAND.cream}>{key}</Text>
          <Text {...sourceTone(source)}>{`  ${source}`}</Text>
        </Box>,
        ...valueLines(value).map(line => <Text wrap="truncate-end">{`  ${line}`}</Text>),
      ])

      return section(`Config /${name} reads (${config.length})`, rows)
    }

    // Sliced: only the files the skill writes, the delegate facts when they are among them, the
    // rest by path; nothing when it writes none. Full view: the delegate facts, as before.
    const runFilesSection = ({ runFiles: { delegate } }: WaffleViewDoc) => {
      if (slice && slice.files.length === 0) return null
      const sliced = slice ? new Set(slice.files) : null
      const delegateShown = delegate && (!sliced || sliced.has(delegate.checkpoints.path) || sliced.has(delegate.memory.path))
      if (!delegateShown) {
        if (!sliced) return section('Run files', [dim('delegate: not declared by a selected stack')])

        return section('Run files', [...sliced].map(file => <Text>{file}</Text>))
      }
      const { checkpoints, memory } = delegate
      const latest = checkpoints.latest
      const rows: RenderNode[] = [
        <Text {...(checkpoints.exists ? {} : { dimColor: true })}>
          {checkpoints.exists
            ? `delegate checkpoints: ${checkpoints.runs} run${checkpoints.runs === 1 ? '' : 's'} in ${checkpoints.path}`
            : `delegate checkpoints: none (${checkpoints.path})`}
        </Text>,
      ]
      if (latest) {
        rows.push(
          <Text {...statusTone(latest.parseError === null)}>
            {`  latest ${latest.runId} · phase ${latest.lastPhase ?? '—'} · ${latest.mtime}${latest.parseError ? ` · unreadable: ${latest.parseError}` : ''}`}
          </Text>,
        )
      }
      rows.push(
        <Text {...(memory.exists ? statusTone(!memory.overCap) : { dimColor: true })}>
          {memory.exists
            ? `delegate memory: ${memory.bytes}/${memory.maxBytes} bytes${memory.overCap ? ' — OVER CAP' : ''}`
            : `delegate memory: none (${memory.path})`}
        </Text>,
      )
      if (sliced) {
        const known = new Set([checkpoints.path, checkpoints.latest?.file, memory.path])
        for (const file of sliced) if (!known.has(file)) rows.push(<Text>{file}</Text>)
      }

      return section('Run files', rows)
    }

    const locksSection = ({ locks }: WaffleViewDoc) => {
      const describe = (lock: WaffleViewDoc['locks']['committed']) =>
        lock.present
          ? `toolkit ${lock.toolkitVersion ?? '?'} (${lock.toolkitStatus ?? '?'}${lock.toolkitRef ? `, ${lock.toolkitRef}` : ''}) · ${lock.files} files`
          : 'absent'
      const sync = locks.inSync === null ? '' : locks.inSync ? ' · in sync with committed' : ' · DIVERGED from committed'

      return section('Locks', [
        <Text>{`tree: ${locks.tree}`}</Text>,
        <Text {...(locks.committed.present ? {} : { color: 'warning' as const })}>{`committed: ${describe(locks.committed)}`}</Text>,
        <Text {...(locks.local.present ? statusTone(locks.inSync, 'warning') : { dimColor: true })}>
          {`local: ${locks.local.present ? describe(locks.local) + sync : 'none'}`}
        </Text>,
      ])
    }

    const driftSection = ({ drift }: WaffleViewDoc) => {
      const rows: RenderNode[] = drift.ok
        ? [<Text {...statusTone(true)}>clean — the render matches the lock</Text>]
        : [
            <Text {...statusTone(false)}>{`${drift.modified.length} modified · ${drift.missing.length} missing`}</Text>,
            ...drift.modified.slice(0, 5).map(file => dim(`  M ${file}`)),
            ...drift.missing.slice(0, 5).map(file => dim(`  ? ${file}`)),
          ]
      if (drift.absentDocs.length > 0) rows.push(dim(`${drift.absentDocs.length} generated .waffle/ docs absent (optional)`))

      return section('Drift', rows)
    }

    const projectSection = ({ project }: WaffleViewDoc) =>
      section('Project', [
        <Text>{`targets: ${project.targets.join(', ') || '—'}`}</Text>,
        <Text>{`stacks: ${project.stacks.join(', ') || '—'}`}</Text>,
        <Text wrap="truncate-end">{`include: ${project.include.length ? project.include.join(', ') : '—'}`}</Text>,
        <Text wrap="truncate-end">{`eject: ${project.eject.length ? project.eject.join(', ') : '—'}`}</Text>,
        dim(`local overlay: ${project.localOverlay ? 'yes' : 'no'}`),
        ...project.errors.map(problem => <Text color="error">{problem}</Text>),
      ])

    // The splash moment: the brand waffle, Golden, with the toolkit's name and version beside it.
    const badge = state ? updateBadge(state) : null
    const heading = (
      <Box marginBottom={1}>
        <Box flexDirection="column" marginRight={2}>
          {WAFFLE_GLYPH.map(row => <Text {...HEADING_TONE}>{row}</Text>)}
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text {...HEADING_TONE}>{state ? `wafflestack ${state.cli.version}` : 'wafflestack'}</Text>
            {state
              ? dim(` (${state.cli.status}${state.cli.commit ? ` ${state.cli.commit.slice(0, 7)}` : ''})`)
              : dim(busy ? ' · reading state…' : ' · no state read yet')}
            {badge && <Text color={BRAND.syrup}>{badge.label}</Text>}
            {slice && <Text color="suggestion">{` · /${slice.skill}`}</Text>}
            {state && busy && dim(' · refreshing…')}
          </Box>
          {badge?.command && dim(badge.command)}
          {caption(TAGLINE)}
        </Box>
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading}
        {failure && <Text color="error">{`last refresh failed: ${failure}`}</Text>}
        {state && !slice && projectSection(state)}
        {board !== null && focusSection(board)}
        {agents !== null && agentsSection(agents)}
        {state && showKeys && keysSection(state)}
        {slice && configSection(slice)}
        {state && runFilesSection(state)}
        {state && !slice && locksSection(state)}
        {state && !slice && driftSection(state)}
        {slice && caption(`sliced to what /${slice.skill} reads — a plain prompt restores the full view`)}
        {state && <Button key="open-editor" label={editorLabel(editorArgv(state, '')[0]!)} onPress={() => openEditor($)} />}
        {launchFailure && <Text color="error">{`open in editor failed: ${launchFailure}`}</Text>}
      </Box>
    )
  })
}
