import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { placeholderKeys } from './template.mjs';
import { parseFrontmatter } from './util.mjs';

/** Toolkit-developer lint. Returns a list of problems (empty = clean). */
export function validateToolkit(rootDir) {
  const problems = [];
  let toolkit;
  try {
    toolkit = loadToolkit(rootDir);
  } catch (err) {
    return [`toolkit failed to load: ${err.message}`];
  }

  for (const bundle of toolkit.bundles.values()) {
    const ctx = `bundle ${bundle.name}`;
    if (!bundle.description) problems.push(`${ctx}: missing description`);

    const usedKeys = new Set();
    for (const agent of bundle.agents) {
      if (!agent.data.description) problems.push(`${ctx}: agent ${agent.name} missing frontmatter description`);
      if (agent.data.name && agent.data.name !== agent.name) {
        problems.push(`${ctx}: agent ${agent.name} frontmatter name "${agent.data.name}" mismatches filename`);
      }
      // Both the body and the frontmatter description are substituted at render time.
      for (const k of placeholderKeys(agent.body)) usedKeys.add(k);
      for (const k of placeholderKeys(agent.data.description ?? '')) usedKeys.add(k);
    }
    for (const skill of bundle.skills) {
      const raw = fs.readFileSync(path.join(skill.dir, 'SKILL.md'), 'utf8');
      const { data } = parseFrontmatter(raw);
      if (!data.name) problems.push(`${ctx}: skill ${skill.name} missing frontmatter name`);
      if (!data.description) problems.push(`${ctx}: skill ${skill.name} missing frontmatter description`);
      for (const rel of skill.files.filter((f) => f.endsWith('.md'))) {
        for (const k of placeholderKeys(fs.readFileSync(path.join(skill.dir, rel), 'utf8'))) usedKeys.add(k);
      }
    }

    for (const key of usedKeys) {
      // `harness.*` is a reserved, always-available namespace (resolved per target) —
      // it is never declared in bundle config.
      if (!bundle.declared.has(key) && !key.startsWith('harness.') && looksLikeConfigKey(key)) {
        problems.push(`${ctx}: placeholder {{${key}}} is not declared in bundle.yaml config`);
      }
    }
    for (const key of bundle.declared) {
      if (!usedKeys.has(key)) problems.push(`${ctx}: declared config key ${key} is never referenced`);
    }
  }
  return problems;
}

/**
 * Undeclared {{...}} text is usually third-party template syntax that must pass
 * through (mustache in docs, GitHub Actions, etc.) — only flag dotted lowercase
 * keys, which match the toolkit's config-key convention.
 */
function looksLikeConfigKey(key) {
  return /^[a-z][\w-]*(\.[\w-]+)+$/.test(key);
}
