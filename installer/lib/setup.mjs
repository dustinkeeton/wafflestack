import fs from 'node:fs';
import path from 'node:path';
import { loadToolkit } from './toolkit.mjs';

/**
 * The agent-driven install wizard: the static playbook (schema/SETUP.md) followed by
 * an inventory generated from the installed toolkit, so the agent running the setup
 * always sees the bundle/config/prerequisite surface of the exact version it will
 * render with — never a stale copy baked into docs.
 */
export function setupGuide(toolkitRoot, toolkitVersion) {
  const playbook = fs
    .readFileSync(path.join(toolkitRoot, 'schema', 'SETUP.md'), 'utf8')
    .trimEnd();
  const toolkit = loadToolkit(toolkitRoot);
  return `${playbook}\n\n---\n\n${toolkitInventory(toolkit, toolkitVersion)}`;
}

export function toolkitInventory(toolkit, version) {
  const hasSyrup = [...toolkit.bundles.values()].some((b) => b.syrup.size);
  const lines = [
    `# Toolkit inventory — ${toolkit.name}${version ? ` v${version}` : ''}`,
    '',
    'Generated from the installed toolkit; authoritative for this version.',
    '',
    'Install a whole bundle by name (adds it to `bundles:`), or a single item by ref —',
    '`skills/<name>` or `agents/<name>` (adds it to `include:`). Bundle-qualify an item as',
    '`<bundle>/skills/<name>` when the same name appears in more than one bundle. Installing',
    "an item pulls its dependency closure automatically (an agent's `skills:` and any declared",
    '`requires:`), so required config is scoped to what the selected items actually reference.',
    '',
  ];
  if (hasSyrup) {
    lines.push(
      'A **syrup** item (marked below) is a sensitive `files/` payload — e.g. a workflow that',
      'needs write permissions on the repo. It is NOT part of a bundle default render: enabling',
      'the bundle does **not** install it. It renders only when you install its ref explicitly',
      "(`install files/<path>`) or the repo already tracks it in `.waffle/waffle.lock.json`. **Do",
      'not install a syrup item unless the user explicitly asks for that specific file** —',
      'default to leaving it out.',
      '',
    );
  }
  for (const bundle of toolkit.bundles.values()) {
    lines.push(`## bundle: ${bundle.name}`, '');
    if (bundle.description) lines.push(bundle.description, '');
    lines.push(`- skills: ${bundle.skills.map((s) => `skills/${s.name}`).join(', ') || '(none)'}`);
    lines.push(`- agents: ${bundle.agents.map((a) => `agents/${a.name}`).join(', ') || '(none)'}`);
    const isSyrup = (f) => bundle.syrup.has(`files/${f.name}`);
    const plainFiles = bundle.files.filter((f) => !isSyrup(f));
    const syrupFiles = bundle.files.filter(isSyrup);
    if (plainFiles.length) {
      lines.push(`- files: ${plainFiles.map((f) => `files/${f.name}`).join(', ')}`);
    }
    if (syrupFiles.length) {
      lines.push(
        `- files (syrup — sensitive, do NOT install by default): ${syrupFiles.map((f) => `files/${f.name}`).join(', ')}`,
      );
    }
    const env = Object.entries(bundle.env);
    if (env.length) {
      lines.push(`- env prerequisites: ${env.map(([k, v]) => `${k}=${v}`).join(', ')}`);
    }
    lines.push('');
    lines.push(...configSection(bundle.config));
    if (bundle.setup) lines.push('### setup notes', '', bundle.setup.trim(), '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

function configSection(config) {
  const entries = Object.entries(config);
  if (!entries.length) return [];
  const lines = ['### config keys', ''];
  for (const [key, spec] of entries) {
    const description = String(spec?.description ?? '').trim().replace(/\s*\n\s*/g, ' ');
    const d = spec?.default;
    const multiline = d !== undefined && String(d).includes('\n');
    const status = spec?.required
      ? 'required'
      : d !== undefined && !multiline
        ? `optional; default: \`${d}\``
        : 'optional';
    lines.push(`- \`${key}\` (${status}) — ${description}`);
    if (multiline) {
      // Four-backtick fence: defaults may themselves contain ``` blocks.
      lines.push('', '  default:', '', '  ````', ...String(d).split('\n').map((l) => `  ${l}`.trimEnd()), '  ````', '');
    }
  }
  lines.push('');
  return lines;
}
