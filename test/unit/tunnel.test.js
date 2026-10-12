import assert from 'node:assert/strict';
import { execFileSync, spawn as nodeSpawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  assetFor,
  cloudflareProvider,
  defaultHome,
  downloadUrl,
  ensureCloudflared,
  findOnPath,
  isRateLimitLine,
  parseTunnelUrl,
  probeTunnelDns,
  startTunnel,
} from '../../src/tunnel.js';

const FAKE_BINARY = '#!/bin/sh\necho fake cloudflared\n';

describe('parseTunnelUrl', () => {
  it('finds the URL in the boxed banner cloudflared logs to stderr', () => {
    const log = [
      '2024-01-01T00:00:00Z INF Thank you for trying Cloudflare Tunnel.',
      '2024-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...',
      '2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+',
      '2024-01-01T00:00:00Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |',
      '2024-01-01T00:00:00Z INF |  https://foo-bar-baz.trycloudflare.com                                                      |',
      '2024-01-01T00:00:00Z INF +--------------------------------------------------------------------------------------------+',
    ].join('\n');
    assert.equal(parseTunnelUrl(log), 'https://foo-bar-baz.trycloudflare.com');
  });

  it('works on a single line', () => {
    assert.equal(
      parseTunnelUrl('2024-01-01T00:00:00Z INF |  https://foo-bar-baz.trycloudflare.com  |'),
      'https://foo-bar-baz.trycloudflare.com',
    );
  });

  it('ignores api.trycloudflare.com', () => {
    const log = [
      '2024-01-01T00:00:00Z ERR Error unmarshaling QuickTunnel response url=https://api.trycloudflare.com/tunnel',
      '2024-01-01T00:00:00Z INF |  https://quiet-river-1234.trycloudflare.com  |',
    ].join('\n');
    assert.equal(parseTunnelUrl(log), 'https://quiet-river-1234.trycloudflare.com');
    assert.equal(parseTunnelUrl('POST https://api.trycloudflare.com/tunnel failed'), null);
  });

  it('returns the first match and null when absent', () => {
    assert.equal(parseTunnelUrl('https://a-b.trycloudflare.com then https://c-d.trycloudflare.com'), 'https://a-b.trycloudflare.com');
    assert.equal(parseTunnelUrl('INF Starting metrics server on 127.0.0.1:20241/metrics'), null);
    assert.equal(parseTunnelUrl(''), null);
    assert.equal(parseTunnelUrl('http://foo.trycloudflare.com'), null);
  });
});

describe('assetFor / downloadUrl / defaultHome', () => {
  it('maps supported platforms to release assets', () => {
    assert.deepEqual(assetFor('darwin', 'arm64'), { asset: 'cloudflared-darwin-arm64.tgz', archive: 'tgz', binName: 'cloudflared' });
    assert.deepEqual(assetFor('darwin', 'x64'), { asset: 'cloudflared-darwin-amd64.tgz', archive: 'tgz', binName: 'cloudflared' });
    assert.deepEqual(assetFor('linux', 'x64'), { asset: 'cloudflared-linux-amd64', archive: null, binName: 'cloudflared' });
    assert.deepEqual(assetFor('linux', 'arm64'), { asset: 'cloudflared-linux-arm64', archive: null, binName: 'cloudflared' });
    assert.deepEqual(assetFor('win32', 'x64'), { asset: 'cloudflared-windows-amd64.exe', archive: null, binName: 'cloudflared.exe' });
    assert.deepEqual(assetFor('linux', 'arm'), { asset: 'cloudflared-linux-arm', archive: null, binName: 'cloudflared' });
    assert.deepEqual(assetFor('linux', 'ia32'), { asset: 'cloudflared-linux-386', archive: null, binName: 'cloudflared' });
    assert.deepEqual(assetFor('win32', 'ia32'), { asset: 'cloudflared-windows-386.exe', archive: null, binName: 'cloudflared.exe' });
  });

  it('throws a clear error for unsupported platforms', () => {
    assert.throws(() => assetFor('freebsd', 'x64'), /unsupported platform freebsd\/x64/);
    assert.throws(() => assetFor('linux', 'ppc64'), /unsupported platform linux\/ppc64/);
    assert.throws(() => assetFor('darwin', 'ia32'), /unsupported platform darwin\/ia32/);
  });

  it('builds download URLs, honouring the env override', () => {
    const saved = process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE;
    try {
      delete process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE;
      assert.equal(
        downloadUrl('cloudflared-linux-amd64'),
        'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
      );
      process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE = 'http://127.0.0.1:1/x/';
      assert.equal(downloadUrl('a.tgz'), 'http://127.0.0.1:1/x/a.tgz');
      assert.equal(downloadUrl('a.tgz', 'http://example.test/y'), 'http://example.test/y/a.tgz');
    } finally {
      if (saved === undefined) delete process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE;
      else process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE = saved;
    }
  });

  it('defaultHome honours LOCAL_BPMN_HOME', () => {
    const saved = process.env.LOCAL_BPMN_HOME;
    try {
      process.env.LOCAL_BPMN_HOME = '/some/where';
      assert.equal(defaultHome(), '/some/where');
      delete process.env.LOCAL_BPMN_HOME;
      assert.match(defaultHome(), /\.local-bpmn$/);
    } finally {
      if (saved === undefined) delete process.env.LOCAL_BPMN_HOME;
      else process.env.LOCAL_BPMN_HOME = saved;
    }
  });
});

