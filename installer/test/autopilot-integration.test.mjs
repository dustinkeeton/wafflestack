import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';
import { loadToolkit } from '../lib/toolkit.mjs';
import { validateToolkit } from '../lib/validate.mjs';
import { makeResolver } from '../lib/project.mjs';

process.env.WAFFLESTACK_ALLOW_UNRELEASED = '1';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const SKILL = '.claude/skills/autopilot/SKILL.md';
const SOURCE = 'stacks/orchestration/skills/autopilot/SKILL.md';
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const section = (md, from, to) => md.slice(md.indexOf(from), md.indexOf(to, md.indexOf(from)));
const orchestration = () => loadToolkit(repoRoot).stacks.get('orchestration');

const projectYaml = (extra) => [
  'targets: [claude]',
  'include: [orchestration/skills/autopilot]',
  'config:',
  '  project:',
  '    name: Integ731',
  '  roster:',
  '    classificationTable: "| Signal | Agent |"',
  '    labelFallback: "| Label | Agent |"',
  '    rootFiles: package.json',
  '    sharedModule: lib/',
  '    moduleDependencies: none',
  '  audit:',
  '    complianceLabel: Integrity',
  '    complianceFrontmatterLabel: integrity',
  '    complianceTaskLabel: Integrity check',
  '    complianceAgentName: integrity',
  '    complianceDescription: Validates the thing.',
  '    compliancePrompt: Run the checks.',
  ...extra,
  '',
].join('\n');

// #731 (slice 1 of #720): integration mode routes run PRs into a per-run branch.
describe('autopilot.integration declaration and resolution (#731)', () => {
  let cwd;
  beforeEach(() => { cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-731-')); });
  afterEach(() => { fs.rmSync(cwd, { recursive: true, force: true }); });

  const renderWith = (value) => {
    fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), projectYaml(value === undefined ? [] : ['  autopilot:', `    integration: ${value}`]));
    const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
    const md = r.ok ? fs.readFileSync(path.join(cwd, SKILL), 'utf8') : '';
    return { r, md };
  };

  test('a two-mode routing key: default false, +/- tokens, no lock, no configModes, no nonInteractive', () => {
    const spec = orchestration().config['autopilot.integration'];
    assert.deepEqual(spec.modes, [true, false]);
    assert.equal(spec.default, false);
    assert.deepEqual(spec.flag, { on: '+integration', off: '-integration' });
    for (const field of ['lockMode', 'configModes', 'nonInteractive']) assert.equal(spec[field], undefined, field);
    assert.deepEqual(validateToolkit(repoRoot).filter((p) => /autopilot\.integration/.test(p)), []);
  });

  test('config may set it either way, and the render carries the value (default off)', () => {
    for (const [value, shown] of [[undefined, 'false'], ['true', 'true'], ['false', 'false']]) {
      const { r, md } = renderWith(value);
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      assert.ok(md.includes(`**Rendered value for this repo: \`${shown}\`**`), `${value} → ${shown}`);
    }
  });

  test('prompt is not one of its modes', () => {
    const { r } = renderWith('prompt');
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /\{\{autopilot\.integration\}\} is not one of its declared modes/.test(e)), JSON.stringify(r.errors));
  });

  test('the token placeholders resolve from the stack, never from project config', () => {
    const resolve = makeResolver(orchestration(), { autopilot: { integration: { flag: { on: '+smuggled' } } } }, 'claude');
    assert.equal(resolve('autopilot.integration.flag.on'), '+integration');
    assert.equal(resolve('autopilot.integration.flag.off'), '-integration');
  });

  test('the ruleset prerequisite is a recommend-level setting scoped to autopilot', () => {
    const p = orchestration().prerequisites.find((x) => x.name === 'integration-required-status-check');
    assert.ok(p, 'declared');
    assert.equal(p.kind, 'setting');
    assert.equal(p.level, 'recommend');
    assert.deepEqual(p.items, ['skills/autopilot']);
    assert.match(p.check, /rules\/branches\/autopilot\/integration\/.*required_status_checks/);
  });
});

