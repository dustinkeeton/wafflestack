/**
 * `wafflestack avatars sync` / `avatars status` — the owner-side pipeline that keeps Gravatar in
 * sync with the installed agent roster (#285).
 *
 * The avatars are deterministic (`agentAvatarSvg` is a pure function of the agent name + granted
 * skill count), and each agent commits under a deterministic plus-addressed email. So the toolkit
 * owner can pre-register every avatar once, against a toolkit-owned domain, and GitHub serves them
 * to every consumer on defaults via Gravatar — zero consumer setup. A consumer that overrides
 * `git.botEmail` re-runs the same command against its own domain and Gravatar account.
 *
 * Gravatar v3 REST facts this encodes (all OAuth2, scope `gravatar-profile:manage` for writes):
 *   - email hash = sha256(lowercased-trimmed email)
 *   - GET  /me/associated-email?email_hash=…   — is this email verified on the account? (drift probe)
 *   - POST /me/avatars (multipart `image`)      — upload; returns an imageId
 *   - PATCH /me/avatars/{imageId}   {rating:G}   — GitHub shows G-rated only
 *   - POST /me/avatars/{imageId}/email {email_hash} — assign the avatar to an email
 *   - there is NO endpoint to ADD or VERIFY a new email — that stays a manual gravatar.com web flow.
 *
 * The HTTP client and the SVG→PNG rasterizer are **injected** so the engine (`syncAvatars`) is
 * unit-tested with mocks — `npm test` makes no network or native calls. `runAvatarsSync` wires the
 * real `fetch`-based client and a shell rasterizer for the CLI.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { loadToolkit } from './toolkit.mjs';
import { loadProjectConfig } from './project.mjs';
import { computeSelection } from './refs.mjs';
import { collectAgentAvatars } from './waffledocs.mjs';

export const GRAVATAR_BASE = 'https://api.gravatar.com/v3';
export const TOKEN_ENV = 'WAFFLE_GRAVATAR_TOKEN';

/** Gravatar identifies an email by the sha256 of its lowercased, trimmed form. */
export function emailHash(email) {
  return crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
}

/**
 * The pure sync engine. `agents` is `[{ name, email, svg, ... }]` (from `collectAgentAvatars`);
 * `http` and `rasterize` are injected. For each agent with a real commit email:
 *   - probe `GET /me/associated-email` — if the address is not verified on the account, collect it
 *     into the manual "verify then re-run" remainder and skip (Gravatar has no add/verify API);
 *   - otherwise (sync mode) rasterize its SVG, upload it, set the rating to G, and assign it to the
 *     email; in status mode, just report it as registered.
 * Returns `{ synced, pending, skipped, mode }`. Throws a `NO_TOKEN`-coded error when `token` is
 * falsy — the secret is required and never has a default.
 */
export async function syncAvatars({ agents, token, http, rasterize, log = () => {}, mode = 'sync' }) {
  if (!token) {
    const err = new Error(
      `${TOKEN_ENV} is not set — an owner-only Gravatar OAuth2 access token is required to sync avatars ` +
        '(obtain it once via the WordPress.com OAuth flow; see .waffle/AVATARS.md).',
    );
    err.code = 'NO_TOKEN';
    throw err;
  }
  const synced = [];
  const pending = [];
  const skipped = [];
  const failed = [];
  for (const agent of agents) {
    // No opted-in bot identity (or a shared/verbatim address with no email): nothing to register.
    if (!agent.email) {
      skipped.push(agent);
      continue;
    }
    try {
      const hash = emailHash(agent.email);
      const { associated } = await http.getAssociatedEmail({ token, emailHash: hash });
      if (!associated) {
        pending.push(agent);
        continue;
      }
      if (mode === 'status') {
        synced.push(agent);
        continue;
      }
      const png = await rasterize(agent.svg);
      const { imageId } = await http.uploadAvatar({ token, emailHash: hash, image: png });
      await http.setRating({ token, imageId, rating: 'G' });
      await http.associateAvatarEmail({ token, imageId, emailHash: hash });
      synced.push(agent);
      log(`  ✓ ${agent.name} → ${agent.email}`);
    } catch (err) {
      // Per-agent error isolation: a transient Gravatar error (429 rate-limit, 500) on one agent
      // must not abort the rest of the roster. Collect it into a `failed[]` remainder to retry —
      // idempotency means a re-run recovers. NO_TOKEN is a run-wide misconfiguration (and is thrown
      // before this loop), never per-agent, so it is not caught here.
      failed.push({ agent, error: err?.message ?? String(err) });
      log(`  ✗ ${agent.name} → ${agent.email}: ${err?.message ?? err}`);
    }
  }

  if (mode === 'status') {
    log(`registered: ${synced.length}, drifted (unregistered): ${pending.length}`);
  } else {
    log(`synced ${synced.length} avatar${synced.length === 1 ? '' : 's'}`);
  }
  if (pending.length) {
    log(
      mode === 'status'
        ? 'drifted — installed agents whose commit email is not verified on the Gravatar account:'
        : `pending — ${pending.length} address(es) not yet verified on the account; add + verify each at ` +
            'gravatar.com, then re-run `wafflestack avatars sync`:',
    );
    for (const a of pending) log(`  • ${a.name} → ${a.email}`);
  }
  if (failed.length) {
    log(
      `failed — ${failed.length} agent(s) errored (transient API/network) and were skipped; ` +
        're-run `wafflestack avatars sync` to retry them:',
    );
    for (const f of failed) log(`  • ${f.agent.name} → ${f.agent.email}: ${f.error}`);
  }
  return { synced, pending, skipped, failed, mode };
}

