/**
 * Builds a live database from a project (spec T11.1 tests): applies its migrations in replay order,
 * as `supabase db push` would, then optional SQL standing for changes made by hand in the dashboard
 * or the SQL editor, after optional setup SQL. Migrations are found as `check --dir <projectDir>` finds them (its config's
 * `migrations`, a folder of `.sql` files given directly), unless `migrations` is passed.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../../src/config/load.js';
import { discoverMigrations } from '../../src/load/discover.js';
import { startDatabase, type TestDatabase } from './database.js';

export async function databaseFor(
  projectDir: string,
  byHand: readonly string[] = [],
  migrations?: string,
  /** SQL run before the migrations, standing for what the project already had (roles). */
  setup: readonly string[] = [],
): Promise<TestDatabase> {
  const db = await startDatabase();
  try {
    for (const sql of setup) await db.exec(sql);
    // A cwd other than the project, so a `--dir` that is itself the migrations folder works.
    const cwd = path.dirname(path.resolve(projectDir));
    const { files } = discoverMigrations({
      migrations: migrations ?? loadConfig({ cwd, projectDir }).config.migrations,
      projectDir,
      cwd,
      // A project with only declarative schemas has no migrations to apply.
      allowMissingDefault: true,
    });
    for (const file of files) await db.exec(readFileSync(file.path, 'utf8'));
    for (const sql of byHand) await db.exec(sql);
  } catch (error) {
    await db.close();
    throw error;
  }
  return db;
}
