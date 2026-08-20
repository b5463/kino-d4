import { buildServer } from './server';
import { loadConfig } from './config';

const app = buildServer(loadConfig());
let stopping = false;

async function stop(signal: NodeJS.Signals): Promise<void> {
  if (stopping) return;
  stopping = true;
  app.log.info({ signal }, 'API shutting down');
  try {
    await app.close();
    process.exitCode = 0;
  } catch (err) {
    app.log.error({ err }, 'API shutdown failed');
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void stop('SIGINT'));
process.once('SIGTERM', () => void stop('SIGTERM'));

try {
  await app.listen({ host: '0.0.0.0', port: 3000 });
} catch (err) {
  app.log.fatal({ err }, 'API failed to start');
  process.exitCode = 1;
}
