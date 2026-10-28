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

// #731 (slice 1 of #720): integration mode routes run PRs into a per-run branch; the final PR is never armed.
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

  test('the contract subsection: token beats config, not a consent, final PR never armed', () => {
    const md = section(read(SKILL), '### Integration mode', '## Integration branch');
    assert.match(md, /per-run token beats config, off by default/);
    assert.match(md, /A routing mode, not a consent/);
    assert.match(md, /\*\*Contradictions stop the run\.\*\*/);
    assert.match(md, /`\+integration` \| On for this run\./);
    assert.match(md, /The rendered value — never asked\./);
    assert.match(md, /The integration → `main` PR is \*\*never armed\*\*, even with `\+automerge`/);
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
    assert.match(md, /\*\*Never arm it\*\* in this release/);
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
    assert.match(guard, /when nothing merged into it and no run PR is open against it, deleting it/);
    assert.match(guard, /The integration → `main` PR is never armed in this release/);
    assert.match(guard, /Integration mode is a routing mode, not a consent, so config may set it\./);
  });
});

// #742: Step 8's serial wait ends as blocked on a conflicting, behind, closed or stalled PR.
describe('autopilot Step 8 merge wait ends on a blocked PR (#742)', () => {
  const step8 = () => section(read(SKILL), '### Step 8', '### Step 9');

  test('polls state and mergeStateStatus, not state alone', () => {
    const md = step8();
    assert.match(md, /gh pr view <pr> --json state,mergeStateStatus,statusCheckRollup   # poll until state is MERGED/);
    assert.doesNotMatch(md, /--json state -q \.state/);
  });

  test('DIRTY, BEHIND, CLOSED and a two-hour stall end the wait as blocked', () => {
    const md = step8();
    assert.match(md, /\*\*The wait also ends, as blocked,\*\* when `mergeStateStatus` is `BLOCKED` and a `statusCheckRollup` item reads `FAILURE`, `ERROR`, .*\(its `conclusion`, or a commit status's `state`\) \(\*\*red check\*\*; a red optional check reads `UNSTABLE` instead, and auto-merge still merges it\)/);
    assert.match(md, /`mergeStateStatus` is `DIRTY` \(a conflict with its base/);
    assert.match(md, /`mergeStateStatus` is `BEHIND` \(the base requires up-to-date branches/);
    assert.match(md, /`state` is `CLOSED`/);
    assert.match(md, /has not merged two hours after arming \(\*\*stalled\*\*\)/);
    assert.match(md, /A red check is one failed attempt per \[Failure handling\]\(#failure-handling\); `DIRTY`, `BEHIND`, `CLOSED` and stalled are not, so they never enter the one-retry loop/);
    assert.match(md, /never merges by hand or with `--admin`/);
  });

  test('pending states keep polling and are absent from the stop clause', () => {
    const md = step8();
    assert.match(md, /Any other `mergeStateStatus` keeps the wait polling: `BLOCKED` with no red check \(checks or reviews pending\), `UNSTABLE`, `HAS_HOOKS`, `CLEAN`, or `UNKNOWN`/);
    const stop = section(md, '**The wait also ends, as blocked,**', 'Any other `mergeStateStatus`');
    for (const s of ['HAS_HOOKS', 'CLEAN', 'UNKNOWN']) assert.ok(!stop.includes(`\`${s}\``), s);
  });

  test('failure handling and the run report carry the blocked PR', () => {
    const md = read(SKILL);
    assert.match(section(md, '## Failure handling', '- **A QA round'), /conflicts with or falls behind its base, closes, or stalls in Step 8's wait/);
    const report = section(md, '## End-of-run housekeeping', '## Guardrails');
    assert.equal(report.match(/\*\*merge-blocked\*\*/g)?.length, 2);
  });
});

// #741: the final PR runs non-interactively, and the end-of-run wait stops where Step 8's does.
describe('autopilot integration final PR and end-of-run wait (#741)', () => {
  const branch = () => section(read(SKILL), '## Integration branch', '## Per-issue loop');

  test('the end-of-run wait polls like Step 8 and ends by its blocked rule, BEHIND included', () => {
    const md = branch();
    assert.match(md, /poll each with Step 8's `gh pr view <pr> --json state,mergeStateStatus,statusCheckRollup` until `state` is `MERGED`/);
    assert.match(md, /ending the wait by Step 8's \*\*The wait also ends, as blocked,\*\* rule \(red check, `DIRTY`, `BEHIND`, closed, or stalled\)/);
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
    assert.match(md, /`git -C <gate> merge --abort`/);
    assert.match(md, /Stop with a hold if `git ls-remote --heads origin autopilot\/sync\/<ts>` already shows the branch/);
    assert.match(md, /Remove `<gate>` if it still exists \(`git worktree remove --force <gate>`\) and any local sync branch; leave `<integ>`, the pushed sync branch and any sync PR open/);
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
    assert.match(md, /require `git diff --quiet <syncHead> origin\/<integ>`/);
    assert.match(md, /4\. \*\*Checks\.\*\* Stage 1's mechanical checks run here, in `<gate>`, before anything is pushed\./);
    assert.ok(md.indexOf('4. **Checks.**') < md.indexOf('5. **Open the sync PR.**'));
  });

  test('item 3 runs the gate before the final PR; the body and report carry the sync and the hold', () => {
    const md = read(SKILL);
    const branch = section(md, '## Integration branch', '### Integration gate — stage 1');
    assert.match(branch, /run \[Integration gate — stage 1\]\(#integration-gate--stage-1-mechanical-no-llm\) below, and open the final PR only when it passes/);
    assert.match(branch, /`Synced with main at <M> via #S`/);
    assert.match(branch, /integration gate stage 3 not yet implemented — review the combined change/);
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

  test('waffleCmd defaults to npx over waffle.toolkitRef\'s pinned spec; installCmd matches github-workflow', () => {
    const stacks = loadToolkit(repoRoot).stacks;
    const orch = stacks.get('orchestration').config;
    assert.equal(orch['autopilot.waffleCmd'].default, `npx --yes ${stacks.get('wafflestack').config['waffle.toolkitRef'].default}`);
    const gw = stacks.get('github-workflow').config['project.installCmd'];
    for (const field of ['required', 'default', 'pattern']) assert.deepEqual(orch['project.installCmd'][field], gw[field], field);
    assert.deepEqual(validateToolkit(repoRoot).filter((p) => /waffleCmd|installCmd/.test(p)), []);
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
      assert.doesNotMatch(md, /\{\{(autopilot\.waffleCmd|project\.installCmd)\}\}/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// #733 (part of #720): stage 2 is adversarial-review's integration mode, run on the final PR.
describe('integration gate stage 2: decision-preservation review (#733)', () => {
  const AR = '.claude/skills/adversarial-review/SKILL.md';
  const mode = () => section(read(AR), '## Integration mode', '## 2. Read the full diff');
  const stage2 = () => section(read(SKILL), '### Integration gate — stage 2', '## Per-issue loop');

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
    assert.match(md, /merges on CI alone, unreviewed for correctness/);
  });

  test('fixes arrive through a fix PR into <integ>, never a push; the final PR is never armed', () => {
    const md = stage2();
    assert.match(md, /## Fix branch/);
    assert.match(md, /gh pr create --base <integ> --head autopilot\/stage2\/<ts>-r<k> --title /);
    assert.doesNotMatch(md, /git push[^\n]*<integ>/);
    assert.match(md, /\*\*Never arm `<F>`\*\*/);
    assert.match(md, /\*\*integration-held\*\*/);
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
