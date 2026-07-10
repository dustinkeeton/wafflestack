import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  emailHash,
  syncAvatars,
  makeGravatarHttp,
  avatarsExitCode,
  TOKEN_ENV,
  GRAVATAR_BASE,
} from '../lib/avatars-sync.mjs';

// A recording mock HTTP client — no network. `associated` decides whether each hashed email is
// reported as verified on the account.
function mockHttp({ associated = () => true } = {}) {
  const calls = [];
  let nextId = 100;
  return {
    calls,
    async getAssociatedEmail({ token, emailHash: hash }) {
      calls.push(['getAssociatedEmail', { token, hash }]);
      return { associated: associated(hash) };
    },
    async uploadAvatar({ token, emailHash: hash, image }) {
      calls.push(['uploadAvatar', { token, hash, image }]);
      return { imageId: `img-${nextId++}` };
    },
    async setRating({ token, imageId, rating }) {
      calls.push(['setRating', { token, imageId, rating }]);
    },
    async associateAvatarEmail({ token, imageId, emailHash: hash }) {
      calls.push(['associateAvatarEmail', { token, imageId, hash }]);
    },
  };
}

const rasterizeStub = async (svg) => Buffer.from(`PNG:${svg}`);

const AGENTS = [
  { name: 'captain', email: 'bot+captain@wafflenet.io', svg: '<svg>captain</svg>' },
  { name: 'scout', email: 'bot+scout@wafflenet.io', svg: '<svg>scout</svg>' },
];

describe('avatars-sync: emailHash', () => {
  test('is the sha256 of the lowercased, trimmed email', () => {
    const expected = crypto.createHash('sha256').update('bot+captain@wafflenet.io').digest('hex');
    assert.equal(emailHash('bot+captain@wafflenet.io'), expected);
    assert.equal(emailHash('  BOT+Captain@Wafflenet.IO '), expected, 'trimmed and lowercased');
  });
});

describe('avatars-sync: syncAvatars engine', () => {
  test('missing token fails cleanly with a NO_TOKEN code, before any HTTP call', async () => {
    const http = mockHttp();
    await assert.rejects(
      () => syncAvatars({ agents: AGENTS, token: '', http, rasterize: rasterizeStub }),
      (err) => {
        assert.equal(err.code, 'NO_TOKEN');
        assert.match(err.message, new RegExp(TOKEN_ENV));
        return true;
      },
    );
    assert.equal(http.calls.length, 0, 'no probe is made without a token');
  });

  test('an associated address is uploaded, rated G, then assigned — with the right args', async () => {
    const http = mockHttp({ associated: () => true });
    const result = await syncAvatars({ agents: AGENTS, token: 'tok', http, rasterize: rasterizeStub });

    assert.deepEqual(result.synced.map((a) => a.name), ['captain', 'scout']);
    assert.equal(result.pending.length, 0);

    const captainHash = emailHash('bot+captain@wafflenet.io');
    // Probe, upload, rating, assign — in order, for captain.
    assert.deepEqual(http.calls[0], ['getAssociatedEmail', { token: 'tok', hash: captainHash }]);
    assert.deepEqual(http.calls[1], [
      'uploadAvatar',
      { token: 'tok', hash: captainHash, image: Buffer.from('PNG:<svg>captain</svg>') },
    ]);
    assert.equal(http.calls[2][0], 'setRating');
    assert.equal(http.calls[2][1].rating, 'G', 'GitHub shows G-rated only');
    assert.deepEqual(http.calls[3], [
      'associateAvatarEmail',
      { token: 'tok', imageId: http.calls[2][1].imageId, hash: captainHash },
    ]);
  });

  test('an unassociated address is skipped and reported in the pending remainder — never uploaded', async () => {
    const http = mockHttp({ associated: (hash) => hash === emailHash('bot+captain@wafflenet.io') });
    const result = await syncAvatars({ agents: AGENTS, token: 'tok', http, rasterize: rasterizeStub });

    assert.deepEqual(result.synced.map((a) => a.name), ['captain']);
    assert.deepEqual(result.pending.map((a) => a.name), ['scout'], 'scout is not verified → manual remainder');
    // No upload/rate/assign call ever carries scout's hash.
    const scoutHash = emailHash('bot+scout@wafflenet.io');
    assert.ok(!http.calls.some(([m, a]) => m !== 'getAssociatedEmail' && a.hash === scoutHash));
  });

  test('an agent with no email (no bot identity / shared verbatim base) is skipped, not probed', async () => {
    const http = mockHttp();
    const result = await syncAvatars({
      agents: [{ name: 'lone', email: null, svg: '<svg/>' }],
      token: 'tok',
      http,
      rasterize: rasterizeStub,
    });
    assert.deepEqual(result.skipped.map((a) => a.name), ['lone']);
    assert.equal(http.calls.length, 0);
  });

  test('status mode probes and reports but never rasterizes or uploads', async () => {
    const http = mockHttp({ associated: (hash) => hash === emailHash('bot+captain@wafflenet.io') });
    let rasterized = false;
    const result = await syncAvatars({
      agents: AGENTS,
      token: 'tok',
      http,
      rasterize: async () => {
        rasterized = true;
        return Buffer.from('x');
      },
      mode: 'status',
    });
    assert.equal(rasterized, false, 'status never rasterizes');
    assert.ok(http.calls.every(([m]) => m === 'getAssociatedEmail'), 'status makes only probes');
    assert.deepEqual(result.synced.map((a) => a.name), ['captain'], 'registered');
    assert.deepEqual(result.pending.map((a) => a.name), ['scout'], 'drifted');
  });
});

