import { resolve } from 'node:path';
import { createBridge } from './bridge';
import { loadConfig } from './config';

const config = loadConfig();
const bridge = createBridge(config, { staticDir: resolve(import.meta.dir, '../dist/app') });
const server = Bun.serve({
  port: Number(process.env.PORT ?? 8787),
  hostname: process.env.HOST ?? '127.0.0.1',
  fetch: bridge.fetch,
});
console.log(`familyhub-call bridge listening on ${server.url} (texting: ${Boolean(config.imessage)}, calls: ${Boolean(config.facetime)}, inside: ${Boolean(config.smartthings)})`);
