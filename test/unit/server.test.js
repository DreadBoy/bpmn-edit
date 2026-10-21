import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { after, before, describe, it } from 'node:test';
import { createServer } from '../../src/server.js';

const FIXTURE = new URL('../fixtures/order.bpmn', import.meta.url).pathname;

/** Raw GET so that paths like /../ are sent unnormalised (fetch would normalise them). */
function rawGet(port, path, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host, port, path, method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('server routes', () => {
  let server;
  before(async () => {
    server = createServer({ filePath: FIXTURE, port: 0 });
    await server.listen();
  });
  after(() => server.close());

  it('exposes the actual port and url', () => {
    assert.ok(server.port > 0);
    assert.equal(server.url, `http://localhost:${server.port}/`);
  });

  it('GET /api/file returns name, path and fresh XML', async () => {
    const res = await rawGet(server.port, '/api/file');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^application\/json/);
    assert.equal(res.headers['cache-control'], 'no-store');
    const body = JSON.parse(res.body);
    assert.equal(body.name, 'order.bpmn');
    assert.equal(body.path, FIXTURE);
    assert.equal(body.xml, await readFile(FIXTURE, 'utf8'));
  });

  it('answers on both loopback addresses', async () => {
    assert.equal((await rawGet(server.port, '/api/file', '127.0.0.1')).status, 200);
    assert.equal((await rawGet(server.port, '/api/file', '::1')).status, 200);
  });

  it('GET / serves the editor shell', async () => {
    const res = await rawGet(server.port, '/');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^text\/html/);
    assert.match(res.body, /id="canvas"/);
  });

  it('serves static assets with correct content types', async () => {
    const cases = {
      '/app.js': /^text\/javascript/,
      '/app.css': /^text\/css/,
      '/vendor/bpmn-js/bpmn-modeler.production.min.js': /^text\/javascript/,
      '/vendor/bpmn-js/assets/bpmn-font/font/bpmn.woff2': /^font\/woff2/,
      '/vendor/bpmn-js-color-picker/color-picker.min.js': /^text\/javascript/,
      '/vendor/bpmn-js-color-picker/color-picker.css': /^text\/css/,
    };
    for (const [path, type] of Object.entries(cases)) {
      const res = await rawGet(server.port, path);
      assert.equal(res.status, 200, path);
      assert.match(res.headers['content-type'], type, path);
    }
  });

  it('blocks path traversal out of web/', async () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/vendor/../../src/server.js']) {
      const res = await rawGet(server.port, path);
      assert.equal(res.status, 404, path);
      assert.doesNotMatch(res.body, /bpmn-edit|createServer/, path);
    }
  });

  it('returns 404 for unknown paths', async () => {
    assert.equal((await rawGet(server.port, '/nope.html')).status, 404);
    assert.equal((await rawGet(server.port, '/api/nope')).status, 404);
  });
});

describe('port fallback', () => {
  for (const blockedAddress of ['127.0.0.1', '::1']) {
    it(`uses the next free port when the requested one is busy on ${blockedAddress}`, async () => {
      await assertFallback(blockedAddress);
    });
  }

  async function assertFallback(blockedAddress) {
    const blocker = net.createServer();
    await new Promise((resolve) => blocker.listen(0, blockedAddress, resolve));
    const busyPort = blocker.address().port;

    const server = createServer({ filePath: FIXTURE, port: busyPort });
    try {
      const port = await server.listen();
      assert.notEqual(port, busyPort);
      assert.equal((await rawGet(port, '/api/file')).status, 200);
    } finally {
      await server.close();
      await new Promise((resolve) => blocker.close(resolve));
    }
  }
});