/**
 * The exit code for an `avatars` run — the drift gate for #285. Any `failed` remainder (agents that
 * errored mid-run) exits non-zero in every mode, so a partially-failed `sync` never looks clean to
 * CI. Otherwise `status` is a check: a non-empty `pending` remainder (addresses drifted off the
 * account) exits non-zero so CI/scripts can fail on drift; `sync` and a clean `status` exit 0. Pure
 * so the gate is unit-testable without driving the process (a flipped ternary here would otherwise
 * ship green — see the CLI in `cli.mjs`).
 */
export function avatarsExitCode({ mode, pending, failed }) {
  if ((failed?.length ?? 0) > 0) return 1;
  return mode === 'status' && (pending?.length ?? 0) > 0 ? 1 : 0;
}

/**
 * The avatar rows for the selection installed in `cwd`, each paired with its rendered 512px SVG —
 * exactly the rows the rendered `.waffle/AVATARS.md` describes, so the addresses this pipeline
 * registers match the manifest byte-for-byte.
 */
export function enumerateAgentAvatars({ toolkitRoot, cwd }) {
  const project = loadProjectConfig(cwd);
  const toolkit = loadToolkit(toolkitRoot);
  const selection = computeSelection(toolkit, project, new Set());
  return collectAgentAvatars({ toolkit, project, selection });
}

// ---- Real HTTP + rasterizer wiring (never exercised by `npm test`) ---------------------

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '';
  }
}

/** A `fetch`-based Gravatar v3 client. Injectable `fetchImpl` keeps it swappable in tests. */
export function makeGravatarHttp(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('global fetch is unavailable — Node 18+ is required for `avatars sync`');
  }
  const auth = (token) => ({ Authorization: `Bearer ${token}` });
  return {
    async getAssociatedEmail({ token, emailHash: hash }) {
      const res = await fetchImpl(`${GRAVATAR_BASE}/me/associated-email?email_hash=${hash}`, {
        headers: auth(token),
      });
      // A not-associated email is reported as 404 by the account scope; treat it as "not verified"
      // rather than an error, since that is the drift signal the pipeline acts on.
      if (res.status === 404) return { associated: false };
      if (!res.ok) throw new Error(`Gravatar associated-email probe failed: ${res.status} ${await safeText(res)}`);
      const body = await res.json().catch(() => ({}));
      return { associated: Boolean(body.associated ?? true) };
    },
    async uploadAvatar({ token, emailHash: hash, image }) {
      const form = new FormData();
      form.append('image', new Blob([image], { type: 'image/png' }), 'avatar.png');
      const res = await fetchImpl(
        `${GRAVATAR_BASE}/me/avatars?selected_email_hash=${hash}&select_avatar=true`,
        { method: 'POST', headers: auth(token), body: form },
      );
      if (!res.ok) throw new Error(`Gravatar upload failed: ${res.status} ${await safeText(res)}`);
      const body = await res.json();
      const imageId = body.imageId ?? body.image_id;
      if (!imageId) throw new Error('Gravatar upload returned no imageId');
      return { imageId };
    },
    async setRating({ token, imageId, rating }) {
      const res = await fetchImpl(`${GRAVATAR_BASE}/me/avatars/${imageId}`, {
        method: 'PATCH',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      if (!res.ok) throw new Error(`Gravatar rating PATCH failed: ${res.status} ${await safeText(res)}`);
    },
    async associateAvatarEmail({ token, imageId, emailHash: hash }) {
      const res = await fetchImpl(`${GRAVATAR_BASE}/me/avatars/${imageId}/email`, {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email_hash: hash }),
      });
      if (!res.ok) throw new Error(`Gravatar email association failed: ${res.status} ${await safeText(res)}`);
    },
  };
}

