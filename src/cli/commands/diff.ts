/**
 * `diff` (spec T11.1): compares the migrations with a live database, read-only, and reports drift
 * (GL009) in any `check` format. Exit codes as `check`: GL009 is a warning, so `--max-warnings 0`
 * makes drift fail CI. The connection string comes from `--db-url` or `SUPABASE_DB_URL` and never
 * appears in output (G12).
 */
import { UsageError } from '../../errors.js';
import { DB_URL_ENV, resolveDbUrl } from '../../live/url.js';
import {
  booleanOption,
  choiceOption,
  countOption,
  listOption,
  type OptionSpecs,
  parseCommandArgs,
  stringOption,
} from '../args.js';
import { colorEnabled, colors } from '../color.js';
import { ExitCode } from '../exit-codes.js';
import type { Io } from '../io.js';
import { COMMAND_USAGE } from '../usage.js';
import { exitCodeFor, FORMATS, report } from './check.js';

export const DIFF_OPTIONS: OptionSpecs = {
  'db-url': { type: 'string' },
  dir: { type: 'string' },
  config: { type: 'string' },
  since: { type: 'string' },
  schema: { type: 'string', multiple: true },
  format: { type: 'string' },
  'max-warnings': { type: 'string' },
  'no-color': { type: 'boolean' },
  quiet: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
};

export async function diff(args: readonly string[], io: Io): Promise<ExitCode> {
  const { values, positionals } = parseCommandArgs(args, DIFF_OPTIONS, 'diff');
  if (booleanOption(values, 'help')) {
    io.stdout(COMMAND_USAGE.diff);
    return ExitCode.Ok;
  }
  if (positionals.length > 0) {
    // Not echoed: a positional here is often the connection string itself.
    throw new UsageError(
      `diff takes no arguments. Pass the database with --db-url or ${DB_URL_ENV}.`,
    );
  }
  const format = choiceOption(values, 'format', FORMATS) ?? 'pretty';
  const maxWarnings = countOption(values, 'max-warnings');
  const quiet = booleanOption(values, 'quiet');
  const dir = stringOption(values, 'dir');
  const configFile = stringOption(values, 'config');
  const since = stringOption(values, 'since');
  const schemas = listOption(values, 'schema');
  const dbUrl = resolveDbUrl(stringOption(values, 'db-url'), io.env);
  if (dbUrl === undefined) {
    throw new UsageError(
      `diff needs a database: pass --db-url <postgres-url> or set ${DB_URL_ENV}. ` +
        'Use a read-only role; see docs/live-mode.md.',
    );
  }

  const { drift } = await import('../../drift.js');
  const result = await drift({
    cwd: io.cwd,
    dbUrl,
    ...(dir === undefined ? {} : { dir }),
    ...(configFile === undefined ? {} : { configFile }),
    ...(since === undefined ? {} : { since }),
    ...(schemas === undefined ? {} : { schemas }),
  });
  const noColor = booleanOption(values, 'no-color');
  io.stdout(
    report(result, format, {
      quiet,
      colors: colors(colorEnabled({ isTTY: io.isTTY, env: io.env, noColor })),
    }),
  );
  return exitCodeFor(result, { maxWarnings, strictParse: false });
}