describe('findOnPath', () => {
  let dir;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'local-bpmn-path-'));
    await mkdir(join(dir, 'a'));
    await mkdir(join(dir, 'b'));
    await writeFile(join(dir, 'a', 'tool'), FAKE_BINARY, { mode: 0o644 }); // not executable
    await writeFile(join(dir, 'b', 'tool'), FAKE_BINARY, { mode: 0o755 });
    await mkdir(join(dir, 'a', 'dironly'));
    await writeFile(join(dir, 'b', 'cloudflared.exe'), FAKE_BINARY, { mode: 0o755 });
  });
  after(() => rm(dir, { recursive: true, force: true }));

  it('returns the first executable match', async () => {
    const env = { PATH: [join(dir, 'a'), join(dir, 'b')].join(':') };
    assert.equal(await findOnPath('tool', { env, platform: 'linux' }), join(dir, 'b', 'tool'));
  });

  it('returns null when missing, for directories and with an empty PATH', async () => {
    const env = { PATH: [join(dir, 'a'), join(dir, 'b')].join(':') };
    assert.equal(await findOnPath('nope', { env, platform: 'linux' }), null);
    assert.equal(await findOnPath('dironly', { env, platform: 'linux' }), null);
    assert.equal(await findOnPath('tool', { env: {}, platform: 'linux' }), null);
  });

  it('adds .exe and uses ; on win32', async () => {
    const env = { Path: `${join(dir, 'a')};${join(dir, 'b')}`, PATHEXT: '.COM;.EXE' };
    assert.equal(await findOnPath('cloudflared', { env, platform: 'win32' }), join(dir, 'b', 'cloudflared.exe'));
  });
});