describe('avatars-sync: makeGravatarHttp (fetch shape, mocked fetch)', () => {
  const jsonRes = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  });

  test('a 404 on the associated-email probe reads as not-associated, not an error', async () => {
    const http = makeGravatarHttp(async () => jsonRes(404, {}));
    assert.deepEqual(await http.getAssociatedEmail({ token: 't', emailHash: 'abc' }), { associated: false });
  });

  test('the probe targets the v3 associated-email endpoint with the hash and a bearer token', async () => {
    let seen;
    const http = makeGravatarHttp(async (url, opts) => {
      seen = { url, opts };
      return jsonRes(200, { associated: true });
    });
    const out = await http.getAssociatedEmail({ token: 'secret', emailHash: 'deadbeef' });
    assert.deepEqual(out, { associated: true });
    assert.equal(seen.url, `${GRAVATAR_BASE}/me/associated-email?email_hash=deadbeef`);
    assert.equal(seen.opts.headers.Authorization, 'Bearer secret');
  });

  test('a non-404 error surfaces as a thrown error rather than a silent skip', async () => {
    const http = makeGravatarHttp(async () => jsonRes(500, { error: 'boom' }));
    await assert.rejects(() => http.getAssociatedEmail({ token: 't', emailHash: 'abc' }), /500/);
  });

  // The three write methods carry the real mutation logic (query params, snake/camel id extraction,
  // JSON bodies). Without these a wrong field name would ship green and only fail against the live
  // API. Each case mirrors the probe tests: assert the fetch shape, and that a non-2xx throws.
  test('uploadAvatar POSTs multipart to the avatars endpoint with the select query params', async () => {
    let seen;
    const http = makeGravatarHttp(async (url, opts) => {
      seen = { url, opts };
      return jsonRes(200, { image_id: 'img-xyz' });
    });
    const out = await http.uploadAvatar({ token: 'secret', emailHash: 'deadbeef', image: Buffer.from('PNG') });
    assert.equal(out.imageId, 'img-xyz', 'reads the snake_case image_id the API returns');
    assert.equal(seen.url, `${GRAVATAR_BASE}/me/avatars?selected_email_hash=deadbeef&select_avatar=true`);
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers.Authorization, 'Bearer secret');
    assert.ok(seen.opts.body instanceof FormData, 'multipart form body');
  });

  test('uploadAvatar also accepts the camelCase imageId, and throws when the id is missing', async () => {
    const camel = makeGravatarHttp(async () => jsonRes(200, { imageId: 'img-camel' }));
    assert.equal((await camel.uploadAvatar({ token: 't', emailHash: 'h', image: Buffer.from('x') })).imageId, 'img-camel');

    const noId = makeGravatarHttp(async () => jsonRes(200, {}));
    await assert.rejects(() => noId.uploadAvatar({ token: 't', emailHash: 'h', image: Buffer.from('x') }), /no imageId/);
  });

  test('uploadAvatar surfaces a non-2xx as a thrown error', async () => {
    const http = makeGravatarHttp(async () => jsonRes(413, { error: 'too big' }));
    await assert.rejects(() => http.uploadAvatar({ token: 't', emailHash: 'h', image: Buffer.from('x') }), /413/);
  });

  test('setRating PATCHes a JSON {rating} body to the per-image endpoint', async () => {
    let seen;
    const http = makeGravatarHttp(async (url, opts) => {
      seen = { url, opts };
      return jsonRes(200, {});
    });
    await http.setRating({ token: 'secret', imageId: 'img-1', rating: 'G' });
    assert.equal(seen.url, `${GRAVATAR_BASE}/me/avatars/img-1`);
    assert.equal(seen.opts.method, 'PATCH');
    assert.equal(seen.opts.headers.Authorization, 'Bearer secret');
    assert.equal(seen.opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(seen.opts.body), { rating: 'G' });
  });

  test('setRating surfaces a non-2xx as a thrown error', async () => {
    const http = makeGravatarHttp(async () => jsonRes(422, { error: 'bad rating' }));
    await assert.rejects(() => http.setRating({ token: 't', imageId: 'img-1', rating: 'G' }), /422/);
  });

  test('associateAvatarEmail POSTs a JSON {email_hash} body to the image email endpoint', async () => {
    let seen;
    const http = makeGravatarHttp(async (url, opts) => {
      seen = { url, opts };
      return jsonRes(200, {});
    });
    await http.associateAvatarEmail({ token: 'secret', imageId: 'img-1', emailHash: 'deadbeef' });
    assert.equal(seen.url, `${GRAVATAR_BASE}/me/avatars/img-1/email`);
    assert.equal(seen.opts.method, 'POST');
    assert.equal(seen.opts.headers.Authorization, 'Bearer secret');
    assert.equal(seen.opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(seen.opts.body), { email_hash: 'deadbeef' });
  });

  test('associateAvatarEmail surfaces a non-2xx as a thrown error', async () => {
    const http = makeGravatarHttp(async () => jsonRes(404, { error: 'no such image' }));
    await assert.rejects(
      () => http.associateAvatarEmail({ token: 't', imageId: 'img-1', emailHash: 'h' }),
      /404/,
    );
  });
});

