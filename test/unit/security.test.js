import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hostAllowed, isRemoteRequest, newHostSecret, newSessionToken, originAllowed, safeEqual, splitSharePath, TOKEN_RE,
} from '../../src/security.js';

describe('secrets and tokens', () => {
  it('host secret: 256-bit base64url, different every time', () => {
    const a = newHostSecret();
    assert.match(a, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(Buffer.from(a, 'base64url').length, 32);
    assert.notEqual(a, newHostSecret());
  });

  it('session token: at least 128-bit base64url, matches TOKEN_RE, different every time', () => {
    const t = newSessionToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    assert.ok(Buffer.from(t, 'base64url').length * 8 >= 128);
    assert.match(t, TOKEN_RE);
    assert.notEqual(t, newSessionToken());
  });

  it('safeEqual: equal non-empty strings only', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
    assert.equal(safeEqual('abc', 'abcd'), false);
    assert.equal(safeEqual('', ''), false);
    assert.equal(safeEqual(undefined, undefined), false);
    assert.equal(safeEqual(null, 'abc'), false);
    assert.equal(safeEqual(['abc'], 'abc'), false);
  });
});

describe('isRemoteRequest', () => {
  it('a Cloudflare header (even empty) marks a request as coming through the tunnel', () => {
    assert.equal(isRemoteRequest({ host: 'localhost:3000' }), false);
    assert.equal(isRemoteRequest({ 'cf-ray': '8a1b2c3d4e5f-LJU' }), true);
    assert.equal(isRemoteRequest({ 'cf-connecting-ip': '203.0.113.9' }), true);
    assert.equal(isRemoteRequest({ 'cf-ray': '' }), true);
  });
});

describe('hostAllowed', () => {
  const opts = { port: 3000, tunnelHost: 'foo-bar.trycloudflare.com' };

  it('accepts the loopback names with our port', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'LOCALHOST:3000']) {
      assert.equal(hostAllowed(host, opts), true, host);
    }
  });

  it('accepts the active tunnel hostname', () => {
    assert.equal(hostAllowed('foo-bar.trycloudflare.com', opts), true);
    assert.equal(hostAllowed('foo-bar.trycloudflare.com:443', opts), true);
    assert.equal(hostAllowed('Foo-Bar.trycloudflare.com', opts), true);
  });

  it('refuses everything else (DNS rebinding, other ports, other tunnels, missing)', () => {
    for (const host of [
      'evil.example:3000', 'localhost', 'localhost:3001', '127.0.0.1', '127.0.0.2:3000', '0.0.0.0:3000',
      'other.trycloudflare.com', 'foo-bar.trycloudflare.com.evil.example', 'foo-bar.trycloudflare.com:8443',
      '', undefined,
    ]) {
      assert.equal(hostAllowed(host, opts), false, String(host));
    }
  });

  it('refuses tunnel hostnames while no tunnel is active', () => {
    assert.equal(hostAllowed('foo-bar.trycloudflare.com', { port: 3000, tunnelHost: null }), false);
  });
});

describe('originAllowed', () => {
  const opts = { port: 3000, tunnelHost: 'foo-bar.trycloudflare.com' };

  it('no Origin header is fine', () => {
    assert.equal(originAllowed(undefined, opts), true);
  });

  it('accepts our own pages', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000', 'https://foo-bar.trycloudflare.com']) {
      assert.equal(originAllowed(origin, opts), true, origin);
    }
  });

  it('refuses other sites, "null", wrong scheme or port', () => {
    for (const origin of [
      'null', 'https://evil.example', 'http://localhost:3001', 'https://localhost:3000', 'http://foo-bar.trycloudflare.com',
      'https://other.trycloudflare.com', 'http://localhost:3000/path', 'file://', 'garbage',
    ]) {
      assert.equal(originAllowed(origin, opts), false, origin);
    }
    assert.equal(originAllowed('https://foo-bar.trycloudflare.com', { port: 3000, tunnelHost: null }), false);
  });
});

describe('splitSharePath', () => {
  it('splits /s/<token>/<rest>', () => {
    assert.deepEqual(splitSharePath('/s/abc/'), { token: 'abc', rest: '/' });
    assert.deepEqual(splitSharePath('/s/abc/api/file'), { token: 'abc', rest: '/api/file' });
    assert.deepEqual(splitSharePath('/s/abc/vendor/x.js'), { token: 'abc', rest: '/vendor/x.js' });
  });

  it('/s/<token> without slash has no rest (redirect)', () => {
    assert.deepEqual(splitSharePath('/s/abc'), { token: 'abc', rest: null });
    assert.deepEqual(splitSharePath('/s/'), { token: '', rest: null });
  });

  it('other paths are not share paths', () => {
    assert.deepEqual(splitSharePath('/'), { token: null, rest: '/' });
    assert.deepEqual(splitSharePath('/api/share'), { token: null, rest: '/api/share' });
    assert.deepEqual(splitSharePath('/sx/abc/'), { token: null, rest: '/sx/abc/' });
  });
});
