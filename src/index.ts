import { buildApp } from './app.js';
import { config } from './config.js';

const app = await buildApp();

try {
  await app.listen({ port: config.port, host: config.host });
  console.log(`ATM Locator API listening on http://${config.host}:${config.port}/api/v1`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