describe('avatars-sync: avatarsExitCode (the #285 drift gate)', () => {
  test('status with a non-empty pending remainder exits non-zero so CI can gate on drift', () => {
    assert.equal(avatarsExitCode({ mode: 'status', pending: [{ name: 'scout' }] }), 1);
  });

  test('status with no drift exits 0', () => {
    assert.equal(avatarsExitCode({ mode: 'status', pending: [] }), 0);
  });

  test('sync never gates on the pending remainder — it exits 0 even with pending addresses', () => {
    assert.equal(avatarsExitCode({ mode: 'sync', pending: [{ name: 'scout' }] }), 0);
  });

  test('the engine result feeds the gate: a drifted status run maps to a non-zero exit', async () => {
    // End-to-end: run the engine in status mode against a roster with an unverified address, then
    // map its result through the same helper the CLI uses. Pins the gate against a flipped ternary
    // or a mis-shaped `pending`.
    const http = mockHttp({ associated: (hash) => hash === emailHash('bot+captain@wafflenet.io') });
    const result = await syncAvatars({ agents: AGENTS, token: 'tok', http, rasterize: rasterizeStub, mode: 'status' });
    assert.ok(result.pending.length > 0, 'scout drifted → pending remainder');
    assert.equal(avatarsExitCode({ mode: 'status', pending: result.pending }), 1);
  });
});
