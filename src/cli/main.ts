/**
 * Command dispatch and error handling (spec §6.3): usage and config errors exit 2, anything
 * unexpected exits 3 with a request to report it. No network, no update check (G4).
 */
import { UsageError } from '../errors.js';
import { redact } from '../live/url.js';
import { version } from '../version.js';
import { booleanOption, parseCommandArgs, suggestCommand } from './args.js';
import { check } from './commands/check.js';
import { diff } from './commands/diff.js';
import { doctor } from './commands/doctor.js';
import { explain } from './commands/explain.js';
import { init } from './commands/init.js';
import { ExitCode } from './exit-codes.js';
import { type Io, processIo } from './io.js';
import { usage } from './usage.js';

const BIN = 'supabase-grants-lint';
const COMMANDS = ['check', 'doctor', 'diff', 'explain', 'init'] as const;
const ISSUES = 'https://github.com/guptaaman678/supabase-grants-lint/issues';

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code. */
export async function run(argv: readonly string[], io: Io = processIo()): Promise<ExitCode> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    return reportError(error, io);
  }
}

async function dispatch(argv: readonly string[], io: Io): Promise<ExitCode> {
  const [command, ...rest] = argv;
  if (command === undefined || command === 'help') {
    io.stdout(usage());
    return ExitCode.Ok;
  }
  if (command.startsWith('-')) {
    const { values, positionals } = parseCommandArgs(
      argv,
      { version: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
      BIN,
    );
    if (positionals.length > 0) {
      throw new UsageError(
        `Put options after the command, e.g. ${BIN} ${positionals[0] ?? ''} --help.`,
      );
    }
    if (booleanOption(values, 'version')) {
      io.stdout(`${version}\n`);
      return ExitCode.Ok;
    }
    io.stdout(usage());
    return ExitCode.Ok;
  }

  switch (command) {
    case 'check':
      return check(rest, io);
    case 'doctor':
      return doctor(rest, io);
    case 'diff':
      return diff(rest, io);
    case 'explain':
      return explain(rest, io);
    case 'init':
      return init(rest, io);
    default:
      throw new UsageError(`Unknown command "${command}".${suggestCommand(command, COMMANDS)}`);
  }
}

export { redact };

function reportError(error: unknown, io: Io): ExitCode {
  if (error instanceof UsageError) {
    io.stderr(`${redact(error.message)}\n\nRun "${BIN} --help" for usage.\n`);
    return error.exitCode;
  }
  const message = error instanceof Error ? error.message : String(error);
  io.stderr(
    `Internal error: ${redact(message)}\n\n` +
      `This is a bug in ${BIN} ${version}. Please report it at ${ISSUES} ` +
      'with the command you ran and, if you can, the migration that triggers it.\n',
  );
  return ExitCode.Internal;
}
