import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { db, closeDb } from './db.js';

async function run(): Promise<void> {
  await db.query('CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
  const migrationDir = path.resolve(process.cwd(), 'db');
  const files = (await readdir(migrationDir)).filter((name) => name.endsWith('.sql')).sort();
  for (const file of files) {
    const exists = await db.query('SELECT 1 FROM schema_migrations WHERE version = $1', [file]);
    if (exists.rowCount) continue;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(await readFile(path.join(migrationDir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING', [file]);
      await client.query('COMMIT');
      console.log(JSON.stringify({ message: 'migration_applied', version: file }));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

run().then(closeDb).catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
