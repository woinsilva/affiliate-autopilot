import { config } from './config.js';
import { closeDb } from './db.js';
import { queueNames } from './queues.js';
import { startApi } from './api.js';
import { startScheduler } from './scheduler.js';
import { startWorker } from './workers.js';

type Stop = () => Promise<void>;

async function main(): Promise<void> {
  let stop: Stop;
  switch (config.PROCESS_ROLE) {
    case 'api': {
      const server = startApi();
      stop = () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      break;
    }
    case 'scheduler':
      stop = await startScheduler();
      break;
    case 'product-worker':
      { const worker = startWorker(queueNames.product); stop = () => worker.close(); }
      break;
    case 'content-worker':
      { const worker = startWorker(queueNames.content); stop = () => worker.close(); }
      break;
    case 'snapgen-worker':
      { const worker = startWorker(queueNames.snapgen); stop = () => worker.close(); }
      break;
    case 'qa-worker':
      { const worker = startWorker(queueNames.qa); stop = () => worker.close(); }
      break;
    case 'publishing-worker':
      { const worker = startWorker(queueNames.publishing); stop = () => worker.close(); }
      break;
    case 'analytics-worker':
      { const worker = startWorker(queueNames.analytics); stop = () => worker.close(); }
      break;
    case 'notification-worker':
      { const worker = startWorker(queueNames.notification); stop = () => worker.close(); }
      break;
    default:
      throw new Error(`Unknown PROCESS_ROLE: ${config.PROCESS_ROLE}`);
  }

  const shutdown = async (signal: string): Promise<void> => {
    console.log(JSON.stringify({ message: 'shutdown', signal, role: config.PROCESS_ROLE }));
    await stop();
    await closeDb();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
