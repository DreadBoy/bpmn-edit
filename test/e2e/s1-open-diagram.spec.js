// S1: open a diagram in the browser.
import { expect, test } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { collectPageErrors, copyFixture, FIXTURES, randomPort, runCli, startCli } from './helpers/cli.js';

const SHAPES = [
  'StartEvent_OrderReceived',
  'Task_CheckStock',
  'Gateway_InStock',
  'Task_ShipOrder',
  'Task_CancelOrder',
  'EndEvent_OrderShipped',
  'EndEvent_OrderCancelled',
];
const LABELS = ['Order received', 'Check stock', 'In stock?', 'Ship order', 'Cancel order', 'Order shipped', 'Order cancelled'];

test.describe('S1: open a diagram in the browser', () => {
  let fixture;
  let cli;

  test.afterEach(async () => {
    await cli?.stop();
    await fixture?.cleanup();
    cli = undefined;
    fixture = undefined;
  });

  test('renders the file from disk with labels, watermark and no errors', async ({ page }) => {
    fixture = await copyFixture('order.bpmn');
    const original = await readFile(fixture.file);
    cli = await startCli(fixture.file);
    // The printed URL carries the host secret (256-bit base64url).
    expect(cli.url).toMatch(/^http:\/\/localhost:\d+\/\?host=[A-Za-z0-9_-]{43}$/);

    const errors = collectPageErrors(page);
    const warnings = [];
    page.on('console', (msg) => { if (msg.type() === 'warning') warnings.push(msg.text()); });
    await page.goto(cli.url);

    await expect(page.locator('#file-name')).toHaveText('order.bpmn');
    await expect(page).toHaveTitle('order.bpmn — bpmn-edit');

    const canvas = page.locator('#canvas');
    const canvasBox = await canvas.boundingBox();
    // Canvas fills the viewport below the toolbar.
    const viewport = page.viewportSize();
    expect(canvasBox.y + canvasBox.height).toBeGreaterThanOrEqual(viewport.height - 1);
    expect(canvasBox.width).toBeGreaterThanOrEqual(viewport.width - 1);

    for (const id of SHAPES) {
      const shape = canvas.locator(`.djs-element.djs-shape[data-element-id="${id}"]`);
      await expect(shape, id).toBeVisible();
      // fit-viewport: every shape lies fully inside the visible canvas area.
      const box = await shape.boundingBox();
      expect(box.x, id).toBeGreaterThanOrEqual(canvasBox.x);
      expect(box.y, id).toBeGreaterThanOrEqual(canvasBox.y);
      expect(box.x + box.width, id).toBeLessThanOrEqual(canvasBox.x + canvasBox.width);
      expect(box.y + box.height, id).toBeLessThanOrEqual(canvasBox.y + canvasBox.height);
    }
    for (const label of LABELS) {
      await expect(canvas.locator('svg text', { hasText: label }).first(), label).toBeVisible();
    }
    for (const flowLabel of ['yes', 'no']) {
      await expect(canvas.locator('svg text').getByText(flowLabel, { exact: true })).toBeVisible();
    }

    await expect(page.locator('.bjs-powered-by')).toBeVisible();
    // The modeler (not just the viewer) is loaded: the palette is present.
    await expect(page.locator('.djs-palette')).toBeVisible();

    expect(errors).toEqual([]);
    expect(warnings).toEqual([]); // the fixture imports without bpmn-js warnings
    expect(await readFile(fixture.file)).toEqual(original);
  });

  test('missing file: exits non-zero with a message naming the path', async () => {
    const missing = join(FIXTURES, 'does-not-exist.bpmn');
    const result = await runCli([missing, '--no-open']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`File not found: ${missing}`);
    expect(result.stdout).not.toContain('editing');
  });

  test('non-BPMN file: exits non-zero with a clear message', async () => {
    fixture = await copyFixture('order.bpmn');
    const textFile = join(fixture.dir, 'notes.txt');
    await writeFile(textFile, 'not a diagram\n');
    const result = await runCli([textFile, '--no-open']);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(`Not a BPMN file (no bpmn:definitions element): ${textFile}`);
    expect(result.stdout).not.toContain('editing');
  });

  test('busy port: falls back to another port and the page still loads', async ({ page }) => {
    // Occupy a port the way another local app would (non-ephemeral, so it behaves like e.g. 3000).
    const blocker = net.createServer((socket) => socket.end('HTTP/1.1 418 Not us\r\n\r\n'));
    const busyPort = await listenOnFreePort(blocker);
    try {
      fixture = await copyFixture('order.bpmn');
      cli = await startCli(fixture.file, { port: busyPort });
      expect(cli.port).not.toBe(busyPort);
      expect(cli.stderr()).toContain(`port ${busyPort} is in use`);

      const errors = collectPageErrors(page);
      await page.goto(cli.url);
      await expect(page.locator('#file-name')).toHaveText('order.bpmn');
      await expect(page.locator('[data-element-id="Task_CheckStock"]')).toBeVisible();
      expect(errors).toEqual([]);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

async function listenOnFreePort(server) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = randomPort();
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
      });
      return port;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error('no free port for the blocker');
}
