/**
 * Builds a live database from a project (spec T11.1 tests): applies its migrations in replay order,
 * as `supabase db push` would, then optional SQL standing for changes made by hand in the dashboard
 * or the SQL editor.
 */
import { readFileSync } from 'node:fs';
import { discoverMigrations } from '../../src/load/discover.js';
import { startDatabase, type TestDatabase } from './database.js';

export async function databaseFor(
  projectDir: string,
  byHand: string[] = [],
  migrations = 'supabase/migrations',
): Promise<TestDatabase> {
  const db = await startDatabase();
  try {
    const { files } = discoverMigrations({ migrations, projectDir, cwd: projectDir });
    for (const file of files) await db.exec(readFileSync(file.path, 'utf8'));
    for (const sql of byHand) await db.exec(sql);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
