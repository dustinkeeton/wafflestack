import fs from 'node:fs';
import path from 'node:path';
import {
  sha256,
  exists,
  writeFileEnsuringDir,
  stringifyFrontmatter,
} from './util.mjs';
import { substitute } from './template.mjs';
import { loadToolkit, missingRequiredKeys } from './toolkit.mjs';
import {
  loadProjectConfig,
  makeResolver,
  LOCK_FILE,
  EXTENSIONS_DIR,
} from './project.mjs';

/**
 * Render every enabled bundle into the project at `cwd`.
 * Frozen-image contract: outputs are regenerated verbatim; managed files from the
 * previous lock that are no longer rendered get deleted; a fresh lock is written.
 */
export function renderProject({ toolkitRoot, cwd, toolkitVersion, log = () => {} }) {
  const project = loadProjectConfig(cwd);
  const toolkit = loadToolkit(toolkitRoot);
  const errors = [];
  const warnings = [];
  const outputs = new Map(); // relative path -> content (string | Buffer)

  const ejected = new Set(project.eject.map(normalizeItemRef));

  for (const bundleName of project.bundles) {
    const bundle = toolkit.bundles.get(bundleName);
    if (!bundle) {
      errors.push(`bundle "${bundleName}" not found in toolkit (have: ${[...toolkit.bundles.keys()].join(', ')})`);
      continue;
    }
    const resolve = makeResolver(bundle, project.values);
    const missing = missingRequiredKeys(bundle, project.values, (values, key) => resolve(key));
    if (missing.length) {
      errors.push(
        `bundle "${bundleName}" needs config values: ${missing.map((k) => `config.${k}`).join(', ')} — add them to .agent-toolkit.yaml (or the .local overlay)`,
      );
      continue;
    }

    for (const agent of bundle.agents) {
      if (ejected.has(`agents/${agent.name}`)) continue;
      renderAgent({ agent, bundle, resolve, project, cwd, outputs, errors });
    }
    for (const skill of bundle.skills) {
      if (ejected.has(`skills/${skill.name}`)) continue;
      renderSkill({ skill, bundle, resolve, project, cwd, outputs, errors });
    }
    checkEnvPrerequisites({ bundle, project, cwd, warnings });
  }

  if (errors.length) return { ok: false, errors, warnings };

  // Frozen image: remove previously managed files that this render no longer produces.
  const oldLock = readLock(cwd);
  const removed = [];
  for (const rel of Object.keys(oldLock?.files ?? {})) {
    if (!outputs.has(rel) && exists(path.join(cwd, rel))) {
      fs.rmSync(path.join(cwd, rel));
      removed.push(rel);
    }
  }

  const lockFiles = {};
  for (const [rel, content] of [...outputs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    writeFileEnsuringDir(path.join(cwd, rel), content);
    lockFiles[rel] = sha256(content);
  }

  const lock = {
    toolkitVersion,
    targets: project.targets,
    bundles: project.bundles,
    files: lockFiles,
  };
  writeFileEnsuringDir(path.join(cwd, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);

  log(`rendered ${outputs.size} files${removed.length ? `, removed ${removed.length} stale` : ''}`);
  return { ok: true, errors: [], warnings, written: [...outputs.keys()], removed };
}

function renderAgent({ agent, bundle, resolve, project, cwd, outputs, errors }) {
  const context = `${bundle.name}/agents/${agent.name}`;
  let body = substitute(agent.body, resolve, bundle.declared, errors, context);
  body = appendExtension(body, cwd, path.join(EXTENSIONS_DIR, 'agents', `${agent.name}.md`));

  if (project.targets.includes('claude')) {
    const fm = { name: agent.data.name ?? agent.name, description: agent.data.description };
    if (agent.data.skills) fm.skills = agent.data.skills;
    Object.assign(fm, agent.data.claude ?? {});
    outputs.set(
      path.join('.claude', 'agents', `${agent.name}.md`),
      stringifyFrontmatter(fm, body),
    );
  }
  if (project.targets.includes('codex')) {
    outputs.set(path.join('.codex', 'agents', `${agent.name}.toml`), agentToml(agent, body));
  }
}

function agentToml(agent, body) {
  const name = agent.data.name ?? agent.name;
  const description = agent.data.description ?? '';
  return [
    `name = ${tomlBasicString(name)}`,
    `description = ${tomlBasicString(description)}`,
    `developer_instructions = ${tomlMultilineString(body.trimEnd())}`,
    '',
  ].join('\n');
}

function tomlBasicString(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}

function tomlMultilineString(s) {
  // Escape backslashes and any run of 3+ quotes that would terminate the literal.
  const escaped = String(s).replace(/\\/g, '\\\\').replace(/"""/g, '""\\"');
  return `"""\n${escaped}"""`;
}

function renderSkill({ skill, bundle, resolve, project, cwd, outputs, errors }) {
  const targets = [];
  if (project.targets.includes('claude')) targets.push(path.join('.claude', 'skills', skill.name));
  if (project.targets.includes('agents-dir')) targets.push(path.join('.agents', 'skills', skill.name));
  if (!targets.length) return;

  for (const rel of skill.files) {
    const abs = path.join(skill.dir, rel);
    let content;
    if (rel.endsWith('.md')) {
      const context = `${bundle.name}/skills/${skill.name}/${rel}`;
      content = substitute(fs.readFileSync(abs, 'utf8'), resolve, bundle.declared, errors, context);
      if (rel === 'SKILL.md') {
        content = appendExtension(content, cwd, path.join(EXTENSIONS_DIR, 'skills', `${skill.name}.md`));
      }
    } else {
      content = fs.readFileSync(abs);
    }
    for (const target of targets) outputs.set(path.join(target, rel), content);
  }
}

function appendExtension(body, cwd, relPath) {
  const extensionFile = path.join(cwd, relPath);
  if (!exists(extensionFile)) return body;
  const ext = fs.readFileSync(extensionFile, 'utf8').trim();
  if (!ext) return body;
  return `${body.trimEnd()}\n\n<!-- BEGIN project extension: ${relPath} -->\n\n${ext}\n\n<!-- END project extension -->\n`;
}

/**
 * Bundles can require env vars (e.g. agent-teams experiments). We never edit the
 * project's shared config files — we verify and tell the user exactly what to add.
 */
function checkEnvPrerequisites({ bundle, project, cwd, warnings }) {
  for (const [key, value] of Object.entries(bundle.env)) {
    if (project.targets.includes('claude')) {
      const settingsFile = path.join(cwd, '.claude', 'settings.json');
      let ok = false;
      if (exists(settingsFile)) {
        try {
          ok = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))?.env?.[key] === value;
        } catch { /* unparseable -> warn below */ }
      }
      if (!ok) {
        warnings.push(`bundle "${bundle.name}" needs env ${key}=${value} in .claude/settings.json ("env" section)`);
      }
    }
    if (project.targets.includes('codex')) {
      const configFile = path.join(cwd, '.codex', 'config.toml');
      const text = exists(configFile) ? fs.readFileSync(configFile, 'utf8') : '';
      if (!new RegExp(`^\\s*${key}\\s*=\\s*"${value}"`, 'm').test(text)) {
        warnings.push(`bundle "${bundle.name}" needs ${key} = "${value}" under [shell_environment_policy.set] in .codex/config.toml`);
      }
    }
  }
}

export function readLock(cwd) {
  const file = path.join(cwd, LOCK_FILE);
  if (!exists(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function normalizeItemRef(ref) {
  return ref.replace(/^(agent|skill)s?[:/]/, (m) => (m.startsWith('agent') ? 'agents/' : 'skills/'));
}
