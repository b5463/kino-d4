import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, '..');
const screenshot = path.resolve(appRoot, 'test-results', 'kino-print-home.png');
const dropFixture = path.resolve(here, 'fixtures', 'drop-test.gcode');
const packagedExe = process.env.KINO_PRINT_PACKAGED_EXE;
const desktop = await electron.launch(packagedExe
  ? { executablePath: packagedExe, args: [], cwd: path.dirname(packagedExe) }
  : { args: [appRoot], cwd: appRoot });
try {
  const page = await desktop.firstWindow();
  await page.waitForSelector('text=Open a G-code file and print it over USB.');
  await page.evaluate(() => document.fonts.load('16px W95FA'));
  const fontState = await page.evaluate(() => ({
    family: getComputedStyle(document.body).fontFamily,
    loaded: Array.from(document.fonts).some((font) => font.family === 'W95FA' && font.status === 'loaded'),
  }));
  if (!fontState.loaded || !fontState.family.includes('W95FA')) throw new Error(`W95FA did not load: ${JSON.stringify(fontState)}`);
  await page.screenshot({ path: screenshot, fullPage: true });
  const title = await page.title();
  const menuLabels = await page.locator('.menu-trigger').allTextContents();
  if (title !== 'KINO Print') throw new Error(`Unexpected title: ${title}`);
  if (menuLabels.join('|') !== 'File|Printer|View|Help') throw new Error(`Menus missing: ${menuLabels.join('|')}`);
  await page.getByRole('heading', { name: 'Printer' }).waitFor();
  await page.getByRole('heading', { name: 'Current print' }).waitFor();
  await page.waitForTimeout(3500);
  const connectionRecovered = await page.getByText('Connected', { exact: true }).isVisible().catch(() => false);
  if (connectionRecovered) {
    const visibleCopy = await page.locator('.monitor-panel').innerText();
    if (/FileNotFoundError|ClearCommError|PermissionError|could not open port/i.test(visibleCopy)) throw new Error('Raw USB error remains visible.');
    if (visibleCopy.includes('USB disconnected during the print.')) {
      await page.getByRole('button', { name: 'Printer is off' }).waitFor();
      await page.getByRole('button', { name: 'Retry cooldown' }).waitFor();
    }
  }
  const overflow = await page.evaluate(() => ['.workspace', '.printer-body', '.monitor-body'].map((selector) => {
    const element = document.querySelector(selector);
    return { selector, clientHeight: element?.clientHeight || 0, scrollHeight: element?.scrollHeight || 0 };
  }));
  const clipped = overflow.find(({ clientHeight, scrollHeight }) => scrollHeight > clientHeight + 2);
  if (clipped) throw new Error(`Dashboard requires scrolling: ${JSON.stringify(overflow)}`);
  await page.evaluate(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.id = 'drop-file-probe';
    input.hidden = true;
    document.body.append(input);
  });
  await page.locator('#drop-file-probe').setInputFiles(dropFixture);
  const realFileTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    const input = document.querySelector('#drop-file-probe');
    transfer.items.add(input.files[0]);
    return transfer;
  });
  await page.locator('.app-shell').dispatchEvent('dragenter', { dataTransfer: realFileTransfer });
  await page.getByText('Drop G-code to open it').waitFor();
  await page.locator('.app-shell').dispatchEvent('drop', { dataTransfer: realFileTransfer });
  await page.getByText('drop-test.gcode', { exact: true }).waitFor();
  const dataTransfer = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['not gcode'], 'notes.txt', { type: 'text/plain' }));
    return transfer;
  });
  await page.locator('.app-shell').dispatchEvent('dragenter', { dataTransfer });
  await page.getByText('Drop G-code to open it').waitFor();
  await page.locator('.app-shell').dispatchEvent('drop', { dataTransfer });
  await page.getByText('Use a .gcode or .gco file.').waitFor();
  await page.getByRole('button', { name: /^File/ }).click();
  await page.getByRole('menuitem', { name: 'Open G-code…' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^View/ }).click();
  await page.getByRole('menuitem', { name: 'Interface size…' }).click();
  await page.getByRole('heading', { name: 'Interface size' }).waitFor();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.getByRole('button', { name: /^Help/ }).click();
  await page.getByRole('menuitem', { name: 'About KINO Print' }).click();
  await page.getByRole('heading', { name: 'KINO Print 1.0.3' }).waitFor();
  await page.getByRole('button', { name: 'OK' }).click();
  const copy = await page.locator('body').innerText();
  for (const phrase of ['Reliable prints', 'Preflight', 'continuously stream', 'without changing']) {
    if (copy.includes(phrase)) throw new Error(`AI-style copy remains: ${phrase}`);
  }
  console.log(JSON.stringify({ title, menuLabels, fontState, overflow, screenshot }));
} finally {
  await desktop.close();
}
