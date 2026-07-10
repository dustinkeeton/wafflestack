import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  emailHash,
  syncAvatars,
  makeGravatarHttp,
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
});
