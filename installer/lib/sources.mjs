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
 * The `opts` shape is spelled out because the `= {}` default would otherwise let TS infer ONLY
 * the defaulted keys, silently dropping `cwd` from the signature (#177).
 *
 * @param {import('./project.mjs').ExternalStackEntry} ext
 * @param {object} [opts]
 * @param {string} [opts.cwd] base for resolving a relative local-path source
 * @param {string} [opts.cacheDir] where git sources are checked out
 * @param {(source: string, ref: string, dest: string) => void} [opts.gitFetch] injectable for tests
 * @param {(dir: string) => string | null} [opts.gitResolveCommit] injectable for tests
 * @param {(dir: string) => string | null} [opts.gitOriginUrl] injectable for tests
 * @param {(dir: string, ref: string) => string | null} [opts.gitRefCommit] injectable for tests
 * @param {boolean} [opts.refresh] re-fetch a pinned ref instead of serving the session cache
 * @returns {{ root: string, commit: string | null }}
 */
export function resolveSource(
  ext,
  {
    cwd,
    cacheDir = defaultSourceCacheDir(),
    gitFetch = gitFetchCheckout,
    gitResolveCommit = gitHeadCommit,
    gitOriginUrl = gitRemoteOriginUrl,
    gitRefCommit = gitResolveRefCommit,
    refresh = false,
  } = {},
) {
  if (ext.sourceType === 'git') {
    if (!ext.ref) {
      // Guarded here too, not just in normalizeStackEntries, so a hand-built entry can never
      // fetch a moving target.
      throw new Error(
        `external stack "${ext.name}" git source "${ext.source}" has no \`ref:\` to pin — a git source must be pinned`,
      );
    }
    // Argument injection: a `source`/`ref` beginning with `-` is parsed by git as an OPTION
    // (`--upload-pack=…`, ssh `-oProxyCommand=…`), which can escalate to command execution.
    for (const [label, value] of [['source', ext.source], ['ref', ext.ref]]) {
      if (String(value).startsWith('-')) {
        throw new Error(
          `external stack "${ext.name}": git ${label} "${value}" must not begin with "-" — refusing to pass it to git as a possible option`,
        );
      }
    }
    fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
    const dest = path.join(cacheDir, sha256(`${ext.source}@${ext.ref}`).slice(0, 24));
    // A present `.git` is not proof (#460): the checkout must also be OUR clone of the pinned source.
    const cached = exists(path.join(dest, '.git')) && checkoutMatches(dest, ext, { gitResolveCommit, gitOriginUrl, gitRefCommit });
    if (!cached) {
      fs.rmSync(dest, { recursive: true, force: true }); // clear any partial/failed prior fetch
      try {
        gitFetch(ext.source, ext.ref, dest);
      } catch (err) {
        fs.rmSync(dest, { recursive: true, force: true }); // never cache a half/failed checkout
        throw new Error(
          `external stack "${ext.name}": could not fetch git source "${ext.source}" at ref "${ext.ref}" — ${err.message}`,
        );
      }
    } else if (refresh) {
      // Best-effort: fetch into a sibling dir and swap only on success, so an unreachable remote
      // leaves the cached checkout intact and `upgrade` stays usable offline.
      const tmp = `${dest}.refresh`;
      fs.rmSync(tmp, { recursive: true, force: true });
      try {
        gitFetch(ext.source, ext.ref, tmp);
        fs.rmSync(dest, { recursive: true, force: true });
        fs.renameSync(tmp, dest);
      } catch {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
    let commit = null;
    try {
      commit = gitResolveCommit(dest);
    } catch {
      commit = null; // provenance degrades to the ref alone if the commit can't be resolved
    }
    return { root: dest, commit };
  }

  // local path — resolved against the consumer repo, read in place.
  const root = path.resolve(cwd ?? process.cwd(), ext.source);
  if (!exists(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(
      `external stack "${ext.name}" source path "${ext.source}" does not resolve to a directory (looked in ${root})`,
    );
  }
  return { root, commit: null };
}

/** Back-compat wrapper: the resolved root path only, for callers that don't need provenance. */
export function resolveSourceRoot(ext, opts) {
  return resolveSource(ext, opts).root;
}

/**
 * Default git fetch. `clone` + `checkout <ref>` rather than a shallow `fetch`: it pins to a tag,
 * branch, or full SHA alike, and works against the local bare repo the tests fixture with.
 */
export function gitFetchCheckout(source, ref, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // `--` ends option parsing so a `source` can never be read as a git flag.
  run('git', ['clone', '--quiet', '--', source, dest]);
  run('git', ['-C', dest, 'checkout', '--quiet', ref]);
}

/** Resolve the commit a fetched git source is checked out at (its HEAD SHA), for lock provenance. */
export function gitHeadCommit(dir) {
  return runCapture('git', ['-C', dir, 'rev-parse', 'HEAD']).trim();
}

/** The `origin` remote URL of a checkout — the source it was actually cloned from. */
export function gitRemoteOriginUrl(dir) {
  return runCapture('git', ['-C', dir, 'remote', 'get-url', 'origin']).trim();
}

/** The commit a ref (tag, branch, or SHA) resolves to inside a checkout; `--verify` rejects guesses. */
export function gitResolveRefCommit(dir, ref) {
  return runCapture('git', ['-C', dir, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).trim();
}

/** Serve a cached checkout only if HEAD resolves, `origin` is the pinned `source`, and HEAD is what `ref` names there. */
export function checkoutMatches(dir, ext, { gitResolveCommit = gitHeadCommit, gitOriginUrl = gitRemoteOriginUrl, gitRefCommit = gitResolveRefCommit } = {}) {
  try {
    const head = gitResolveCommit(dir);
    if (!head) return false;
    if (gitOriginUrl(dir) !== ext.source) return false;
    return gitRefCommit(dir, ext.ref) === head;
  } catch {
    return false;
  }
}

/** Default cache: per-user `$XDG_CACHE_HOME/wafflestack/sources`, else `~/.cache/wafflestack/sources` — never a shared tmp (#460). */
export function defaultSourceCacheDir(env = process.env) {
  const xdg = env.XDG_CACHE_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), '.cache');
  return path.join(base, 'wafflestack', 'sources');
}

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed${stderr ? `: ${stderr}` : ` (${err.message})`}`);
  }
}

function runCapture(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    const stderr = err.stderr ? String(err.stderr).trim() : '';
    throw new Error(`\`${cmd} ${args.join(' ')}\` failed${stderr ? `: ${stderr}` : ` (${err.message})`}`);
  }
}