describe('ensureCloudflared', () => {
  let server;
  let base;
  const hits = new Map();
  let tgz;
  let workDir;

  before(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'local-bpmn-dl-'));
    // A tgz shaped like the real darwin asset: a single `cloudflared` binary at the root.
    const src = join(workDir, 'src');
    await mkdir(src);
    await writeFile(join(src, 'cloudflared'), FAKE_BINARY, { mode: 0o644 });
    execFileSync('tar', ['-czf', join(workDir, 'fake.tgz'), '-C', src, 'cloudflared']);
    tgz = await readFile(join(workDir, 'fake.tgz'));

    server = http.createServer((req, res) => {
      hits.set(req.url, (hits.get(req.url) || 0) + 1);
      if (req.url === '/rel/cloudflared-linux-amd64') {
        // Slow-ish body so concurrent callers overlap with the in-flight download.
        res.writeHead(200, { 'content-length': Buffer.byteLength(FAKE_BINARY) });
        setTimeout(() => res.end(FAKE_BINARY), 100);
      } else if (req.url === '/rel/cloudflared-darwin-arm64.tgz') {
        res.writeHead(200, { 'content-length': tgz.length });
        res.end(tgz);
      } else if (req.url === '/redirect/cloudflared-linux-arm64') {
        res.writeHead(302, { location: '/rel/cloudflared-linux-amd64' });
        res.end();
      } else if (req.url === '/broken/cloudflared-darwin-arm64.tgz') {
        res.writeHead(200);
        res.end('this is not a tarball');
      } else {
        res.writeHead(404);
        res.end('not found');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await rm(workDir, { recursive: true, force: true });
  });

  async function freshHome() {
    return mkdtemp(join(workDir, 'home-'));
  }

  it('downloads a raw binary into <home>/bin, then reuses the cache without network', async () => {
    const home = await freshHome();
    const events = [];
    const opts = { home, baseUrl: `${base}/rel`, usePath: false, platform: 'linux', arch: 'x64', onProgress: (e) => events.push(e) };
    const before = hits.get('/rel/cloudflared-linux-amd64') || 0;
    const bin = await ensureCloudflared(opts);
    assert.equal(bin, join(home, 'bin', 'cloudflared'));
    assert.equal(await readFile(bin, 'utf8'), FAKE_BINARY);
    assert.equal(execFileSync(bin).toString().trim(), 'fake cloudflared'); // executable
    assert.ok(events.some((e) => e.phase === 'download' && e.received > 0 && e.total === Buffer.byteLength(FAKE_BINARY)));
    assert.deepEqual(events.at(-1), { phase: 'done', path: bin });
    assert.deepEqual(await readdir(join(home, 'bin')), ['cloudflared']); // no temp leftovers

    events.length = 0;
    assert.equal(await ensureCloudflared(opts), bin);
    assert.deepEqual(events, [{ phase: 'cached', path: bin }]);
    assert.equal(hits.get('/rel/cloudflared-linux-amd64'), before + 1);
  });

  it('shares one in-flight download between concurrent callers', async () => {
    const home = await freshHome();
    const opts = { home, baseUrl: `${base}/rel`, usePath: false, platform: 'linux', arch: 'x64' };
    const before = hits.get('/rel/cloudflared-linux-amd64') || 0;
    const [a, b] = await Promise.all([ensureCloudflared(opts), ensureCloudflared(opts)]);
    assert.equal(a, b);
    assert.equal(hits.get('/rel/cloudflared-linux-amd64'), before + 1);
  });

  it('follows redirects', async () => {
    const home = await freshHome();
    const bin = await ensureCloudflared({ home, baseUrl: `${base}/redirect`, usePath: false, platform: 'linux', arch: 'arm64' });
    assert.equal(await readFile(bin, 'utf8'), FAKE_BINARY);
  });

  it('extracts the binary from a tgz asset', async () => {
    const home = await freshHome();
    const events = [];
    const bin = await ensureCloudflared({
      home, baseUrl: `${base}/rel`, usePath: false, platform: 'darwin', arch: 'arm64', onProgress: (e) => events.push(e),
    });
    assert.equal(bin, join(home, 'bin', 'cloudflared'));
    assert.equal(await readFile(bin, 'utf8'), FAKE_BINARY);
    assert.equal(execFileSync(bin).toString().trim(), 'fake cloudflared');
    assert.ok(events.some((e) => e.phase === 'extract'));
    assert.deepEqual(await readdir(join(home, 'bin')), ['cloudflared']);
  });

  it('HTTP 404: clear error naming status and URL, nothing left in the cache', async () => {
    const home = await freshHome();
    await assert.rejects(
      ensureCloudflared({ home, baseUrl: `${base}/missing`, usePath: false, platform: 'linux', arch: 'x64' }),
      (err) => {
        assert.match(err.message, /Failed to download cloudflared from http:\/\/127\.0\.0\.1:\d+\/missing\/cloudflared-linux-amd64: HTTP 404/);
        return true;
      },
    );
    assert.deepEqual(await readdir(join(home, 'bin')), []);
  });

  it('honours LOCAL_BPMN_CLOUDFLARED_URL_BASE', async () => {
    const home = await freshHome();
    const saved = process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE;
    process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE = `${base}/bogus`;
    try {
      await assert.rejects(
        ensureCloudflared({ home, usePath: false, platform: 'linux', arch: 'x64' }),
        /\/bogus\/cloudflared-linux-amd64: HTTP 404/,
      );
    } finally {
      if (saved === undefined) delete process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE;
      else process.env.LOCAL_BPMN_CLOUDFLARED_URL_BASE = saved;
    }
    assert.deepEqual(await readdir(join(home, 'bin')), []);
  });

  it('a broken archive fails cleanly', async () => {
    const home = await freshHome();
    await assert.rejects(
      ensureCloudflared({ home, baseUrl: `${base}/broken`, usePath: false, platform: 'darwin', arch: 'arm64' }),
      /Failed to extract cloudflared from/,
    );
    assert.deepEqual(await readdir(join(home, 'bin')), []);
  });

  it('a connection failure is reported with the URL', async () => {
    const home = await freshHome();
    await assert.rejects(
      ensureCloudflared({ home, baseUrl: 'http://127.0.0.1:1/x', usePath: false, platform: 'linux', arch: 'x64' }),
      /Failed to download cloudflared from http:\/\/127\.0\.0\.1:1\/x\/cloudflared-linux-amd64/,
    );
    assert.deepEqual(await readdir(join(home, 'bin')), []);
  });

  it('prefers a cloudflared found on PATH', async () => {
    const home = await freshHome();
    const pathDir = join(home, 'pathbin');
    await mkdir(pathDir);
    await writeFile(join(pathDir, 'cloudflared'), FAKE_BINARY);
    await chmod(join(pathDir, 'cloudflared'), 0o755);
    const saved = process.env.PATH;
    process.env.PATH = pathDir;
    const events = [];
    try {
      const bin = await ensureCloudflared({ home, baseUrl: `${base}/missing`, platform: 'linux', arch: 'x64', onProgress: (e) => events.push(e) });
      assert.equal(bin, join(pathDir, 'cloudflared'));
    } finally {
      process.env.PATH = saved;
    }
    assert.deepEqual(events, [{ phase: 'path', path: join(pathDir, 'cloudflared') }]);
  });

  it('uses cloudflared from PATH even on a platform without a release asset', async () => {
    const home = await freshHome();
    const pathDir = join(home, 'pathbin');
    await mkdir(pathDir);
    await writeFile(join(pathDir, 'cloudflared'), FAKE_BINARY, { mode: 0o755 });
    const saved = process.env.PATH;
    process.env.PATH = pathDir;
    try {
      assert.equal(await ensureCloudflared({ home, platform: 'freebsd', arch: 'x64' }), join(pathDir, 'cloudflared'));
    } finally {
      process.env.PATH = saved;
    }
    // Without PATH it still fails clearly, and nothing is created in the cache.
    await assert.rejects(ensureCloudflared({ home, usePath: false, platform: 'freebsd', arch: 'x64' }), /unsupported platform freebsd\/x64/);
  });
});

