import { expect, test } from '@playwright/test';
import type { ConsoleMessage, Page } from '@playwright/test';

// The KINO Twin acceptance walk from apps/twin/README.md, driven headless
// against the same-origin preview pair (built Studio + built Twin on one
// port). Everything here goes through the real UI and the real KDP wire —
// no simulator side channels, no injected state.
//
// One serial test, two pages in one browser context: the Twin is the device
// and Studio is the client, and BroadcastChannel only reaches same-origin
// tabs, so they must share a context and stay open together.

/** Studio re-probes for a Twin tab every 3 s; a device poll is every 4 s and
 * the power/storage slice every 8 s. Cross-application assertions wait on
 * those intervals, never on a fixed sleep. */
const CROSS_APP_MS = 60_000;

interface Failure {
  where: string;
  text: string;
}

/**
 * Browser-reported failures for one page. Resource errors from `/api/` are
 * excluded on purpose: the Twin's Roll development bridge probes
 * `/api/healthz` on power-on, the preview server proxies `/api` to the Roll
 * API on :3000, and that service is not part of this walk. Nothing else is
 * filtered.
 */
function watchForFailures(page: Page, where: string, sink: Failure[]): void {
  page.on('console', (message: ConsoleMessage) => {
    if (message.type() !== 'error') return;
    if (message.location().url.includes('/api/')) return;
    sink.push({ where, text: message.text() });
  });
  page.on('pageerror', (error) => sink.push({ where, text: `pageerror: ${error.message}` }));
}

/** `12 CAPTURES ON CARD` / `10 LISTED · 12 ON CARD` — the card total either
 * way, and `null` while the head still says READING CARD…. */
function capturesOnCard(text: string): number | null {
  const match = /(\d+)\s+(?:CAPTURES\s+)?ON CARD/.exec(text);
  return match ? Number(match[1]) : null;
}

test.describe.configure({ mode: 'serial' });