describe('autopilot SKILL.md wires integration mode (#731)', () => {
  test('the source uses placeholders, never literal tokens; the render resolves them', () => {
    const src = read(SOURCE);
    for (const k of ['autopilot.integration', 'autopilot.integration.flag.on', 'autopilot.integration.flag.off']) {
      assert.ok(src.includes(`{{${k}}}`), k);
    }
    assert.doesNotMatch(src, /(?<!-)[+-]integration\b/);
    assert.doesNotMatch(read(SKILL), /\{\{autopilot\.integration/);
  });

  test('the argument hint advertises both tokens after +automerge and keeps the rubric adjacency', () => {
    const md = read(SKILL);
    assert.match(md, /argument-hint:.*\[\+automerge\] \[\+integration \| -integration\] \[\+qa/);
    assert.match(md, /argument-hint:.*\[\+audit \| -audit\] \[--rubric <key>=<n>,…\] — scope is REQUIRED/);
  });

  test('the contract subsection: token beats config, not a consent, final PR arms only on a green gate', () => {
    const md = section(read(SKILL), '### Integration mode', '## Integration branch');
    assert.match(md, /per-run token beats config, off by default/);
    assert.match(md, /A routing mode, not a consent/);
    assert.match(md, /\*\*Contradictions stop the run\.\*\*/);
    assert.match(md, /`\+integration` \| On for this run\./);
    assert.match(md, /The rendered value — never asked\./);
    assert.match(md, /\*\*The final PR arms only on a green integration gate\.\*\* The integration → `main` PR is armed only with `\+automerge`, only after every enabled stage passed, and never once a stage 2 or stage 3 fix PR merged/);
    assert.doesNotMatch(md, /never armed/);
  });

  test('the branch section: cut before Step 1, never fall back to main, no final PR while a run PR is open', () => {
    const md = section(read(SKILL), '## Integration branch', '## Per-issue loop');
    assert.match(md, /autopilot\/integration\/<UTC yyyymmdd-HHMMSS>/);
    assert.match(md, /`git push origin <sha>:refs\/heads\/<name>`/);
    assert.match(md, /never fall back to `main` silently/);
    assert.match(md, /`gh pr create --base <integ>`/);
    assert.match(md, /## Base branch/);
    assert.match(md, /First wait out every \*\*armed\*\* run PR, including the last serial one and each parallel-group PR/);
    assert.match(md, /Do not wait on unarmed PRs/);
    assert.match(md, /\*\*no run PR is still open against `<integ>`\*\*/);
    assert.match(md, /Delete the branch only when \*\*no run PR is open against `<integ>`\*\*/);
    assert.doesNotMatch(md, /If none merged and `origin\/<integ>` still equals the cut SHA, delete/);
    assert.match(md, /Item 4 decides whether it arms\./);
    assert.doesNotMatch(md, /\*\*Never arm it\*\* in this release/);
  });

  test('Steps 3, 4, 8, 9 and the guardrails carry the integration-mode rules', () => {
    const md = read(SKILL);
    assert.match(section(md, '### Step 3', '### Step 4'), /\*\*With integration mode on\*\*, `delegate\.autoMerge` is off for the delegate run even with every gate off/);
    assert.match(section(md, '### Step 4', '### Step 5'), /`gh pr view <pr> --json baseRefName -q \.baseRefName` must equal `<integ>`; if not, `gh pr edit <pr> --base <integ>`/);
    assert.match(section(md, '### Step 4', '### Step 5'), /arm here — `gh pr merge --auto --merge <pr>`, then on a successful arm label it `gh pr edit <pr> --add-label "waffle:auto-merged"`/);
    assert.match(section(md, '### Step 8', '### Step 9'), /`MERGED` means merged into `<integ>`/);
    assert.match(section(md, '### Step 9', '## End-of-run'), /\*\*Integration mode on:\*\* skip items 1 and 2/);
    const guard = section(md, '## Guardrails', '## Failure handling');
    assert.match(guard, /Its only direct pushes are creating its own integration branch/);
    assert.match(guard, /deleting the integration branch, either when nothing merged into it and no run PR is open against it/);
    assert.match(guard, /\*\*The integration → `main` PR arms only on a green integration gate\.\*\*/);
    assert.doesNotMatch(guard, /never armed in this release/);
    assert.match(guard, /Integration mode is a routing mode, not a consent, so config may set it\./);
  });
});

// #742: Step 8's serial wait ends as blocked on a conflicting, behind, closed or stalled PR.
describe('autopilot Step 8 merge wait ends on a blocked PR (#742)', () => {
  const step8 = () => section(read(SKILL), '### Step 8', '### Step 9');

  test('polls state and mergeStateStatus, not state alone', () => {
    const md = step8();
    assert.match(md, /gh pr view <pr> --json state,mergeStateStatus,autoMergeRequest   # poll until state is MERGED/);
    assert.doesNotMatch(md, /--json state -q \.state/);
  });

  test('DIRTY, BEHIND, CLOSED and a two-hour stall end the wait as blocked', () => {
    const md = step8();
    assert.match(md, /\*\*The wait also ends, as blocked,\*\* when the required-checks read prints `true`: a required check is in bucket `fail` or `cancel`, or in state `STARTUP_FAILURE` \(\*\*red check\*\*/);
    assert.match(md, /`mergeStateStatus` is `DIRTY` \(a conflict with its base/);
    assert.match(md, /`mergeStateStatus` is `BEHIND` \(the base requires up-to-date branches/);
    assert.match(md, /`state` is `CLOSED`/);
    assert.match(md, /has not merged two hours after arming \(\*\*stalled\*\*\)/);
    assert.match(md, /A red check is one failed attempt per \[Failure handling\]\(#failure-handling\), which disarms and closes the PR before the retry; `DIRTY`, `BEHIND`, `CLOSED`, disarmed and stalled are not, so they never enter the one-retry loop/);
    assert.match(md, /never merges by hand or with `--admin`/);
  });

  test('pending states keep polling and are absent from the stop clause', () => {
    const md = step8();
    assert.match(md, /so does any other `mergeStateStatus`: `BLOCKED` \(checks or reviews pending\), `UNSTABLE`, `HAS_HOOKS`, `CLEAN`, or `UNKNOWN`/);
    const stop = section(md, '**The wait also ends, as blocked,**', 'Decide from the read');
    for (const s of ['HAS_HOOKS', 'CLEAN', 'UNKNOWN']) assert.ok(!stop.includes(`\`${s}\``), s);
  });

  test('failure handling and the run report carry the blocked PR', () => {
    const md = read(SKILL);
    assert.match(section(md, '## Failure handling', '- **A QA round'), /conflicts with or falls behind its base, closes, is disarmed, or stalls in Step 8's wait/);
    const report = section(md, '## End-of-run housekeeping', '## Guardrails');
    assert.equal(report.match(/\*\*merge-blocked\*\*/g)?.length, 2);
  });
});

// #744: red check comes from required checks only, so a failing optional check never spends the retry.
describe('autopilot Step 8 red check reads required checks only (#744)', () => {
  const step8 = () => section(read(SKILL), '### Step 8', '### Step 9');

  test('red-ness comes from gh pr checks --required, not the rollup', () => {
    const md = step8();
    assert.ok(md.includes(`gh pr checks <pr> --required --json name,bucket,state -q 'any(.[]; .bucket == "fail" or .bucket == "cancel" or .state == "STARTUP_FAILURE")'`));
    assert.doesNotMatch(md, /statusCheckRollup/);
    assert.doesNotMatch(md, /red optional check/);
  });

  test('optional checks never end the wait; required check runs and commit statuses do', () => {
    const md = step8();
    assert.match(md, /optional checks never count, whether required checks are pending or done/);
    assert.match(md, /a required check is in bucket `fail` or `cancel`/);
    assert.match(md, /gh's checks list covers both check runs and commit statuses, `--required` follows GitHub's own required flag/);
  });

  test('state is read first, and empty or error output keeps polling under the stall bound', () => {
    const md = step8();
    assert.match(md, /Read `state` first: once it reads `MERGED`, run Step 9, whatever the checks read/);
    assert.ok(md.indexOf('Read `state` first') < md.indexOf('the required-checks read prints `true`'));
    assert.match(md, /Decide from the read's output, never its exit code\. Output `false` or nothing \(no required checks reported, or a `gh` error\) keeps the wait polling, bounded by the stall rule/);
  });
});

// #745: an infra-red required run is rerun once, and a red-check retry disarms and closes the PR first.
describe('autopilot Step 8 red-check rerun and retry (#745)', () => {
  const step8 = () => section(read(SKILL), '### Step 8', '### Step 9');
  const retry = () => section(read(SKILL), '- **A Step 8 red check with a retry left**', '- **Same issue fails twice');

  test('infra-red runs are rerun once by run id; failures and commit statuses are not', () => {
    const md = step8();
    assert.ok(md.includes(`gh pr checks <pr> --required --json bucket,state,link -q '.[] | select(.bucket == "fail" or .bucket == "cancel" or .state == "STARTUP_FAILURE") | "\\(.state) \\(.link)"'`));
    assert.match(md, /every line's state is `CANCELLED`, `TIMED_OUT` or `STARTUP_FAILURE` and every link holds an Actions run id/);
    assert.match(md, /run `gh run rerun <run-id>` once per distinct id and keep polling\. This happens once per PR, and the rerun does not reset the two-hour stall clock/);
    assert.match(md, /a `FAILURE`, `ERROR` or `ACTION_REQUIRED` line/);
    assert.match(md, /a line with no run id \(a commit status\), a rerun that errors, or a second red check after the rerun/);
    assert.match(md, /keep polling until `gh run view <run-id> --json status -q \.status` reads `completed` for each distinct id \(GitHub refuses to rerun a run whose other jobs are still going\), then run `gh run rerun <run-id>`/);
    assert.match(md, /a second red check after the rerun, counted only once `gh run view <run-id> --json status,attempt` reads `completed` at a higher `attempt` than the one rerun/);
  });

  test('a switched-off auto-merge ends the wait as disarmed, not a failed attempt', () => {
    const md = step8();
    assert.match(md, /`state` is `OPEN` with `autoMergeRequest` null \(\*\*disarmed\*\*/);
    assert.match(read(SKILL), /merge-blocked\*\* with its reason \(`DIRTY`, `BEHIND`, closed, disarmed, red check, or stalled\) \/ \*\*superseded\*\* by a retry PR/);
  });

  test('the retry disarms, then closes without deleting the branch', () => {
    const md = retry();
    assert.ok(md.indexOf('gh pr merge <pr> --disable-auto') < md.indexOf('gh pr close <pr>'));
    assert.match(md, /If the disarm fails or the PR is still armed, do not retry/);
    assert.match(md, /If `state` reads `MERGED`, the PR merged after all: run Step 9 and do not retry/);
    assert.match(md, /read `gh pr view <pr> --json state,autoMergeRequest` even if that command errored/);
    assert.ok(md.indexOf('the PR merged after all') < md.indexOf('If the disarm fails'));
    assert.match(md, /without `--delete-branch`/);
    assert.doesNotMatch(md, /`gh pr close[^`]*--delete-branch/);
  });

  test('the retry cuts a fresh branch from the current base and pauses dependents', () => {
    const md = retry();
    assert.match(md, /`<old-branch>-retry`, cut from the current base \(`origin\/main`, or `origin\/<integ>` in integration mode\)/);
    assert.match(md, /Never reuse the closed branch/);
    assert.match(md, /Record `<old-branch>-retry` as the issue's assignment `branch` in delegate's `plan` checkpoint/);
    assert.match(md, /they continue if its PR merges and stop if it fails/);
    assert.match(md, /`git push origin --delete <branch>`/);
  });
});

// #741: the final PR runs non-interactively, and the end-of-run wait stops where Step 8's does.
describe('autopilot integration final PR and end-of-run wait (#741)', () => {
  const branch = () => section(read(SKILL), '## Integration branch', '## Per-issue loop');

  test('the end-of-run wait polls like Step 8 and ends by its blocked rule, BEHIND included', () => {
    const md = branch();
    assert.match(md, /poll each with Step 8's two reads until `state` is `MERGED`/);
    assert.doesNotMatch(md, /statusCheckRollup` until/);
    assert.match(md, /ending the wait by Step 8's \*\*The wait also ends, as blocked,\*\* rule \(red check after its one infra rerun, `DIRTY`, `BEHIND`, closed, disarmed, or stalled\)/);
    assert.match(md, /a blocked PR stays open and is reported \*\*merge-blocked\*\*/);
    assert.doesNotMatch(md, /turns `DIRTY`/);
  });

  test('the final PR command carries --title, and so does every main-bound gh pr create', () => {
    const md = read(SKILL);
    assert.match(branch(), /gh pr create --base main --head <integ> --title "autopilot: integrate <integ> into main" --body-file <scratch-file>/);
    const creates = md.match(/gh pr create --base main[^\n`]*/g) ?? [];
    assert.ok(creates.length > 0);
    for (const c of creates) assert.match(c, /--title /, c);
  });
});

// #747 (slice A of #732): stage 1 syncs main into <integ> through a sync PR before the final PR opens.
describe('autopilot integration gate stage 1: sync PR (#747)', () => {
  const gate = () => section(read(SKILL), '### Integration gate — stage 1', '### Integration gate — stage 2');

  test('the sync merges origin/main into a sync branch off <integ>, in a gate worktree', () => {
    const md = gate();
    assert.match(md, /`git merge-base --is-ancestor origin\/main origin\/<integ>`/);
    assert.match(md, /`git worktree add --detach <gate> origin\/<integ>`/);
    assert.match(md, /git -C <gate> switch -c autopilot\/sync\/<ts>/);
    assert.match(md, /-C <gate> merge --no-ff origin\/main -m "chore\(autopilot\): sync main into <integ>"/);
    assert.match(md, /gh pr create --base <integ> --head autopilot\/sync\/<ts> --title "autopilot: sync main into <integ>" --body-file <scratch-file>/);
  });

  test('only a lock conflict is resolved (main\'s lock, then render); anything else aborts and holds', () => {
    const md = gate();
    assert.match(md, /\*\*Exactly `\.waffle\/waffle\.lock\.json`\*\*/);
    assert.match(md, /`git -C <gate> checkout --theirs -- \.waffle\/waffle\.lock\.json` and `git -C <gate> add \.waffle\/waffle\.lock\.json`, then, in `<gate>`, `npm install`\./);
    assert.match(md, /If `git -C <gate> diff --name-only` or `git -C <gate> ls-files --others --exclude-standard` prints anything, the install changed or created files.*abort and hold/);
    assert.match(md, /Otherwise, in `<gate>`, run `env WAFFLESTACK_ALLOW_UNRELEASED=1 node installer\/cli\.mjs render`, then `git -C <gate> add -A`/);
    assert.match(md, /If the re-rendered lock's `toolkitVersion` differs from the one in `git -C <gate> show origin\/main:\.waffle\/waffle\.lock\.json`, abort and hold/);
    assert.match(md, /-C <gate> commit --no-edit --cleanup=strip`/);
    assert.match(md, /`git -C <gate> merge --abort`/);
    assert.match(md, /Stop with a hold if `git ls-remote --heads origin autopilot\/sync\/<ts>` already shows the branch/);
    assert.match(md, /Leave `<integ>`, any pushed sync branch and any sync PR open/);
    assert.match(section(md, '- **Steps 2–3**', '- **Step 4, a check hold.**'), /Remove `<gate>` if it still exists \(`git worktree remove --force <gate>`\) and any local sync branch/);
    assert.match(md, /The run \*\*never picks a winner\*\*/);
    assert.match(md, /`gh issue create --label "waffle:manual-review" --body-file <scratch-file>`/);
  });

  test('the sync PR arms only with +automerge, waits by Step 8, and must land the synced tree', () => {
    const md = gate();
    assert.match(md, /5\. \*\*Open the sync PR\.\*\* Only when step 2 merged\./);
    assert.match(md, /Record the PR number it prints as `<S>`\./);
    assert.match(md, /6\. \*\*Merge it\.\*\* Only when step 5 opened a sync PR\. With `\+automerge`, arm it, `gh pr merge --auto --merge <S>`/);
    assert.match(md, /`git worktree remove <gate>`, and only when step 2 ran, `git branch -D autopilot\/sync\/<ts>`/);
    assert.match(md, /Wait by Step 8's \*\*The wait also ends, as blocked,\*\* rule/);
    assert.match(md, /Without the consent, or if arming fails, hold/);
    const step6 = section(md, '6. **Merge it.**', '7. ');
    assert.match(step6, /`gh pr merge --auto --merge <S>`, verify `gh pr view <S> --json autoMergeRequest -q '\.autoMergeRequest != null'` prints `true`, and only then label it `gh pr edit <S> --add-label/);
    assert.doesNotMatch(step6, /<S>`, then label it/);
    assert.match(md, /require `git diff --quiet <syncHead> origin\/<integ>`/);
    assert.match(md, /4\. \*\*Checks\.\*\* Stage 1's mechanical checks run here, in `<gate>`, before anything is pushed\./);
    assert.ok(md.indexOf('4. **Checks.**') < md.indexOf('5. **Open the sync PR.**'));
  });

  test('#752: a step-4 check hold keeps <gate> and the sync branch and names the resume commands', () => {
    const hold = section(gate(), '- **Step 4, a check hold.**', '- **Steps 5–6**');
    assert.match(hold, /Nothing is pushed yet, so \*\*keep\*\* `<gate>` and the local `autopilot\/sync\/<ts>` branch/);
    assert.match(hold, /`git -C <gate> push -u origin autopilot\/sync\/<ts>`, step 5's `gh pr create`, and merge that PR/);
    assert.match(hold, /`git worktree remove --force <gate>`, `git branch -D autopilot\/sync\/<ts>` if it exists, and item 3's `gh pr create`/);
    assert.match(hold, /land it as a PR into `<integ>`, remove `<gate>` and the local sync branch the same way, and re-run stage 1 from step 1/);
    assert.doesNotMatch(gate(), /resolve or merge the sync, then item 3/);
    assert.match(section(read(SKILL), '## Failure handling', 'At the end, the report'), /A check hold keeps `<gate>` and the local sync branch/);
  });

  test('item 3 runs the gate before the final PR; the body and report carry the sync and the hold', () => {
    const md = read(SKILL);
    const branch = section(md, '## Integration branch', '### Integration gate — stage 1');
    assert.match(branch, /run \[Integration gate — stage 1\]\(#integration-gate--stage-1-mechanical-no-llm\) below, and open the final PR only when it passes/);
    assert.match(branch, /`Synced with main at <M> via #S`/);
    assert.match(branch, /integration gate stages 2–3 run on this PR; their outcomes are in the run report — review the combined change/);
    assert.doesNotMatch(md, /"integration gate not yet implemented/);
    assert.match(gate(), /Do not open it, not even as a draft/);
    assert.match(section(md, '## Failure handling', 'At the end, the report'), /\*\*Integration gate stage 1 held\*\*.*\*\*integration-held\*\*/);
    assert.match(section(md, '## End-of-run housekeeping', '## Guardrails'), /\*\*integration-held\*\* with the reason, the follow-up, and the exact commands/);
  });

  test('the contract, mandate and guardrails cover the sync PR', () => {
    const md = read(SKILL);
    assert.match(section(md, '### Integration mode', '## Integration branch'), /the run also arms its \*\*sync PR\*\* into `<integ>`.*It carries no issue, so the QA, review and audit gates skip it/);
    assert.match(md, /whether the run may arm its sync PR into it \(only with auto-merge consented\)/);
    const guard = section(md, '## Guardrails', '## Failure handling');
    assert.match(guard, /pushing its own `autopilot\/sync\/<ts>` branch/);
    assert.match(guard, /\*\*`main` reaches `<integ>` only through the sync PR\.\*\*/);
  });

  test('waffleCmd defaults to npx over waffle.toolkitRef\'s value; the re-declared twins match their stacks', () => {
    const stacks = loadToolkit(repoRoot).stacks;
    const orch = stacks.get('orchestration').config;
    assert.equal(orch['autopilot.waffleCmd'].default, 'npx --yes {{waffle.toolkitRef}}');
    const gw = stacks.get('github-workflow').config['project.installCmd'];
    for (const field of ['required', 'default', 'pattern']) assert.deepEqual(orch['project.installCmd'][field], gw[field], field);
    const ws = stacks.get('wafflestack').config['waffle.toolkitRef'];
    for (const field of ['required', 'default', 'pattern']) assert.deepEqual(orch['waffle.toolkitRef'][field], ws[field], field);
    assert.deepEqual(validateToolkit(repoRoot).filter((p) => /waffleCmd|installCmd|toolkitRef/.test(p)), []);
  });

  test('a consumer render resolves the default waffleCmd to the pinned toolkit', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-747-'));
    try {
      fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), projectYaml([]));
      const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const md = fs.readFileSync(path.join(cwd, SKILL), 'utf8');
      assert.ok(md.includes('`npx --yes github:dustinkeeton/wafflestack#v0.0.test render`'));
      assert.doesNotMatch(md, /\{\{(autopilot\.waffleCmd|project\.installCmd|waffle\.toolkitRef)\}\}/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('a fork toolkitRef drives the default waffleCmd (#750)', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'project-750-'));
    try {
      fs.mkdirSync(path.join(cwd, '.waffle'), { recursive: true });
      fs.writeFileSync(path.join(cwd, '.waffle/waffle.yaml'), projectYaml(['  waffle:', '    toolkitRef: github:fork/wafflestack#v9.9.9']));
      const r = renderProject({ toolkitRoot: repoRoot, cwd, toolkitVersion: '0.0.test' });
      assert.equal(r.ok, true, JSON.stringify(r.errors));
      const md = fs.readFileSync(path.join(cwd, SKILL), 'utf8');
      assert.ok(md.includes('`npx --yes github:fork/wafflestack#v9.9.9 render`'));
      assert.ok(!md.includes('github:dustinkeeton/wafflestack'));
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// #733 (part of #720): stage 2 is adversarial-review's integration mode, run on the final PR.
describe('integration gate stage 2: decision-preservation review (#733)', () => {
  const AR = '.claude/skills/adversarial-review/SKILL.md';
  const mode = () => section(read(AR), '## Integration mode', '## 2. Read the full diff');
  const stage2 = () => section(read(SKILL), '### Integration gate — stage 2', '### Integration gate — stage 3');

  test('adversarial-review advertises --integration and resolves it before the PR', () => {
    const md = read(AR);
    assert.match(md, /argument-hint: "<PR#, number, or PR URL> \[--integration\]/);
    assert.match(section(md, '## 1. Resolve the target PR', '## Integration mode'), /If one whole argument is `--integration`, remove it/);
  });

  test('the mode reads three inputs, asks one question, and posts only cited findings', () => {
    const md = mode();
    assert.match(md, /gh pr list --base <integ> --state merged/);
    assert.match(md, /gh issue view <N> --json number,title,body/);
    assert.match(md, /contents\/DECISIONS\.md\?ref=\$HEAD_SHA/);
    assert.match(md, /\*Does the combined change contradict a recorded decision, or does one PR in the\s+run undo another's stated intent\?\*/);
    assert.match(md, /\*\*A finding counts only if it cites\*\*/);
    assert.match(md, /\*\*No nit tier\.\*\*/);
    assert.match(md, /Never seed history from the PR/);
    assert.match(md, /Sections 5–7 still apply/);
  });

  test('stage 2 sits between stage 1 and the per-issue loop, and item 3 runs it', () => {
    const md = read(SKILL);
    const at = md.indexOf('### Integration gate — stage 2');
    assert.ok(at > md.indexOf('### Integration gate — stage 1') && at < md.indexOf('## Per-issue loop'));
    assert.match(section(md, '## Integration branch', '### Integration gate — stage 1'), /run \[Integration gate — stage 2\]\(#integration-gate--stage-2-decision-preservation-review\) on it/);
  });

  test('stage 2 rides review-loop consent and runs cold, capped rounds', () => {
    const md = stage2();
    assert.match(md, /It rides the review loop's consent \(§3\)/);
    assert.match(md, /`stage 2: not run \(review loop off\)`/);
    assert.match(md, /`min\(2, the run's effective review cap\)`/);
    assert.match(md, /`adversarial-review <F> --integration`/);
    assert.match(md, /\*\*this pass is deliberately cold — do not seed history from the PR\*\*/);
    assert.match(md, /`pr-response <F> --yes --rubric <spec>`/);
    assert.match(md, /`triaged-through`/);
  });

  test('convergence: pass on a 0-implemented round, hold when the cap ends on fixes, tear down the responder', () => {
    const md = stage2();
    assert.match(md, /\*\*Passed\?\*\* The responder implemented 0/);
    assert.match(md, /\*\*Cap reached\.\*\* If the last round still implemented fixes, hold/);
    assert.match(md, /`TaskStop` `respond-int-pr<F>`/);
    assert.match(md, /\*\*No fix PR\?\*\* The responder implemented 0, but a review on `<sha>` still reads untriaged/);
    assert.match(md, /If it left a review untriaged, hold/);
    assert.match(md, /\*\*No fix PR reported\?\*\* The responder implemented fixes but reported no `<P>`, or `origin\/<integ>` no longer equals `<sha>`: hold/);
    assert.match(md, /merges on CI alone, unreviewed for correctness, so item 4 then leaves `<F>` for a human/);
    assert.doesNotMatch(md, /is its review/);
  });

  test('fixes arrive through a fix PR into <integ>, never a push; stage 2 never arms the final PR', () => {
    const md = stage2();
    assert.match(md, /## Fix branch/);
    assert.match(md, /gh pr create --base <integ> --head autopilot\/stage2\/<ts>-r<k> --title /);
    assert.doesNotMatch(md, /git push[^\n]*<integ>/);
    assert.match(md, /\*\*Do not arm `<F>` here\*\*; item 4 decides/);
    assert.match(md, /\*\*integration-held\*\*/);
    assert.match(md, /`gh pr merge --auto --merge <P>`, verify `gh pr view <P> --json autoMergeRequest -q '\.autoMergeRequest != null'` prints `true`, and only then label it `gh pr edit <P> --add-label/);
    assert.match(read('.claude/skills/pr-response/SKILL.md'), /\*\*A `## Fix branch` block in your invocation overrides items 1 and 6\.\*\*/);
  });

  test('guardrails, failure handling and the run report carry stage 2', () => {
    const md = read(SKILL);
    assert.match(section(md, '## Guardrails', '## Failure handling'), /\*\*Stage 2 never pushes to `<integ>`\.\*\*/);
    assert.match(section(md, '## Failure handling', 'At the end, the report'), /\*\*Integration gate stage 2 held\*\*/);
    assert.match(section(md, '## End-of-run housekeeping', '## Guardrails'), /the stage 2 outcome \(passed \/ \*\*integration-held\*\*/);
    assert.match(section(md, '### Rubric override', '### Integration mode'), /integration stage 2's `respond-int-pr<N>`/);
  });
});

// #734 (part of #720): with integration mode, the audit gate runs once, as stage 3 on the final PR.
describe('integration gate stage 3: the audit moves to the final PR (#734)', () => {
  const stage3 = () => section(read(SKILL), '### Integration gate — stage 3', '## Per-issue loop');

  test('stage 3 follows stage 2, item 3 runs it, and the body no longer says it is missing', () => {
    const md = read(SKILL);
    const at = md.indexOf('### Integration gate — stage 3 (audit)');
    assert.ok(at > md.indexOf('### Integration gate — stage 2') && at < md.indexOf('## Per-issue loop'));
    assert.match(section(md, '## Integration branch', '### Integration gate — stage 1'), /on it, then \[stage 3\]\(#integration-gate--stage-3-audit\)/);
    assert.doesNotMatch(md, /[Ss]tage 3 (is )?not yet implemented/);
  });

  test('it rides audit-step consent, skips after a stage 2 hold, and waits with Step 8 exits', () => {
    const md = stage3();
    assert.match(md, /It rides audit-step consent \(§4\)/);
    assert.match(md, /`stage 3: not run \(audit step off\)`/);
    assert.match(md, /`stage 3: not run \(stage 2 held\)`/);
    assert.match(md, /Step 8's blocked exits end the wait as a hold/);
    assert.match(md, /`DIRTY`/);
    assert.match(md, /no green two hours after the wait began/);
  });

  test('the chain runs in its own worktree over the combined diff, with an owned teardown', () => {
    const md = stage3();
    assert.match(md, /git diff --name-only origin\/main\.\.\.origin\/<integ>/);
    assert.match(md, /`git worktree add -b <b3> <a3> origin\/<integ>`/);
    assert.match(md, /`<b3>` is its branch, `autopilot\/stage3\/<ts>`/);
    assert.match(md, /## Working tree/);
    assert.match(md, /an agent edited outside `<a3>`/);
    assert.match(md, /`shutdown_request` each audit agent and then `TaskStop` each one, even if a pass errors/);
    assert.match(md, /Its `docs` invocation is the run's one docs refresh, over the combined diff/);
    assert.match(md, /next to the focus in each prompt that skill spawns/);
    assert.match(md, /keep `<a3>` and `<b3>` \(skip the Stage 3 hold's removal\)/);
    assert.match(md, /`git worktree remove --force <a3>` and `git branch -D <b3>`, retry once/);
  });

  test('a stage 2 hold hands over the audit stage 3 never ran', () => {
    const hold = section(read(SKILL), '**Stage 2 hold.**', '### Integration gate — stage 3');
    assert.match(hold, /with audit-step consent on, run `\/audit` with `git diff --name-only origin\/main\.\.\.origin\/<integ>` as its focus/);
  });

  test('every green wait reads a commit status by its state, so stage 2 statuses can go green', () => {
    const md = read(SKILL);
    const polls = md.match(/gh pr view <pr> --json statusCheckRollup -q '[^']*'/g);
    assert.equal(polls.length, 3);
    for (const poll of polls) {
      assert.doesNotMatch(poll, /\[\.statusCheckRollup\[\]\.conclusion\]/);
      assert.equal(poll.match(/\[\.statusCheckRollup\[\] \| \.conclusion \/\/ \.state\]/g).length, 2);
    }
    assert.equal(md.match(/a `waffle\/\*` commit status has no `conclusion`, so the poll reads its `state`; `ERROR` is red/g).length, 3);
  });

  test('fixes land through a fix PR into <integ>; a hard block holds with a manual-review follow-up', () => {
    const md = stage3();
    assert.match(md, /gh pr create --base <integ> --head <b3> --title "autopilot: stage-3 audit fixes for <integ>" --body-file <scratch-file>/);
    assert.match(md, /require `git diff --quiet <fixHead> origin\/<integ>`/);
    assert.match(md, /Wait by Step 8's \*\*The wait also ends, as blocked,\*\* rule/);
    assert.match(md, /triage unresolved audit findings on integration PR #<F>/);
    assert.match(md, /--add-label "waffle:manual-review"/);
    assert.match(md, /\*\*audit-blocked\*\*/);
    assert.match(md, /\*\*integration-held\*\*/);
    assert.match(md, /`gh pr merge --auto --merge <A>`, verify `gh pr view <A> --json autoMergeRequest -q '\.autoMergeRequest != null'` prints `true`, and only then label it `gh pr edit <A> --add-label/);
    assert.match(md, /\*\*Do not arm `<F>` here\*\*; item 4 decides/);
    assert.doesNotMatch(md, /git push[^\n]*<integ>/);
    assert.doesNotMatch(md, /severity floor/);
  });

  test('per PR, the audit gate is off in integration mode; docsRefresh reads consent', () => {
    const md = read(SKILL);
    assert.match(section(md, '### 4. Audit-step consent', '### 5. QA-gate consent'), /\*\*With integration mode on, the audit gate moves to the final PR\.\*\*.*\*\*per-PR audit gate\*\*/);
    assert.match(section(md, '### 4. Audit-step consent', '### 5. QA-gate consent'), /Wherever §3, §5 and Steps 3–8 say "the audit step is on" or "off"/);
    assert.match(section(md, '### Step 7', '### Step 8'), /\*\*only when audit-step consent is on\*\* \(§4\) \*\*and integration mode is off\*\*/);
    const step3 = section(md, '### Step 3', '### Step 4');
    assert.match(step3, /This rule reads audit-step \*\*consent\*\*, not the per-PR gate/);
    assert.match(step3, /In integration mode the audit step is off per PR \(§4\)/);
    assert.match(section(md, '### Step 4', '### Step 5'), /With every per-PR gate off \(the audit gate is not one in this mode, §4\)/);
  });

  test('guardrails, failure handling and the run report carry stage 3', () => {
    const md = read(SKILL);
    const guard = section(md, '## Guardrails', '## Failure handling');
    assert.match(guard, /\*\*Stage 3 never pushes to `<integ>`\.\*\*/);
    assert.match(guard, /pushing its own `autopilot\/sync\/<ts>` branch and its own `autopilot\/stage3\/<ts>` branch/);
    assert.match(section(md, '## Failure handling', 'At the end, the report'), /\*\*Integration gate stage 3 held\*\*/);
    assert.match(section(md, '## End-of-run housekeeping', '## Guardrails'), /the stage 3 outcome \(passed \/ \*\*integration-held\*\*/);
  });
});

// #735 (last slice of #720): the final PR arms only on a green integration gate, then closes out.
describe('integration final PR: arm on a green gate, then close out (#735)', () => {
  const branch = () => section(read(SKILL), '## Integration branch', '### Integration gate — stage 1');
  const arm = () => section(read(SKILL), '4. **Arm it only on a green gate.**', '5. **After it merges, close out.**');
  const close = () => section(read(SKILL), '5. **After it merges, close out.**', '### Integration gate — stage 1');

  test('items 4 and 5 follow item 3, inside the branch section', () => {
    const md = branch();
    const [i3, i4, i5] = ['3. **Open the final PR', '4. **Arm it only on a green gate.**', '5. **After it merges, close out.**'].map((s) => md.indexOf(s));
    assert.ok(i3 > -1 && i3 < i4 && i4 < i5, `${i3} ${i4} ${i5}`);
    assert.doesNotMatch(md, /4\. \*\*Leave the branch\.\*\*/);
  });

  test('arms only with consent, after every enabled stage, on the passed head', () => {
    const md = arm();
    assert.match(md, /Without `\+automerge`, leave it for a human/);
    assert.match(md, /A stage not run because its consent is off does not block; a held stage does/);
    assert.match(md, /`gh pr view <F> --json headRefOid -q \.headRefOid` must equal `origin\/<integ>`, and both must equal `<stage1Head>`, the head stage 1 passed on/);
    assert.match(md, /`git merge-base --is-ancestor origin\/main <stage1Head>` must succeed; otherwise report \*\*not armed — `main` moved since the sync/);
    assert.match(close(), /If its merged `headRefOid` is not `<stage1Head>`, report `<F>` \*\*merged past the gate\*\*/);
    assert.match(read(SKILL), /Record the head stage 1 passed on as `<stage1Head>`: `origin\/<integ>` as step 6 fetched it, or `<gateHead>` when no sync was needed/);
    assert.match(md, /`gh pr list --base <integ> --state open` must print nothing/);
    assert.match(md, /`gh pr merge --auto --merge --match-head-commit <stage1Head> <F>`, on a successful arm `gh pr edit <F> --add-label "waffle:auto-merged"`/);
    assert.match(md, /\.autoMergeRequest != null/);
    assert.match(md, /never `--admin`, never an immediate merge/);
    assert.match(md, /Wait by Step 8's \*\*The wait also ends, as blocked,\*\* rule/);
    assert.doesNotMatch(md, /gh pr merge[^`\n]*--admin/);
  });

  test('a merged stage 2 or stage 3 fix PR leaves the final PR for a human', () => {
    const md = arm();
    assert.match(md, /\*\*No fix PR merged\.\*\* No stage 2 fix PR \(`autopilot\/stage2\/<ts>-r<k>`\) and no stage 3 fix PR \(`autopilot\/stage3\/<ts>\[-r2\]`\) merged into `<integ>`/);
    assert.match(md, /\*\*not armed — fix PR #P merged unreviewed\*\*/);
    assert.match(md, /The sync PR is exempt/);
    const guard = section(read(SKILL), '## Guardrails', '## Failure handling');
    assert.match(guard, /\*\*Never once a stage 2 or stage 3 fix PR merged:\*\*/);
  });

  test('a stage 2 pass must carry its waffle/adversarial-review success status (#754)', () => {
    const md = arm();
    assert.match(md, /\*\*Stage 2's review landed\.\*\* When stage 2 passed, that head carries a `waffle\/adversarial-review` success status/);
    assert.match(md, /gh api "repos\/\$OWNER\/\$REPO\/commits\/<head>\/statuses" --paginate/);
    assert.match(md, /A count of 0, or a query that errors, is reported as \*\*not armed — no `waffle\/adversarial-review` success status on `<head>`\*\*/);
    assert.doesNotMatch(md, /means the review never posted/);
  });

  test('stage 2 writes a denied reviewer status itself, only after reading the review back', () => {
    const md = section(read(SKILL), '### Integration gate — stage 2', '### Integration gate — stage 3');
    assert.match(md, /It returns its review id and whether its `waffle\/adversarial-review` status write succeeded/);
    assert.match(md, /when its `commit_id` is `<sha>` and its body begins with the adversarial-review marker, write that status on `<sha>` yourself/);
  });

  test('after MERGED: Step 9 for every closed issue, then a probe-verified branch delete', () => {
    const md = close();
    assert.match(md, /Only once `<F>` reads `MERGED`/);
    assert.match(md, /closingIssuesReferences/);
    assert.match(md, /`git ls-remote --exit-code --heads origin <integ>`\. Exit 2 means the repo's auto-delete already removed it/);
    assert.match(md, /`git push origin --delete <integ>`, then probe again and require exit 2/);
    assert.match(md, /\*\*left open\*\*/);
    assert.match(md, /`clean-up git --yes`/);
  });

  test('Steps 8 and 9, the report, guardrails and failure handling carry the arm', () => {
    const md = read(SKILL);
    assert.match(section(md, '### Step 8', '### Step 9'), /except in the final PR's wait/);
    assert.match(section(md, '### Step 9', '## End-of-run'), /items 1 and 2 run once, for every issue that PR closes, after it merges/);
    const report = section(md, '## End-of-run housekeeping', '## Guardrails');
    assert.match(report, /the final PR's arm outcome/);
    assert.match(report, /\*\*left open\*\* with the reason and the command/);
    const guard = section(md, '## Guardrails', '## Failure handling');
    assert.match(guard, /or once the final PR has merged into `main`\./);
    assert.doesNotMatch(guard, /deleting it/);
    const fail = section(md, '## Failure handling', 'At the end, the report');
    assert.match(fail, /\*\*The final PR was not armed, or its wait ended blocked\*\*/);
    assert.match(fail, /\*\*`<integ>` survived the final merge\*\*/);
    assert.doesNotMatch(read(SOURCE), /one unarmed integration/);
  });
});
