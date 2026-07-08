import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { exists, sha256 } from './util.mjs';

/**
 * External stack source resolution (#88): turn a `{ name, source, sourceType, ref }` entry into
 * a local directory on disk that multi-root loading reads with the same `stack.yaml` machinery
 * as the built-in toolkit.
 *
 *   - a local path (`sourceType: 'path'`) is resolved relative to the consumer repo (`cwd`) and
 *     used in place — it must already exist as a directory and carries no `ref`.
 *   - a git source (`sourceType: 'git'`) is fetched at the pinned `ref` (tag, branch, or commit)
 *     into a content-addressed checkout under `cacheDir`, so an install is reproducible and
 *     offline after the first fetch. A cached checkout for the same `source@ref` is reused
 *     rather than re-cloned (a pin is immutable; a branch ref is cached for the session, which
 *     lock-recorded provenance in #125 will tighten).
 *
 * `gitFetch(source, ref, dest)` is injectable so tests can drive git resolution against a local
 * bare repo without touching the network; the default shells out to `git`. Returns the absolute
 * path to the resolved source root.
 */
export function resolveSourceRoot(ext, { cwd, cacheDir = defaultSourceCacheDir(), gitFetch = gitFetchCheckout } = {}) {
  if (ext.sourceType === 'git') {
    if (!ext.ref) {
      // normalizeStackEntries already rejects an unpinned git source; guard the loader too so a
      // hand-built entry can never fetch a moving target.
      throw new Error(
        `external stack "${ext.name}" git source "${ext.source}" has no \`ref:\` to pin — a git source must be pinned`,
      );
    }
    // Harden against argument injection: `source`/`ref` come from waffle.yaml and are passed as
    // git argv. A value beginning with `-` would be parsed by git as an OPTION rather than a
    // positional — e.g. a `--upload-pack=…` on a `.git`-suffixed source, or an ssh
    // `-oProxyCommand=…` on an scp-form host — which can escalate to command execution. A real
    // git URL or ref never begins with `-`, so reject it outright (belt to the `--`
    // end-of-options marker at the exec site).
    for (const [label, value] of [['source', ext.source], ['ref', ext.ref]]) {
      if (String(value).startsWith('-')) {
        throw new Error(
          `external stack "${ext.name}": git ${label} "${value}" must not begin with "-" — refusing to pass it to git as a possible option`,
        );
      }
    }
    const dest = path.join(cacheDir, sha256(`${ext.source}@${ext.ref}`).slice(0, 24));
    if (!exists(path.join(dest, '.git'))) {
      fs.rmSync(dest, { recursive: true, force: true }); // clear any partial/failed prior fetch
      try {
        gitFetch(ext.source, ext.ref, dest);
      } catch (err) {
        fs.rmSync(dest, { recursive: true, force: true }); // never cache a half/failed checkout
        throw new Error(
          `external stack "${ext.name}": could not fetch git source "${ext.source}" at ref "${ext.ref}" — ${err.message}`,
        );
      }
    }
    return dest;
  }

  // local path — resolved against the consumer repo, read in place.
  const root = path.resolve(cwd ?? process.cwd(), ext.source);
  if (!exists(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(
      `external stack "${ext.name}" source path "${ext.source}" does not resolve to a directory (looked in ${root})`,
    );
  }
  return root;
}

/**
 * Default git fetch: clone the source and check out the pinned ref into `dest`. `clone` +
 * `checkout <ref>` (rather than a shallow `fetch`) is the most portable way to pin to any of a
 * tag, branch, or full commit SHA, and works against a local bare repo — the hermetic, offline
 * fixture the tests use. Runs quietly; a non-zero git exit throws with git's stderr attached.
 */
export function gitFetchCheckout(source, ref, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `--` ends option parsing so a `source`/`ref` can never be read as a git flag (resolveSourceRoot
  // also rejects a leading `-` up front — defense in depth against argument injection).
  run('git', ['clone', '--quiet', '--', source, dest]);
  run('git', ['-C', dest, 'checkout', '--quiet', ref]);
}

/** Where fetched git sources are cached when the caller does not override it. */
export function defaultSourceCacheDir() {
  return path.join(os.tmpdir(), 'wafflestack-sources');
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed${stderr ? `: ${stderr}` : ` (${err.message})`}`);
  }
}
