// @ts-check
// The canonical self-render (committed config + extensions, never the overlay) in a tmp dir:
// this repo gitignores its .claude/ render (#777), so tests read this instead.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderProject } from '../lib/render.mjs';

export const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** @type {string | null} */
let root = null;

/** @returns {string} */
export function selfRenderRoot() {
  if (root) return root;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-self-render-'));
  for (const rel of ['.waffle/waffle.yaml', '.waffle/extensions', '.waffle/waffle.lock.json']) {
    const from = path.join(REPO_ROOT, rel);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(tmp, rel), { recursive: true });
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const result = renderProject({ toolkitRoot: REPO_ROOT, cwd: tmp, sourceBaseDir: REPO_ROOT, toolkitVersion: pkg.version });
  if (!result.ok) throw new Error(`self-render failed:\n${result.errors.join('\n')}`);
  process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));
  root = tmp;
  return tmp;
}

/** @param {string} rel @returns {string} */
export const renderedPath = (rel) => path.join(selfRenderRoot(), rel);

/** @param {string} rel @returns {string} */
export const readRendered = (rel) => fs.readFileSync(renderedPath(rel), 'utf8');
