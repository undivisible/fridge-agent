/**
 * Builds dist/app (served by the bridge, or loaded in the Family Hub browser) and an UNSIGNED
 * dist/familyhub-call.wgt. Sign the .wgt with Tizen Studio before installing (docs/DEPLOYMENT.md).
 *
 *   BRIDGE_ORIGIN=https://fridge-bridge.example.com bun run build
 */
import { cp, mkdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const out = resolve(root, 'dist/app');
const bridgeOrigin = (process.env.BRIDGE_ORIGIN ?? '').replace(/\/+$/, '');

await rm(resolve(root, 'dist'), { recursive: true, force: true });
await mkdir(out, { recursive: true });

const result = await Bun.build({
  entrypoints: [resolve(root, 'app/main.ts')],
  outdir: out,
  naming: 'main.js',
  target: 'browser',
  format: 'iife',
  minify: true,
  define: { __BRIDGE_ORIGIN__: JSON.stringify(bridgeOrigin) },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const file of ['index.html', 'style.css', 'icon.png']) await cp(resolve(root, 'app', file), resolve(out, file));

const connect = bridgeOrigin || 'https:';
const manifest = (await Bun.file(resolve(root, 'app/config.xml')).text())
  .replace('{{ACCESS_ORIGIN}}', bridgeOrigin || '*')
  .replace('{{CSP_CONNECT}}', connect);
await Bun.write(resolve(out, 'config.xml'), manifest);

const zip = Bun.spawnSync(['zip', '-qr', resolve(root, 'dist/familyhub-call.wgt'), '.'], { cwd: out });
if (zip.exitCode !== 0) throw new Error(zip.stderr.toString());
console.log(`Built ${out} and dist/familyhub-call.wgt (unsigned)${bridgeOrigin ? '' : ' without BRIDGE_ORIGIN; the app will ask for it when pairing'}.`);
