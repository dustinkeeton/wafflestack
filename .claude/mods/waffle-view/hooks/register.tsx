import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderNode } from 'claude-code'

import type { WaffleViewDoc, WaffleViewKey, WaffleViewSlice } from '../types'
import {
  LOCAL_BIN,
  LOCAL_CLI,
  PANE,
  TITLE,
  formatMode,
  isOverridden,
  isPersonsPrompt,
  parseStateOutput,
  promptSkill,
  resolveArgv,
  selectKeys,
  selectSlice,
  tokensOf,
  valueLines,
} from './state'

const doc = atom({ plugin: 'waffle-view', key: 'doc' } as const, null)
const error = atom({ plugin: 'waffle-view', key: 'error' } as const, null)
const isRefreshing = atom({ plugin: 'waffle-view', key: 'isRefreshing' } as const, false)
// The last thing the person invoked (#563): `issue` after `/issue`, null after a plain prompt.
// Tracked whether or not the pane is open, so opening it after `/issue` already slices.
const skill = atom({ plugin: 'waffle-view', key: 'skill' } as const, null)

type Dollar = Pick<EngineInterface, 'state' | 'process' | 'fs' | 'ui'>

// The only read path: `wafflestack state --json --offline` through `$.process`. The last good
// document survives a failed refresh; the failure is shown beside it.
async function refresh($: Dollar): Promise<void> {
  if (await read($, isRefreshing)) return
  await update($, isRefreshing, () => true)
  try {
    const argv = resolveArgv({
      hasLocalCli: await $.fs.exists(LOCAL_CLI),
      hasLocalBin: await $.fs.exists(LOCAL_BIN),
    })
    const parsed = parseStateOutput(await $.process.run(argv, { timeoutMs: 120_000 }))
    if (parsed.doc) await update($, doc, () => parsed.doc)
    await update($, error, () => parsed.error)
  } catch (err) {
    await update($, error, () => (err instanceof Error ? err.message : String(err)))
  } finally {
    await update($, isRefreshing, () => false)
  }
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
    if (e.command !== PANE && isPersonsPrompt(e.origin)) await update($, skill, () => e.command)
    const ran = await next(e)
    if (e.command !== PANE && (await isOpen($))) void refresh($)

    return ran
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const invoked = promptSkill(e.text)
    if (invoked !== PANE && isPersonsPrompt(e.origin)) await update($, skill, () => invoked)
    const entered = await next(e)
    if (await isOpen($)) void refresh($)

    return entered
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId === undefined && (await isOpen($))) void refresh($)

    return done
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const state = await read($, doc)
    const failure = await read($, error)
    const busy = await read($, isRefreshing)
    const context = { skill: await read($, skill) }
    const slice = state ? selectSlice(state, context) : null
    const wide = e.props.bodyColumns >= 100

    const section = (title: string, rows: RenderNode[]) => (
      <Box flexDirection="column" marginBottom={1}>
        <Text bold underline>{title}</Text>
        {rows}
      </Box>
    )
    const dim = (text: string) => <Text dimColor>{text}</Text>

    const keyRow = (key: WaffleViewKey) => {
      const over = isOverridden(key)
      const value = formatMode(key.value) + (over ? ` (lock: ${formatMode(key.canonical)})` : '')
      const tokens = tokensOf(key)
      const style = over ? { color: 'warning' as const } : {}
      if (!wide) {
        return (
          <Text wrap="truncate-end" {...style}>
            {`${key.key}  ${value}  ${key.source}${tokens ? `  ${tokens}` : ''}`}
          </Text>
        )
      }

      return (
        <Box>
          <Box width={30}>
            <Text wrap="truncate-end">{key.key}</Text>
          </Box>
          <Box width={26}>
            <Text bold {...style}>{value}</Text>
          </Box>
          <Box width={16}>{dim(key.source)}</Box>
          <Text dimColor wrap="truncate-end">{tokens}</Text>
        </Box>
      )
    }

    const keysSection = (state: WaffleViewDoc) => {
      const keys = selectKeys(state, context)
      const header = wide ? (
        <Box>
          <Box width={30}>{dim('key')}</Box>
          <Box width={26}>{dim('value')}</Box>
          <Box width={16}>{dim('source')}</Box>
          {dim('tokens')}
        </Box>
      ) : null
      const rows: RenderNode[] =
        keys.length === 0
          ? [dim(slice ? `/${slice.skill} reads no behavioral key` : 'no behavioral keys in the selected stacks')]
          : keys.map(keyRow)

      return section(`Keys (${keys.length})`, header ? [header, ...rows] : rows)
    }

    // The other config a sliced skill reads: name, layer, and the value's lines.
    const configSection = ({ skill: name, config }: WaffleViewSlice) => {
      if (config.length === 0) return null
      const rows: RenderNode[] = config.flatMap(({ key, value, source }) => [
        <Box>
          <Text bold>{key}</Text>
          {dim(`  ${source}`)}
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
        <Text>
          {checkpoints.exists
            ? `delegate checkpoints: ${checkpoints.runs} run${checkpoints.runs === 1 ? '' : 's'} in ${checkpoints.path}`
            : `delegate checkpoints: none (${checkpoints.path})`}
        </Text>,
      ]
      if (latest) {
        rows.push(
          <Text {...(latest.parseError ? { color: 'error' as const } : {})}>
            {`  latest ${latest.runId} · phase ${latest.lastPhase ?? '—'} · ${latest.mtime}${latest.parseError ? ` · unreadable: ${latest.parseError}` : ''}`}
          </Text>,
        )
      }
      rows.push(
        <Text {...(memory.overCap ? { color: 'error' as const } : {})}>
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
        <Text>{`committed: ${describe(locks.committed)}`}</Text>,
        <Text {...(locks.inSync === false ? { color: 'warning' as const } : {})}>
          {`local: ${locks.local.present ? describe(locks.local) + sync : 'none'}`}
        </Text>,
      ])
    }

    const driftSection = ({ drift }: WaffleViewDoc) => {
      const rows: RenderNode[] = drift.ok
        ? [<Text color="success">clean — the render matches the lock</Text>]
        : [
            <Text color="error">{`${drift.modified.length} modified · ${drift.missing.length} missing`}</Text>,
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

    const heading = state ? (
      <Box marginBottom={1}>
        <Text bold>{`wafflestack ${state.cli.version}`}</Text>
        {dim(` (${state.cli.status}${state.cli.commit ? ` ${state.cli.commit.slice(0, 7)}` : ''})`)}
        {slice && <Text color="suggestion">{` · /${slice.skill}`}</Text>}
        {busy && dim(' · refreshing…')}
      </Box>
    ) : (
      <Box marginBottom={1}>
        <Text bold>wafflestack</Text>
        {dim(busy ? ' · reading state…' : ' · no state read yet')}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {heading}
        {failure && <Text color="error">{`last refresh failed: ${failure}`}</Text>}
        {state && !slice && projectSection(state)}
        {state && keysSection(state)}
        {slice && configSection(slice)}
        {state && runFilesSection(state)}
        {state && !slice && locksSection(state)}
        {state && !slice && driftSection(state)}
        {slice && dim(`sliced to what /${slice.skill} reads — a plain prompt restores the full view`)}
      </Box>
    )
  })
}