test('Twin acceptance walk', async ({ context, page }) => {
  test.slow();
  const failures: Failure[] = [];
  watchForFailures(page, 'twin', failures);

  const header = page.locator('.twin-header');
  const shutter = page.locator('.twin-header .twin-header-control').nth(1);
  const inspector = page.locator('.twin-inspector');
  const clearance = page.locator('.twin-clearance-panel');
  const recorderStatus = page
    .locator('.twin-panel-heading')
    .filter({ hasText: 'RECORDER + EXPORTS' })
    .locator('span')
    .nth(1);

  const studio = await context.newPage();
  watchForFailures(studio, 'studio', failures);
  const connectTwin = studio.getByRole('button', { name: 'CONNECT KINO TWIN' });
  const galleryHead = studio.locator('.pagehead-actions');

  async function connectStudioToTwin(): Promise<void> {
    await expect(connectTwin).toBeVisible({ timeout: CROSS_APP_MS });
    await connectTwin.click();
    await expect(studio.locator('.conn-footer')).toContainText('KD4-SIM-0001 · TWIN', { timeout: CROSS_APP_MS });
  }

  async function openStudioPage(label: string): Promise<void> {
    await studio.locator('.nav .nav-item').filter({ hasText: label }).click();
    await expect(studio.locator('.pagehead h1')).toContainText(label);
  }

  /** The Gallery head after the card index has been read. */
  async function captureCount(): Promise<number> {
    await expect(galleryHead).toContainText('ON CARD', { timeout: CROSS_APP_MS });
    const text = await galleryHead.innerText();
    const count = capturesOnCard(text);
    if (count === null) throw new Error(`no capture count in Gallery head: ${JSON.stringify(text)}`);
    return count;
  }

  await test.step('Twin renders the D4 V1 scene without the recovery screen', async () => {
    await page.goto('/dev/twin/');
    await expect(header).toContainText('KINO TWIN');
    await expect(header).toContainText('D4 V1');
    await expect(page.locator('.twin-fatal')).toHaveCount(0);
    await expect(page.locator('.twin-viewport-canvas canvas')).toBeVisible();
    await expect(page.locator('.twin-statusbar')).toContainText('SIM OFF');
  });

  await test.step('PARTS: a component shows its dimensions and provenance', async () => {
    await page.locator('.twin-tree-label').first().click();
    await expect(inspector.locator('.twin-inspector-name')).toHaveText('Seeed Studio XIAO ESP32-S3 Sense');
    const dims = inspector
      .locator('.twin-inspector-row')
      .filter({ has: page.locator('.twin-inspector-label', { hasText: 'DIMS' }) })
      .locator('.twin-inspector-value');
    await expect(dims).toHaveText(/^[\d.?]+ × [\d.?]+ × [\d.?]+ mm$/);
    await expect(inspector.locator('.twin-badge').first()).toHaveText(
      /OFFICIAL_SPEC|SELLER_SPEC|PROVISIONAL|MEASURED|MEASURE TO LOCK/,
    );
  });

  await test.step('Optics: a lens-FOV scenario plus a pitch change move the overlap figures', async () => {
    await page.locator('#twin-fov-scenario').selectOption('70');
    const commonWidth = page.locator('.twin-optics-table tbody tr td').nth(2);
    await expect(commonWidth).toHaveText(/\d+ mm/);
    const before = await commonWidth.textContent();

    const pitch = page.getByLabel('Camera pitch (mm)');
    const current = Number(await pitch.inputValue());
    const low = Number(await pitch.getAttribute('min'));
    const high = Number(await pitch.getAttribute('max'));
    const target = current === high ? low : high;
    await pitch.fill(String(target));
    await expect(pitch).toHaveValue(String(target));
    await expect(commonWidth).not.toHaveText(before ?? '');
  });

  await test.step('POWER ON boots the simulator to SIM READY', async () => {
    // POWER ON is on the header and on the welcome card until the sim runs.
    await page.getByRole('button', { name: 'POWER ON' }).first().click();
    await expect(header).toContainText('SIM READY', { timeout: 60_000 });
    await expect(page.locator('.twin-welcome')).toHaveCount(0);
  });

  await test.step('Studio connects to the Twin over KDP', async () => {
    await studio.goto('/studio/');
    await connectStudioToTwin();
    // A populated Overview means HELLO, DEVICE_INFO, CAPABILITIES and
    // CONFIG_SCHEMA all completed — the page renders nothing without them.
    await expect(studio.locator('.pagehead .microlabel')).toContainText('KD4-SIM-0001');
    await expect(header).toContainText('Studio CONNECTED');
  });

  await test.step('A Twin shutter lands in Studio Gallery', async () => {
    await openStudioPage('Gallery');
    const before = await captureCount();

    // The Twin blocks its own shutter while Studio owns the link, so the
    // capture is fired from the device side with Studio disconnected — which
    // also exercises the disconnect/reconnect path.
    await studio.getByRole('button', { name: 'DISCONNECT' }).click();
    await expect(studio.locator('.connect-card')).toBeVisible();
    await expect(shutter).toBeEnabled({ timeout: CROSS_APP_MS });
    await shutter.click();
    await expect(shutter).toHaveText('SHUTTER', { timeout: 60_000 });

    await connectStudioToTwin();
    await openStudioPage('Gallery');
    await expect
      .poll(async () => capturesOnCard(await galleryHead.innerText()), { timeout: CROSS_APP_MS })
      .toBe(before + 1);
  });

  await test.step('FAULTS: Studio diagnoses CAM3 offline, then its recovery', async () => {
    await page.getByRole('button', { name: 'FAULTS', exact: true }).click();
    const cam3 = page.locator('.twin-control-row').filter({ hasText: 'CAM3' }).locator('select');
    await cam3.selectOption('offline');

    await openStudioPage('Overview');
    const cam3Card = studio.locator('.camcard').filter({ hasText: 'CAM 3' });
    await expect(cam3Card).toContainText('OFFLINE', { timeout: CROSS_APP_MS });
    await expect(studio.locator('.readybar')).toContainText('CAM 3 OFFLINE');

    await cam3.selectOption('');
    await expect(cam3Card).toContainText('READY', { timeout: CROSS_APP_MS });
  });

  await test.step('FAULTS: battery sag reaches the Studio power row', async () => {
    const battery = studio.locator('.datarow').filter({ hasText: 'BATTERY' }).first();
    const healthy = await battery.innerText();
    const sag = page.locator('.twin-fault-row').filter({ hasText: 'BATTERY SAG' }).locator('input[type=checkbox]');

    await sag.check();
    // The pack reports 3.55 V and dips further under load. That is above the
    // 15 % LOW BATTERY threshold, so the evidence is the reported voltage in
    // the POWER & STORAGE row, not the ready bar.
    await expect(battery).toContainText(/3\.[0-5]\d V/, { timeout: CROSS_APP_MS });

    await sag.uncheck();
    await expect(battery).not.toContainText(/3\.[0-5]\d V/, { timeout: CROSS_APP_MS });
    expect(healthy).toMatch(/\d\.\d\d V/);
  });

  await test.step('A measured override tags MEASURED and refreshes the clearance findings', async () => {
    await page.getByRole('button', { name: 'PARTS', exact: true }).click();
    await page.locator('.twin-tree-label').filter({ hasText: '505573 LiPo' }).click();
    const before = await clearance.innerText();

    await page.getByRole('button', { name: 'MEASURE ACTUAL PART' }).click();
    await page.getByPlaceholder('114.4, 66.8, 9').fill('120, 78, 30');
    await page.getByRole('button', { name: 'SAVE MEASUREMENT' }).click();

    await expect(inspector.locator('.twin-badge').first()).toHaveText('MEASURED');
    await expect(clearance).not.toHaveText(before);
  });

  await test.step('Studio disconnects and the connect screen stays usable', async () => {
    await studio.getByRole('button', { name: 'DISCONNECT' }).click();
    await expect(studio.locator('.connect-card')).toBeVisible();
    await expect(studio.getByRole('button', { name: 'CONNECT KINO CAMERA' })).toBeVisible();
    // The Twin probe keeps running on the home screen, so the Twin is still
    // on offer after a disconnect.
    await expect(connectTwin).toBeVisible({ timeout: CROSS_APP_MS });
    await expect(header).toContainText('Studio NOT CONNECTED', { timeout: CROSS_APP_MS });
  });

  await test.step('SESSIONS: record a capture, stop, and verify the replay', async () => {
    await page.getByRole('button', { name: 'SESSIONS', exact: true }).click();
    await page.getByRole('button', { name: 'RECORD', exact: true }).click();
    await expect(recorderStatus).toHaveText('RECORDING');

    await expect(shutter).toBeEnabled();
    await shutter.click();
    await expect(shutter).toHaveText('SHUTTER', { timeout: 60_000 });

    // STOP writes the session file; the download is accepted and discarded.
    const saved = page.waitForEvent('download');
    await page.getByRole('button', { name: 'STOP', exact: true }).click();
    await saved;
    await expect(recorderStatus).toHaveText(/[1-9]\d* EVENTS SAVED/);

    await page.getByRole('button', { name: 'VERIFY', exact: true }).click();
    // VERIFY byte-compares against a device built fresh from the seed, and a
    // fresh device is powered off with an empty card. A session recorded
    // part-way through a walk therefore reports a divergence rather than
    // REPLAY OK; what is asserted here is that VERIFY returns a verdict and
    // names where the streams parted.
    await expect(recorderStatus).toHaveText(/REPLAY OK|DIVERGED AT \d+ MS/, { timeout: 120_000 });

    await page.getByRole('button', { name: 'REPLAY 1×', exact: true }).click();
    await expect(recorderStatus).toHaveText('REPLAY COMPLETE', { timeout: 120_000 });
  });

  expect(failures, `browser errors during the walk:\n${failures.map((f) => `${f.where}: ${f.text}`).join('\n')}`)
    .toEqual([]);
});
