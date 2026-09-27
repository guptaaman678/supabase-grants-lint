/**
 * A real Postgres for live-mode tests (spec T11.1). With `GRANTS_LINT_TEST_DB_URL` set (CI's
 * Postgres service container) each test gets a fresh database on that server; otherwise an
 * in-process PGlite (Postgres compiled to WebAssembly) behind a local socket, so the tests run on
 * every machine and CI leg without Docker.
 *
 * Every database starts as a Supabase project did before the change: the API roles exist and
 * `postgres` grants them everything on new tables and sequences in `public` (config
 * `platformDefaults: "legacy"`).
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import postgres from 'postgres';

export const TEST_DB_URL_ENV = 'GRANTS_LINT_TEST_DB_URL';

/** Every test database URL carries a password, so redaction is always checked. */
const PLACEHOLDER_PASSWORD = 'not-a-real-password';

export interface TestDatabase {
  /** Connection string for the CLI and `readCatalog`, with a password to check redaction. */
  readonly url: string;
  /** Runs SQL (several statements allowed) as `postgres`. */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

const ROLES = `
do $$ begin
  create role anon nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role authenticated nologin noinherit;
exception when duplicate_object then null; end $$;
do $$ begin
  create role service_role nologin noinherit bypassrls;
exception when duplicate_object then null; end $$;
`;

/** Just enough of Supabase's `auth` schema for migrations' policies and foreign keys. */
const AUTH = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key);
create or replace function auth.uid() returns uuid language sql stable as 'select null::uuid';
create or replace function auth.role() returns text language sql stable as 'select null::text';
create or replace function auth.jwt() returns jsonb language sql stable as 'select null::jsonb';
`;

export const LEGACY_PLATFORM = `
grant usage on schema public to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public
  grant all on sequences to anon, authenticated, service_role;
`;

export async function startDatabase(): Promise<TestDatabase> {
  const server = process.env[TEST_DB_URL_ENV];
  const db = server === undefined || server === '' ? await pglite() : await onServer(server);
  await db.exec(ROLES);
  await db.exec(AUTH);
  await db.exec(LEGACY_PLATFORM);
  return db;
}

async function pglite(): Promise<TestDatabase> {
  const db = await PGlite.create();
  const socket = new PGLiteSocketServer({ db, port: 0, host: '127.0.0.1' });
  await socket.start();
  const { port } = socket as unknown as { port: number };
  return {
    url: `postgres://postgres:${PLACEHOLDER_PASSWORD}@127.0.0.1:${String(port)}/postgres`,
    exec: async (sql) => {
      await db.exec(sql);
    },
    close: async () => {
      await socket.stop();
      await db.close();
    },
  };
}

async function onServer(serverUrl: string): Promise<TestDatabase> {
  const name = `grants_lint_${randomBytes(6).toString('hex')}`;
  const admin = postgres(serverUrl, { max: 1, onnotice: () => undefined });
  await admin.unsafe(`create database ${name}`);
  const url = new URL(serverUrl);
  url.pathname = `/${name}`;
  // CI's server trusts local connections; a placeholder password still lets the tests check that
  // no output ever shows it.
  if (url.password === '') url.password = PLACEHOLDER_PASSWORD;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => undefined });
  return {
    url: url.toString(),
    exec: async (text) => {
      await sql.unsafe(text);
    },
    close: async () => {
      await sql.end();
      await admin.unsafe(`drop database ${name} with (force)`);
      await admin.end();
    },
  };
}
