import fs from 'node:fs';
import path from 'node:path';
import { readYaml, parseFrontmatter, exists } from './util.mjs';

/** Load the toolkit registry and every bundle it lists. */
export function loadToolkit(rootDir) {
  const registry = readYaml(path.join(rootDir, 'toolkit.yaml'));
  const bundles = new Map();
  for (const name of registry.bundles ?? []) {
    const dir = path.join(rootDir, 'bundles', name);
    if (!exists(path.join(dir, 'bundle.yaml'))) continue; // not yet authored
    bundles.set(name, loadBundle(name, dir));
  }
  return { name: registry.name, description: registry.description, bundles };
}

function loadBundle(name, dir) {
  const manifest = readYaml(path.join(dir, 'bundle.yaml'));
  const config = manifest.config ?? {};
  const declared = new Set(Object.keys(config));

  const agents = (manifest.agents ?? []).map((agentName) => {
    const file = path.join(dir, 'agents', `${agentName}.md`);
    const raw = fs.readFileSync(file, 'utf8');
    const { data, body } = parseFrontmatter(raw);
    return { kind: 'agent', name: agentName, file, data, body };
  });

  const skills = (manifest.skills ?? []).map((skillName) => {
    const skillDir = path.join(dir, 'skills', skillName);
    const files = fs
      .readdirSync(skillDir, { recursive: true, withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => path.relative(skillDir, path.join(e.parentPath ?? e.path, e.name)))
      .sort();
    if (!files.includes('SKILL.md')) {
      throw new Error(`bundle ${name}: skill ${skillName} has no SKILL.md`);
    }
    return { kind: 'skill', name: skillName, dir: skillDir, files };
  });

  return {
    name,
    dir,
    description: manifest.description ?? '',
    agents,
    skills,
    config,
    declared,
    env: manifest.env ?? {},
    setup: typeof manifest.setup === 'string' ? manifest.setup : '',
  };
}

/** Config keys whose `required: true` and which have no default. */
export function missingRequiredKeys(bundle, values, lookup) {
  const missing = [];
  for (const [key, spec] of Object.entries(bundle.config)) {
    if (!spec?.required) continue;
    if (lookup(values, key) === undefined) missing.push(key);
  }
  return missing;
}
