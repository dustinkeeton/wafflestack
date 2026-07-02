import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';
import { placeholderKeys, compilePattern } from './template.mjs';
import { parseFrontmatter } from './util.mjs';
import { findItems, itemsOfKind, parseRef, resolveDepStrict } from './refs.mjs';

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
      // Agent `skills:` names are pulled into the dependency closure when the agent is
      // installed. They may point at skills provided outside the toolkit (project-local
      // or not yet authored), so an absent name is allowed — but a name defined in more
      // than one bundle can't be auto-resolved (frontmatter can't qualify it).
      for (const skillName of agent.data.skills ?? []) {
        if (bundle.skills.some((s) => s.name === skillName)) continue;
        const matches = findItems(toolkit, 'skills', skillName);
        if (matches.length > 1) {
          const where = matches.map((m) => `${m.bundleName}/skills/${skillName}`).join(', ');
          problems.push(`${ctx}: agent ${agent.name} skill "${skillName}" is ambiguous across bundles (${where})`);
        }
      }
      // Both the body and the frontmatter description are substituted at render time.
      for (const k of placeholderKeys(agent.body)) usedKeys.add(k);
      for (const k of placeholderKeys(agent.data.description ?? '')) usedKeys.add(k);
    }

    // `requires:` entries must key a real item in this bundle and resolve to real deps.
    for (const [itemRef, deps] of Object.entries(bundle.requires ?? {})) {
      const parsed = parseRef(itemRef);
      if (parsed.form === 'bundle' || !itemsOfKind(bundle, parsed.kind).some((i) => i.name === parsed.name)) {
        problems.push(`${ctx}: requires key "${itemRef}" does not match a skill/agent in this bundle`);
        continue;
      }
      for (const dep of deps ?? []) {
        try {
          resolveDepStrict(toolkit, dep, bundle.name);
        } catch (err) {
          problems.push(`${ctx}: requires[${itemRef}]: ${err.message}`);
        }
      }
    }
    // Optional per-key `pattern:` (render-time value validation). The regex must compile,
    // and a static string default must satisfy its own pattern (nested/non-string defaults
    // resolve at render, so skip them here).
    for (const [key, spec] of Object.entries(bundle.config)) {
      if (typeof spec?.pattern !== 'string') continue;
      let re;
      try {
        re = compilePattern(spec.pattern);
      } catch (err) {
        problems.push(`${ctx}: config key ${key} has an invalid pattern: ${err.message}`);
        continue;
      }
      if (typeof spec.default === 'string' && !spec.default.includes('{{') && !re.test(spec.default)) {
        problems.push(`${ctx}: config key ${key} default "${spec.default}" does not match its declared pattern`);
      }
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

    // Text `files/` payloads are templated just like skills — every {{key}} they use must
    // be declared (GitHub Actions `${{ ... }}` is excluded by the placeholder grammar, so
    // workflow expressions don't register as config keys). Binaries are byte-copied, skip.
    for (const file of bundle.files) {
      if (file.binary) continue;
      for (const k of placeholderKeys(fs.readFileSync(file.path, 'utf8'))) usedKeys.add(k);
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