// SVG→PNG through whichever converter the machine has — the same trio AVATARS.md documents. No
// pure-JS rasterizer is a toolkit dependency (a native dep is heavy for one owner-side command),
// so shell out behind this injected function and fail clearly when none is installed.
export const RASTERIZERS = [
  { cmd: 'rsvg-convert', args: (svg, png) => ['-w', '512', '-h', '512', '-o', png, svg] },
  // ImageMagick 7 (`magick`) and 6 (`convert`, no `magick` binary) share the arg vector. `-density
  // 512` rasterizes the SVG at target resolution up front — without it IM rasterizes at its default
  // ~96 DPI and then upscales to 512, giving a visibly softer PNG than the rsvg path.
  { cmd: 'magick', args: (svg, png) => ['-density', '512', '-background', 'none', svg, '-resize', '512x512', png] },
  { cmd: 'convert', args: (svg, png) => ['-density', '512', '-background', 'none', svg, '-resize', '512x512', png] },
  // Zero-install fallback: wafflestack is a Node CLI, so `npx` is guaranteed present. `--yes` fetches
  // svgexport on demand — the "node, no install" converter .waffle/AVATARS.md documents. Probed via
  // `npx --version` (that `npx` exists), not by installing svgexport just to detect it.
  { cmd: 'npx', args: (svg, png) => ['--yes', 'svgexport', svg, png, '512:512'] },
];

function detectRasterizer() {
  for (const r of RASTERIZERS) {
    try {
      execFileSync(r.cmd, ['--version'], { stdio: 'ignore' });
      return r;
    } catch {
      // try the next one
    }
  }
  return null;
}

/** A shell-based SVG→512px-PNG rasterizer. Returns `async (svg) => Buffer`. */
export function makeShellRasterizer() {
  const tool = detectRasterizer();
  if (!tool) {
    throw new Error(
      'no SVG rasterizer found — install one of: rsvg-convert (librsvg), magick/convert (ImageMagick), ' +
        'or ensure `npx` is on PATH for the zero-install `npx --yes svgexport` path; ' +
        'or upload the PNGs by hand per .waffle/AVATARS.md',
    );
  }
  return async (svg) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'waffle-avatar-'));
    const svgPath = path.join(dir, 'in.svg');
    const pngPath = path.join(dir, 'out.png');
    try {
      fs.writeFileSync(svgPath, svg);
      execFileSync(tool.cmd, tool.args(svgPath, pngPath), { stdio: 'ignore' });
      return fs.readFileSync(pngPath);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * CLI entry point: enumerate the installed roster, wire the real Gravatar client + shell rasterizer
 * (unless injected for tests), and run the engine. `mode` is `'sync'` or `'status'`.
 */
export async function runAvatarsSync({
  toolkitRoot,
  cwd,
  mode = 'sync',
  env = process.env,
  log = console.log,
  http,
  rasterize,
} = {}) {
  const token = env[TOKEN_ENV];
  const { rows, git } = enumerateAgentAvatars({ toolkitRoot, cwd });
  if (!git.baseEmail) {
    log(
      'no bot identity is configured (`git.cmd` sets no committer email), so there are no per-agent ' +
        'addresses to register. See .waffle/AVATARS.md.',
    );
    return { synced: [], pending: [], skipped: rows, mode };
  }
  // status mode never rasterizes or uploads, so it needs no rasterizer — but it still needs a
  // token: the associated-email probe is authenticated, so `syncAvatars` throws NO_TOKEN without one.
  const client = http ?? makeGravatarHttp();
  const raster = rasterize ?? (mode === 'status' ? null : makeShellRasterizer());
  return syncAvatars({ agents: rows, token, http: client, rasterize: raster, log, mode });
}