describe('isRateLimitLine', () => {
  it('recognises cloudflared 429 messages only', () => {
    assert.equal(isRateLimitLine('2024-01-01T00:00:00Z ERR failed to request quick Tunnel: quick tunnel provisioning failed with status 429'), true);
    assert.equal(isRateLimitLine('ERR Error unmarshaling QuickTunnel response: status_code="429 Too Many Requests"'), true);
    assert.equal(isRateLimitLine('INF |  https://foo-429-bar.trycloudflare.com  |'), false);
    assert.equal(isRateLimitLine('ERR quick tunnel provisioning failed with status 500'), false);
  });
});

describe('probeTunnelDns', () => {
  it('reports unavailable when the resolvers cannot be reached', async () => {
    // 127.0.0.1:1 has no DNS server, so the query fails with a connection error / timeout, not NXDOMAIN.
    assert.deepEqual(await probeTunnelDns('example.com', { servers: ['127.0.0.1:1'], timeoutMs: 300 }), { state: 'unavailable' });
  });
});

describe('cloudflareProvider with fake cloudflared processes', () => {
  const FAKE_URL = 'https://fake-tunnel-host.trycloudflare.com';
  const spawned = [];

  /** Spawns `node -e script` instead of cloudflared, recording the args it would have received. */
  function fakeSpawn(script) {
    return (bin, args, opts) => {
      const child = nodeSpawn(process.execPath, ['-e', script], opts);
      spawned.push({ bin, args, opts, child });
      return child;
    };
  }
  const ok = async () => ({ status: 200, server: 'cloudflare', body: '' });
  const dnsFound = async () => ({ state: 'found', address: '192.0.2.1' });
  const isGone = (child) => child.exitCode !== null || child.signalCode !== null;

  after(() => {
    for (const { child } of spawned) if (!isGone(child)) child.kill('SIGKILL');
  });

  const printsUrl = `
    console.error('2024-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');
    console.error('2024-01-01T00:00:00Z INF |  ${FAKE_URL}  |');
    setInterval(() => {}, 1000);
  `;

  it('resolves with the URL once it answers, and stop() kills the process', async () => {
    const phases = [];
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared', spawn: fakeSpawn(printsUrl), probeHttp: ok, probeDns: dnsFound, onProgress: (e) => phases.push(e.phase),
    });
    const tunnel = await startTunnel({ port: 4321, provider });
    const { args, opts, child } = spawned.at(-1);
    assert.deepEqual(args, ['tunnel', '--url', 'http://127.0.0.1:4321', '--no-autoupdate']);
    assert.equal(opts.windowsHide, true);
    assert.equal(tunnel.url, FAKE_URL);
    assert.equal(tunnel.provider, 'cloudflare');
    assert.deepEqual(phases, ['spawn', 'url', 'dns', 'ready']);
    assert.equal(isGone(child), false);
    await tunnel.stop();
    assert.equal(isGone(child), true);
    await tunnel.stop(); // idempotent
  });

  it('waits while Cloudflare answers 530 and while DNS is missing', async () => {
    let dnsCalls = 0;
    const probed = [];
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared',
      spawn: fakeSpawn(printsUrl),
      pollIntervalMs: 20,
      probeDns: async () => (++dnsCalls < 3 ? { state: 'missing' } : { state: 'found', address: '192.0.2.7' }),
      probeHttp: async (url, opts) => {
        probed.push({ url, address: opts.address });
        if (probed.length === 1) return { status: 530, server: 'cloudflare', body: 'error code: 1033' };
        if (probed.length === 2) return { status: 502, server: 'cloudflare', body: '<title>Cloudflare Tunnel error</title>' };
        return { status: 302, server: 'cloudflare', body: '' };
      },
    });
    const tunnel = await provider.start(4321);
    assert.equal(dnsCalls, 3);
    assert.equal(probed.length, 3);
    // The HTTP probe connects to the publicly resolved address instead of using the system resolver.
    assert.deepEqual(probed[0], { url: FAKE_URL, address: '192.0.2.7' });
    await tunnel.stop();
  });

  it('falls back to the system resolver when public DNS is unavailable', async () => {
    const probed = [];
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared',
      spawn: fakeSpawn(printsUrl),
      probeDns: async () => ({ state: 'unavailable' }),
      probeHttp: async (url, opts) => { probed.push(opts.address); return { status: 404, server: 'cloudflare', body: '' }; },
    });
    const tunnel = await provider.start(4321);
    assert.deepEqual(probed, [undefined]);
    await tunnel.stop();
  });

  it('rejects on timeout when no URL appears, after killing the process', async () => {
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared',
      spawn: fakeSpawn(`console.error('INF starting up'); setInterval(() => {}, 1000);`),
      timeoutMs: 500,
    });
    await assert.rejects(provider.start(4321), (err) => {
      assert.match(err.message, /cloudflared did not print a tunnel URL within 500 ms/);
      assert.match(err.message, /INF starting up/);
      return true;
    });
    assert.equal(isGone(spawned.at(-1).child), true);
  });

  it('rejects on timeout when the URL never becomes reachable', async () => {
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared',
      spawn: fakeSpawn(printsUrl),
      timeoutMs: 600,
      pollIntervalMs: 20,
      probeDns: dnsFound,
      probeHttp: async () => { throw new Error('connect ECONNREFUSED'); },
    });
    await assert.rejects(provider.start(4321), new RegExp(`${FAKE_URL.replace(/\./g, '\\.')} did not become reachable within 600 ms`));
    assert.equal(isGone(spawned.at(-1).child), true);
  });

  it('rejects with exit code and recent output when the process exits early', async () => {
    const script = `
      for (let i = 1; i <= 30; i++) console.error('log line ' + i);
      console.error('ERR failed to request quick Tunnel');
      process.exit(1);
    `;
    const provider = cloudflareProvider({ bin: '/fake/cloudflared', spawn: fakeSpawn(script) });
    await assert.rejects(provider.start(4321), (err) => {
      assert.match(err.message, /exited early \(code 1\)/);
      assert.match(err.message, /ERR failed to request quick Tunnel/);
      assert.match(err.message, /log line 30/);
      assert.doesNotMatch(err.message, /log line 5\n/); // only the most recent lines are kept
      return true;
    });
  });

  const rateLimited = `
    console.error('2024-01-01T00:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...');
    console.error('2024-01-01T00:00:00Z ERR failed to request quick Tunnel: quick tunnel provisioning failed with status 429');
    process.exit(1);
  `;

  it('detects HTTP 429 from Cloudflare and rejects with TUNNEL_RATE_LIMITED after bounded retries', async () => {
    const before = spawned.length;
    const events = [];
    const provider = cloudflareProvider({
      bin: '/fake/cloudflared', spawn: fakeSpawn(rateLimited), retries: 2, retryDelayMs: 50, onProgress: (e) => events.push(e),
    });
    await assert.rejects(provider.start(4321), (err) => {
      assert.equal(err.code, 'TUNNEL_RATE_LIMITED');
      assert.match(err.message, /^Cloudflare is rate-limiting quick tunnels from this network \(HTTP 429\)\. Try again in a few minutes\./);
      assert.match(err.message, /provisioning failed with status 429/);
      return true;
    });
    const attempts = spawned.slice(before);
    assert.equal(attempts.length, 3); // first try + 2 retries
    assert.ok(attempts.every(({ child }) => isGone(child)));
    assert.deepEqual(events.filter((e) => e.phase === 'retry').map((e) => e.delayMs), [50, 100]);
  });

  it('a retry after 429 can succeed', async () => {
    let calls = 0;
    const spawn = (bin, args, opts) => fakeSpawn(++calls === 1 ? rateLimited : printsUrl)(bin, args, opts);
    const provider = cloudflareProvider({ bin: '/fake/cloudflared', spawn, retryDelayMs: 20, probeHttp: ok, probeDns: dnsFound });
    const tunnel = await provider.start(4321);
    assert.equal(calls, 2);
    assert.equal(tunnel.url, FAKE_URL);
    await tunnel.stop();
  });

  it('does not retry beyond the overall deadline', async () => {
    const before = spawned.length;
    const provider = cloudflareProvider({ bin: '/fake/cloudflared', spawn: fakeSpawn(rateLimited), retries: 5, retryDelayMs: 2_000, timeoutMs: 1_000 });
    await assert.rejects(provider.start(4321), { code: 'TUNNEL_RATE_LIMITED' });
    assert.equal(spawned.length - before, 1);
  });

  it('does not retry other failures', async () => {
    const before = spawned.length;
    const provider = cloudflareProvider({ bin: '/fake/cloudflared', spawn: fakeSpawn(`console.error('ERR boom'); process.exit(1);`), retryDelayMs: 10 });
    await assert.rejects(provider.start(4321), (err) => err.code === undefined && /exited early \(code 1\)/.test(err.message));
    assert.equal(spawned.length - before, 1);
  });

  it('rejects clearly when the binary cannot be run', async () => {
    const provider = cloudflareProvider({ bin: join(tmpdir(), 'no-such-dir', 'cloudflared') });
    await assert.rejects(provider.start(4321), /could not run .*no-such-dir\/cloudflared: .*ENOENT/);
  });

  it('stop() escalates to SIGKILL when SIGTERM is ignored', async () => {
    const script = `
      process.on('SIGTERM', () => console.error('ignoring SIGTERM'));
      console.error('INF |  ${FAKE_URL}  |');
      setInterval(() => {}, 1000);
    `;
    const provider = cloudflareProvider({ bin: '/fake/cloudflared', spawn: fakeSpawn(script), probeHttp: ok, probeDns: dnsFound });
    const tunnel = await provider.start(4321);
    const { child } = spawned.at(-1);
    const started = Date.now();
    await tunnel.stop();
    assert.equal(child.signalCode, 'SIGKILL');
    assert.ok(Date.now() - started >= 2_500, 'waited for the grace period first');
  });

  it('startTunnel validates the port', async () => {
    const provider = { name: 'never', start: () => assert.fail('must not start') };
    for (const port of [0, -1, 65536, 1.5, '8080', undefined]) {
      await assert.rejects(startTunnel({ port, provider }), /invalid port/);
    }
  });
});
