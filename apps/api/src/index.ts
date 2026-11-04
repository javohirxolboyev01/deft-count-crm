import { createApp } from './app';
import { assertSecrets, config } from './config';
import { pool } from './db';
import { migrate } from './migrate';
import { adoptRecognizedTaxTypes } from './modules/clients';
import { closeAllStreams } from './modules/events';
import { startTelegramPolling, stopTelegramPolling } from './modules/telegram';
import { bootstrapLeader } from './modules/users';
import { startScheduler, stopScheduler } from './scheduler';

async function main() {
  process.env.TZ = config.timezone;
  assertSecrets();
  await migrate();
  // Eski importdagi tanilmagan soliq turi endi tanilsa (ЯТТ/YaTT) — o'zi qo'llanadi
  const adopted = await adoptRecognizedTaxTypes();
  if (adopted) console.log(`Soliq turi aniqlandi: ${adopted} ta mijoz`);
  await bootstrapLeader(config.bootstrapLeader.login, config.bootstrapLeader.password, config.bootstrapLeader.fullName);
  const server = createApp().listen(config.port, () => {
    console.log(`API: http://localhost:${config.port}/api (env=${config.env})`);
  });
  if (config.schedulerEnabled) startScheduler();
  void startTelegramPolling();

  const shutdown = () => {
    console.log('To\'xtatilmoqda...');
    stopScheduler();
    stopTelegramPolling();
    closeAllStreams();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
