import fs from 'node:fs';
import YAML from 'yaml';
import { compareVersions, exists } from './util.mjs';
import {
  migrateLegacyDotfiles,
  renameLegacyStacksKey,
  resolveConfigFile,
  resolveLocalConfigFile,
} from './project.mjs';

/** Ordered `{ version, description, run(cwd) }` steps, each keyed by the version that SHIPS the change; every `run` must be idempotent. */
export const MIGRATIONS = [
  {
    version: '0.6.0',
    description: 'rename consumer dotfiles .wafflestack.* → .waffle.* (config, local overlay, lock, extensions dir)',
    run(cwd) {
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.8.0',
    description: 'move consumer config into .waffle/ (.waffle.yaml → .waffle/waffle.yaml, plus local overlay and lock)',
    run(cwd) {
      // `migrateLegacyDotfiles` chains every legacy generation forward in one pass, so the steps compose in any order.
      migrateLegacyDotfiles(cwd);
    },
  },
  {
    version: '0.10.0',
    description: 'rename consumer config key `bundles:` → `stacks:` in .waffle/waffle.yaml (and the .local overlay)',
    run(cwd) {
      // Move legacy dotfiles first, so config + overlay are at their current paths before the key inside them is renamed.
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

/** The steps where `fromVersion < step.version <= toVersion`, in ascending version order. */
export function applicableMigrations(fromVersion, toVersion, migrations = MIGRATIONS) {
  return migrations
    .filter(
      (m) =>
        compareVersions(m.version, fromVersion) > 0 &&
        compareVersions(m.version, toVersion) <= 0,
    )
    .sort((a, b) => compareVersions(a.version, b.version));
}

/** Run every applicable migration in order and return the steps that ran; a throwing step aborts the run. */
export function runMigrations({ cwd, fromVersion, toVersion, migrations = MIGRATIONS, log = () => {} }) {
  const steps = applicableMigrations(fromVersion, toVersion, migrations);
  for (const step of steps) {
    log(`migration ${step.version}: ${step.description}`);
    step.run(cwd);
  }
  return steps;
}
