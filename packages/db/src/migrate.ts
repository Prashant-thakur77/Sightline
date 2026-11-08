import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { closeDb, getDb } from './client';

const here = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(): Promise<void> {
  await migrate(getDb(), { migrationsFolder: path.join(here, '..', 'migrations') });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  runMigrations()
    .then(() => {
      console.log('migrations applied');
      return closeDb();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
