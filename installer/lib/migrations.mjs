import { compareVersions } from './util.mjs';

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
 * This array ships empty; #17 registers the first entry.
 */
export const MIGRATIONS = [];

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
