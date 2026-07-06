import fs from 'node:fs';
import YAML from 'yaml';
import { compareVersions, exists } from './util.mjs';
import {
  migrateLegacyDotfiles,
  renameLegacyStacksKey,
  resolveConfigFile,
  resolveLocalConfigFile,
} from './project.mjs';

/**
 * Ordered, idempotent, version-keyed migration steps.
 *
 * A migration carries a consumer repo across a *breaking* toolkit change — a renamed or
 * removed item, a new required config key, or a changed file layout (the `.wafflestack.*`
 * → `.waffle.*` dotfile rename in #17 is the first real one). Pure content changes need no
 * migration; `render` already regenerates them.
 *
 * Step shape:
 *   {
 *     version: string,       // the toolkit version that INTRODUCES the change (semver "X.Y.Z")
 *     description: string,    // one line, shown at upgrade time
 *     run(cwd): void          // mutate the consumer repo rooted at `cwd`; MUST be idempotent
 *   }
 *
 * Contract for authors:
 * - Key a step by the version that ships the change, not the version before it.
 * - `run(cwd)` must be idempotent: re-running it on an already-migrated (or never-affected)
 *   repo is a harmless no-op — the runner offers no "already applied" bookkeeping, and
 *   `upgrade` may re-invoke a step when the lock version is unknown.
 * - Keep steps small and independent; the runner applies them in ascending version order,
 *   so a later step may assume every earlier step has run.
 *
 * #17 registered the first entry (the `.wafflestack.*` → `.waffle.*` dotfile rename).
 */
export const MIGRATIONS = [
  {
    version: '0.6.0',
    description: 'rename consumer dotfiles .wafflestack.* → .waffle.* (config, local overlay, lock, extensions dir)',
    run(cwd) {
      // Delegates to the same in-place rename `render` runs, so upgrade and a plain
      // re-render converge; idempotent on already-migrated or fresh repos.
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.8.0',
    description: 'move consumer config into .waffle/ (.waffle.yaml → .waffle/waffle.yaml, plus local overlay and lock)',
    run(cwd) {
      // Same shared helper as the 0.6.0 step and `render` — it chains every legacy
      // generation forward in one pass (`.wafflestack.*` → `.waffle.*` → `.waffle/waffle.*`),
      // so the 0.6.0 + 0.8.0 pair is idempotent in any combination and a pre-0.6.0 repo
      // lands directly in the current layout.
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.10.0',
    description: 'rename consumer config key `bundles:` → `stacks:` in .waffle/waffle.yaml (and the .local overlay)',
    run(cwd) {
      // Move any legacy dotfiles into `.waffle/` first (chaining onto the 0.6.0/0.8.0 steps),
      // so the config + overlay are at their current paths before we rename the key inside
      // them — a pre-0.8.0 repo lands the config in `.waffle/` and gets its key renamed in one
      // upgrade. Then, for the consumer config AND the `.local` overlay, rename the top-level
      // `bundles:` key to `stacks:` in place. `renameLegacyStacksKey` mutates the key scalar's
      // value, preserving the value node and every comment (delete+set would drop them), and
      // returns false — writing nothing — when there is no `bundles:` pair or `stacks:` already
      // exists, so this is idempotent on an already-migrated, fresh, or overlay-less repo.
      migrateLegacyDotfiles(cwd);
      for (const resolve of [resolveConfigFile, resolveLocalConfigFile]) {
        const { file } = resolve(cwd);
        if (!exists(file)) continue;
        const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
        if (renameLegacyStacksKey(doc)) fs.writeFileSync(file, doc.toString());
      }
    },
  },
];

/**
 * The steps that apply when moving `fromVersion` → `toVersion`, in ascending version order.
 * A step applies when `fromVersion < step.version <= toVersion` — i.e. it was introduced
 * after the repo last rendered and no later than the version being upgraded to. A step whose
 * version is unparseable is skipped (it can never satisfy the window).
 */
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) {
  return migrations
    .filter(
      (m) =>
        compareVersions(m.version, fromVersion) > 0 &&
        compareVersions(m.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/**
 * Run every applicable migration in order and return the steps that ran (for reporting).
 * Steps run for their side effects on `cwd`; a throwing step aborts the run (upgrade then
 * surfaces the error rather than rendering on a half-migrated tree).
 */
export function runMigrations({ cwd, fromVersion, toVersion, migrations = MIGRATIONS, log = () => {} }) {
  const steps = applicableMigrations(fromVersion, toVersion, migrations);
  for (const step of steps) {
    log(`migration ${step.version}: ${step.description}`);
    step.run(cwd);
  }
  return steps;
}
