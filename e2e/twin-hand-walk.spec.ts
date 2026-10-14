import { expect, test } from '@playwright/test';

/*
 * The device UI's right-hand layout, walked on the Twin's SCREEN VIEW (#177).
 *
 * The screen view runs the real ui.c as wasm on a 2D canvas. At 1X the canvas
 * is 800x480 CSS pixels, so a logical UI coordinate is a mouse offset, and a
 * screen is recognised by a few pixels the layout guarantees: the menu's
 * card, the hairline under every detail header, the lit COLOUR segment on
 * LOOK. The walk is the thumb's: SHOOT from the card, LOOK from the finder's
 * bar, back, the menu from the finder, then each row and back, then the two
 * guards (a drag off a row, a press on the palm edge) and the shutter.
 *
 * Every tap is a coordinate the layout constants in ui.c place. Moving a
 * control there without moving it here is exactly what this spec catches.
 */

// The Twin wears launch shade 0, MAO pink, so the card is always this colour there.
const CARD = [0xf3, 0xa2, 0xc4]; // K_LAUNCH[0]: the SHOOT card
const RULE = [0x28, 0x28, 0x28]; // K_RULE: the hairline under every detail header
const SEL = [0xf1, 0xec, 0xe2]; // K_ON (K_INK): a lit segment

type Rgb = [number, number, number];
const near = (p: Rgb, c: number[], tol = 24): boolean => p.every((v, i) => Math.abs(v - c[i]) <= tol);
const dark = (p: Rgb): boolean => p[0] < 0x40 && p[1] < 0x50 && p[2] < 0x50;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.describe.configure({ mode: 'serial' });

