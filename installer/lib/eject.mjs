import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { exists } from './util.mjs';
import { readLock, normalizeItemRef } from './render.mjs';
import { CONFIG_FILE, LOCK_FILE } from './project.mjs';

/**
 * Stop managing an item: add it to the config's `eject:` list (comment-preserving
 * YAML edit) and drop its rendered files from the lock so they become project-owned.
 * The files themselves are left in place.
 */
export function eject({ cwd, item }) {
  const ref = normalizeItemRef(item);
  if (!/^(agents|skills)\//.test(ref)) {
    throw new Error(`eject target must look like skills/<name> or agents/<name>, got "${item}"`);
  }
  const [, kind, name] = /^(agents|skills)\/(.+)$/.exec(ref);

  const configFile = path.join(cwd, CONFIG_FILE);
  const doc = YAML.parseDocument(fs.readFileSync(configFile, 'utf8'));
  const current = doc.get('eject');
  const list = current ? current.toJSON() : [];
  if (!list.includes(ref)) {
    doc.set('eject', [...list, ref]);
    fs.writeFileSync(configFile, doc.toString());
  }

  const lock = readLock(cwd);
  const released = [];
  if (lock) {
    const patterns = kind === 'agents'
      ? [path.join('.claude', 'agents', `${name}.md`), path.join('.codex', 'agents', `${name}.toml`)]
      : [path.join('.claude', 'skills', name) + path.sep, path.join('.agents', 'skills', name) + path.sep];
    for (const rel of Object.keys(lock.files)) {
      if (patterns.some((p) => rel === p || rel.startsWith(p))) {
        delete lock.files[rel];
        released.push(rel);
      }
    }
    fs.writeFileSync(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
  }

  return { ref, released };
}

const STARTER_CONFIG = `# agent-toolkit project config — see the toolkit repo's schema/FORMAT.md
# Version pin is the npx ref you install with, e.g. npx github:OWNER/agent-toolkit#v0.1.0
targets: [claude, codex, agents-dir]
bundles: []
#  - docs-system
#  - github-workflow
#  - code-quality
#  - design
#  - obsidian-dev
#  - orchestration
config: {}
#  git:
#    botEmail: bot@example.com
# Account-specific values belong in .agent-toolkit.local.yaml (gitignore it).
`;

export function init({ cwd }) {
  const configFile = path.join(cwd, CONFIG_FILE);
  if (exists(configFile)) throw new Error(`${CONFIG_FILE} already exists`);
  fs.writeFileSync(configFile, STARTER_CONFIG);
  return configFile;
}
