import { _electron as electron } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const target = JSON.parse(fs.readFileSync('release/package-path.json', 'utf8'));
const worker = path.join(
  target.resources,
  'native',
  process.platform === 'win32' ? 'airwolf-radio.exe' : 'airwolf-radio',
);
const env = { ...process.env };
delete env.AIRWOLF_RADIO_PATH;
delete env.AIRFRAME_RADIO_PATH;
// Do not let an installed SDK mask missing bundled dylibs/DLLs.
if (process.platform === 'win32')
  env.PATH = `${process.env.SystemRoot}\\System32;${process.env.SystemRoot}`;
else env.PATH = '/usr/bin:/bin';
const native = JSON.parse(
  execFileSync(worker, ['--list'], { encoding: 'utf8', env, timeout: 10000 }),
);
if (native.type !== 'devices') throw new Error('Packaged worker did not load');
const app = await electron.launch({
  executablePath: target.executable,
  env,
  args: process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : [],
});
try {
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.waitForSelector('tbody tr');
  const state = await page.evaluate(async () => ({
    title: document.title,
    logo: document.querySelector('.brand-logo')?.naturalWidth,
    rows: document.querySelectorAll('tbody tr').length,
    device: await window.radio.info(),
  }));
  if (
    !state.title.includes('Airwolf') ||
    !state.logo ||
    state.rows < 1 ||
    errors.length ||
    (/not (built|found)|failed/i.test(state.device.details) &&
      !/No HackRF boards found/.test(state.device.details))
  )
    throw new Error(JSON.stringify({ state, errors }));
  await page.screenshot({ path: 'release/packaged-smoke.png' });
  fs.writeFileSync(
    'release/packaged-smoke.json',
    JSON.stringify(
      {
        platform: process.platform,
        arch: process.arch,
        nativeLoads: true,
        rendererLoads: true,
        logoLoads: true,
        demoRows: state.rows,
        hardwareAvailable: state.device.available,
        errors,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    `Packaged Airwolf ${process.platform}/${process.arch}: renderer, logo, preload and native receiver passed.`,
  );
} finally {
  await app.close();
}
