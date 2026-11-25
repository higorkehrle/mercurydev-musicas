import { buildApp } from './app.ts';
import { config } from './config.ts';

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  app.log.info({ msg: 'MercuryDev Músicas is up', api: `http://${config.host}:${config.port}`, web: config.webOrigin, redirectUri: config.spotify.redirectUri });
} catch (err) {
  app.log.error({ msg: 'failed to start', err: err instanceof Error ? err.message : String(err) });
  process.exit(1);
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void app.close().then(() => process.exit(0));
  });
}
