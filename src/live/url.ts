/**
 * Where live mode connects (spec T11.1): `--db-url`, or the `SUPABASE_DB_URL` environment variable.
 * The URL is a credential (G12): it is checked without ever being echoed, and `redact` removes it
 * from any text that reaches the terminal.
 */
import { UsageError } from '../errors.js';

export const DB_URL_ENV = 'SUPABASE_DB_URL';

/** Database URLs and passwords never reach the terminal (G12). */
export function redact(text: string): string {
  return text.replace(/\b(postgres(?:ql)?:\/\/)[^\s'"]*@/gi, '$1***@');
}

/**
 * The connection string from `--db-url` (preferred) or `SUPABASE_DB_URL`, or `undefined` when
 * neither is set. A usage error (exit 2) when it is not a `postgres://` or `postgresql://` URL.
 */
export function resolveDbUrl(
  flag: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const fromEnv = env[DB_URL_ENV];
  const url = flag ?? (fromEnv === '' ? undefined : fromEnv);
  if (url === undefined) return undefined;
  const source = flag === undefined ? DB_URL_ENV : '--db-url';
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new UsageError(`${source} is not a valid URL (value not shown, it may hold a password).`);
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new UsageError(
      `${source} must start with postgres:// or postgresql:// (value not shown, it may hold a password).`,
    );
  }
  return url;
}