test('Twin hand walk: the device UI for the hand on the shutter', async ({ page }) => {
  test.slow();
  const failures: string[] = [];
  page.on('pageerror', (e) => failures.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (m.location().url.includes('/api/')) return; // no KINO server behind the preview
    failures.push(m.text());
  });

  await page.goto('/dev/twin/#screen');
  await page.getByRole('button', { name: 'POWER ON' }).first().click();
  const status = page.locator('.twin-screenview-status');
  await expect(status).toHaveText(/^FIRMWARE ui\.c/, { timeout: 60_000 });
  await page.getByRole('button', { name: '1X', exact: true }).click();

  const canvas = page.locator('canvas.twin-screenview-canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('no screen canvas');
  expect(Math.round(box.width)).toBe(800);
  expect(Math.round(box.height)).toBe(480);

  const px = (x: number, y: number): Promise<Rgb> =>
    page.evaluate(([px, py]) => {
      const c = document.querySelector('canvas.twin-screenview-canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(px, py, 1, 1).data;
      return [d[0], d[1], d[2]] as [number, number, number];
    }, [x, y]);

  async function tap(x: number, y: number, hold = 90): Promise<void> {
    await page.mouse.move(box!.x + x, box!.y + y);
    await page.mouse.down();
    await sleep(hold);
    await page.mouse.up();
    await sleep(700); // a move is 420 ms, plus the frame after it
  }
  async function drag(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    await page.mouse.move(box!.x + x0, box!.y + y0);
    await page.mouse.down();
    await sleep(60);
    await page.mouse.move(box!.x + x1, box!.y + y1, { steps: 6 });
    await sleep(60);
    await page.mouse.up();
    await sleep(700);
  }
  async function reach(name: string, pred: () => Promise<boolean>, ms = 8000): Promise<void> {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (await pred()) return;
      await sleep(100);
    }
    throw new Error(`did not reach ${name}`);
  }

  // The menu: the SHOOT card fills the right, the rows the left.
  // Both points clear of the card's type: TAP TO OPEN ends near x 535.
  const isMenu = async (): Promise<boolean> => near(await px(700, 300), CARD) && near(await px(700, 440), CARD);
  // SHOOT: dark panes under the MENU plate and along the bar. The bar probe
  // sits in the TIMER panel past its widest word, TIMER 10 S, which ends near
  // x 770: the panel face or the margin, never a letter.
  const isShoot = async (): Promise<boolean> => dark(await px(676, 14)) && dark(await px(776, 462)) && !(await isMenu());
  // Every detail screen draws one hairline under its header; the menu, SHOOT and PHOTO do not.
  const hasHeader = async (): Promise<boolean> => near(await px(400, 60), RULE, 12);
  // LOOK: the header, the lit COLOUR segment, the back button's face (732..784,
  // clear of its arrow, which runs 749..767 on y 31).
  const isLook = async (): Promise<boolean> => (await hasHeader()) && near(await px(128, 438), SEL) && dark(await px(740, 31));
  const isDetail = async (): Promise<boolean> => (await hasHeader()) && !(await isMenu());

  const step = async (name: string, action: () => Promise<void>, check: () => Promise<boolean>): Promise<void> => {
    await test.step(name, async () => {
      await action();
      await reach(name, check);
    });
  };

  // The start (#245) ends on its own in 2.0-3.0 s; the menu is the first
  // screen. The card covers both probes about 0.3 s before the rows are down,
  // and a tap during the start would cut it short and press nothing, so the
  // walk waits the build out before its first tap.
  await reach('menu after boot', isMenu, 15_000);
  await sleep(900);
  // A fresh body shows its first-start note once, and its scrim hides the
  // card; GOT IT is the top row of the note.
  if (!(await isMenu())) await tap(400, 255);

  await step('SHOOT from the card', () => tap(600, 240), isShoot);
  // MODE, the decisions group's outer end (x 564..651); the TIMER panel beyond
  // it, 660..780, switches the self-timer and opens nothing.
  await step('LOOK from the finder bar', () => tap(600, 462), isLook);
  await step('back to SHOOT', () => tap(752, 31), isShoot);
  await step('menu from the finder', () => tap(726, 31), isMenu);
  await step('GALLERY row', () => tap(190, 149), isDetail);
  // The gallery's page is 0-based in ui.c and 1-based in the page script
  // (#247): the Twin opened on the second page's arrows. The demo card holds
  // 22 captures, four pages. On the first, PREV is dead and NEXT live: the
  // brightest pixel of the live arrow is K_INK, the dead one's is not.
  const peak = (x: number, y: number, w: number, h: number): Promise<number> =>
    page.evaluate(([x, y, w, h]) => {
      const c = document.querySelector('canvas.twin-screenview-canvas') as HTMLCanvasElement;
      const d = c.getContext('2d')!.getImageData(x, y, w, h).data;
      let m = 0;
      for (let i = 0; i < d.length; i += 4) m = Math.max(m, d[i], d[i + 1], d[i + 2]);
      return m;
    }, [x, y, w, h]);
  // The header pair: PREV 616..668, NEXT 672..724, y 5..57 (hd_prev_x()).
  const firstOf = async (px: number, nx: number, y: number, w: number, h: number): Promise<boolean> =>
    (await peak(nx, y, w, h)) - (await peak(px, y, w, h)) > 40;
  const galleryFirst = async (): Promise<boolean> => (await hasHeader()) && firstOf(616, 672, 5, 52, 52);
  await test.step('the gallery opens on its first page', () =>
    reach('PREV dead and NEXT live on the first page', galleryFirst));
  // The newest photograph, the first tile: PREV dead on PHOTO's pair
  // (622..699 and 707..784, y 232..284; PH_PN_Y), NEXT live. PHOTO draws no
  // header hairline.
  await step('the newest photograph', () => tap(142, 172), async () =>
    !(await hasHeader()) && firstOf(622, 707, 232, 77, 52));
  await step('back to the gallery', () => tap(752, 31), galleryFirst);
  await step('back from GALLERY', () => tap(752, 31), isMenu);
  await step('SETTINGS row', () => tap(190, 331), isDetail);
  await step('back from SETTINGS', () => tap(752, 31), isMenu);
  await step('POWER row', () => tap(190, 422), isDetail);
  await step('back from POWER', () => tap(752, 31), isMenu);
  await step('LOOK row', () => tap(190, 58), isLook);
  await step('back from LOOK to the menu', () => tap(752, 31), isMenu);
  // A press that slides off its row does nothing: the drift guard.
  await step('drift guard', () => drag(600, 200, 600, 280), isMenu);
  // A press on the palm's edge does nothing: the edge guard.
  await step('edge guard', () => tap(797, 300), isMenu);
  // The shutter key from the menu opens SHOOT.
  await step('the shutter opens SHOOT', () => page.keyboard.press('Space'), isShoot);

  expect(failures, failures.join('\n')).toEqual([]);
});
