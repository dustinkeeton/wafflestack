// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveWritableInside } from './util.mjs';

/** @param {string} cwd @param {string} rel */
export function safeDestination(cwd, rel) {
  if (!resolveWritableInside(cwd, rel)) return false;
  let current = cwd;
  for (const part of rel.split('/')) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) return false; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return true;
}

/** @param {string} file @returns {Buffer|null} */
export function readBytes(file) {
  try { return fs.readFileSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

/** @param {Buffer|null} a @param {Buffer|null} b */
export const sameBytes = (a, b) => a === null ? b === null : b !== null && a.equals(b);

/** @param {string} file @param {Buffer|null} bytes */
export function replaceBytes(file, bytes) {
  if (bytes === null) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stage = fs.mkdtempSync(path.join(path.dirname(file), '.waffle-write-'));
  try {
    fs.writeFileSync(path.join(stage, 'content'), bytes, { mode: 0o600 });
    fs.renameSync(path.join(stage, 'content'), file);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

/** @param {string} mutex @param {() => void} recover @param {number} [depth] */
export function acquirePreparation(mutex, recover, depth = 0) {
  if (depth > 16) throw new Error('preparation recovery nesting exceeded — inspect private transaction');
  const candidate = fs.mkdtempSync(`${mutex}-claim-`);
  const owner = JSON.stringify({ pid: process.pid, host: os.hostname() });
  try {
    fs.writeFileSync(path.join(candidate, 'owner.json'), owner, { mode: 0o600 });
    try {
      if (fs.existsSync(mutex)) throw Object.assign(new Error('occupied'), { code: 'EEXIST' });
      fs.renameSync(candidate, mutex); return;
    }
    catch (e) { if (!['EEXIST', 'ENOTEMPTY'].includes(e.code)) throw e; }
  } finally { fs.rmSync(candidate, { recursive: true, force: true }); }
  const deadOwner = () => {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(mutex, 'owner.json'), 'utf8'));
      if (record.host !== os.hostname() || !Number.isInteger(record.pid) || record.pid <= 0) return false;
      try { process.kill(record.pid, 0); return false; } catch (e) { return e.code === 'ESRCH'; }
    } catch { return false; }
  };
  if (!deadOwner()) throw new Error('preparation active or interrupted without a verifiable owner — inspect private transaction before retrying');
  const recovery = path.join(mutex, 'recovery');
  acquirePreparation(recovery, () => {}, depth + 1);
  try {
    if (!deadOwner()) throw new Error('preparation active — retry after the owning process exits');
    recover();
    replaceBytes(path.join(mutex, 'owner.json'), Buffer.from(owner));
  } finally { fs.rmSync(recovery, { recursive: true, force: true }); }
}

/** @param {string} cwd @param {string} mutex */
export function recoverPreparation(cwd, mutex) {
  const bytes = readBytes(path.join(mutex, 'journal.json'));
  if (!bytes) return;
  try {
    const journal = JSON.parse(bytes.toString());
    if (journal.version !== 1 || !Array.isArray(journal.entries)) throw new Error('invalid journal');
    const entries = journal.entries.map((/** @type {[string, string|null, string|null]} */ [rel, before, after]) => {
      if (typeof rel !== 'string' || !/^(?:\.claude|\.agents|\.codex)\//.test(rel) && rel !== '.waffle/waffle.local.lock.json' && rel !== '@receipt') throw new Error('invalid path');
      if (![before, after].every(b => b === null || typeof b === 'string' && Buffer.from(b, 'base64').toString('base64') === b)) throw new Error('invalid bytes');
      if (rel !== '@receipt' && !safeDestination(cwd, rel)) throw new Error('unsafe path');
      const file = rel === '@receipt' ? path.join(path.dirname(mutex), 'wafflestack-prepared.json') : path.join(cwd, rel);
      if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('unsafe receipt');
      const original = before === null ? null : Buffer.from(before, 'base64');
      const intended = after === null ? null : Buffer.from(after, 'base64');
      const current = readBytes(file);
      if (!sameBytes(current, original) && !sameBytes(current, intended)) throw new Error('concurrent edit');
      return { file, original };
    });
    for (const { file, original } of entries.reverse()) {
      replaceBytes(file, original);
      if (!sameBytes(readBytes(file), original)) throw new Error('restore verification failed');
    }
    fs.rmSync(path.join(mutex, 'journal.json'));
  } catch { throw new Error('rollback incomplete — inspect private transaction journal; changed or unsafe artifacts were preserved'); }
}
