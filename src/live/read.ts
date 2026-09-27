/**
 * The only module that opens a network connection (G4): live mode reads a database's grants, with
 * read-only catalog queries in a read-only transaction, to the URL the user passed. The Postgres
 * client is imported here, lazily, so `check`, `doctor` without `--db-url`, `explain` and `init`
 * never load it. Errors never carry the URL or its password (G12).
 */
import { UsageError } from '../errors.js';
import { redact } from './url.js';
import type {
  RawCatalog,
  RawColumnAcl,
  RawDefaultAcl,
  RawPolicy,
  RawRelation,
} from './snapshot.js';

/** How long connecting and each query may take before live mode gives up. */
const TIMEOUT_SECONDS = 15;

/** Reads the catalog rows for `schemas`. Rejects with a `UsageError` (exit 2) when it cannot. */
export async function readCatalog(url: string, schemas: readonly string[]): Promise<RawCatalog> {
  const { default: postgres } = await import('postgres');
  const sslmode = new URL(url).searchParams.has('sslmode');
  const sql = postgres(url, {
    max: 1,
    // Transaction-mode poolers (Supabase's on port 6543) do not support prepared statements.
    prepare: false,
    connect_timeout: TIMEOUT_SECONDS,
    idle_timeout: 1,
    onnotice: () => undefined,
    connection: { application_name: 'supabase-grants-lint' },
    ...(sslmode ? {} : { ssl: 'prefer' as const }),
  });
  const names = [...schemas];
  try {
    return await sql.begin('read only', async (tx) => {
      await tx.unsafe(`set local statement_timeout = ${String(TIMEOUT_SECONDS * 1000)}`);
      const [version] = await tx<{ version: number }[]>`
        select current_setting('server_version_num')::int as version`;
      const relations = await tx<RawRelation[]>`
        select n.nspname as schema, c.relname as name, c.relkind::text as relkind,
               c.relacl::text[] as acl
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(${names}::text[])
          and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
          and c.relpersistence <> 't'
          and not exists (
            select 1 from pg_catalog.pg_depend d
            where d.classid = 'pg_catalog.pg_class'::regclass and d.objid = c.oid
              -- extension members; identity sequences (a partitioned table depends on itself)
              and (d.deptype = 'e' or (d.deptype = 'i' and c.relkind = 'S'))
          )
        order by n.nspname, c.relname`;
      const columns = await tx<RawColumnAcl[]>`
        select n.nspname as schema, c.relname as name, a.attname as column,
               a.attacl::text[] as acl
        from pg_catalog.pg_attribute a
        join pg_catalog.pg_class c on c.oid = a.attrelid
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = any(${names}::text[])
          and a.attnum > 0 and not a.attisdropped and a.attacl is not null
        order by n.nspname, c.relname, a.attnum`;
      const defaults = await tx<RawDefaultAcl[]>`
        select pg_catalog.pg_get_userbyid(d.defaclrole) as creator,
               case when d.defaclnamespace = 0 then null else n.nspname end as schema,
               d.defaclobjtype::text as objtype, d.defaclacl::text[] as acl
        from pg_catalog.pg_default_acl d
        left join pg_catalog.pg_namespace n on n.oid = d.defaclnamespace
        where d.defaclnamespace = 0 or n.nspname = any(${names}::text[])
        order by 1, 2, 3`;
      const policies = await tx<RawPolicy[]>`
        select schemaname as schema, tablename as table, policyname as name, cmd,
               roles::text[] as roles
        from pg_catalog.pg_policies
        where schemaname = any(${names}::text[])
        order by 1, 2, 3`;
      return {
        serverVersion: version?.version ?? 0,
        relations: [...relations],
        columns: [...columns],
        defaults: [...defaults],
        policies: [...policies],
      };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new UsageError(`Could not read the database: ${redact(message)}`);
  } finally {
    await sql.end({ timeout: 1 });
  }
}
