/**
 * The few `supabase/config.toml` settings the linter reads: `[api] auto_expose_new_tables`
 * (`doctor`, ADR-002 item 3), `[db.migrations] schema_paths` and `[experimental.pgdelta]`
 * (declarative schemas). A minimal lookup (tables, dotted keys, comments, booleans, strings and
 * arrays of strings), not a TOML parser (G5). Values of any other type are skipped.
 */
export type TomlValue = boolean | string | readonly string[];

/** `line` without a trailing `#` comment; a `#` inside a quoted string is kept. */
function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote !== null) {
      if (c === '\\' && quote === '"') i += 1;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#') {
      return line.slice(0, i);
    }
  }
  return line;
}

/** `"api" . auto_expose` -> `api.auto_expose`. */
function unquoteKey(key: string): string {
  return key
    .split('.')
    .map((part) =>
      part
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .replace(/^'(.*)'$/, '$1'),
    )
    .join('.');
}

const STRING = /"((?:[^"\\]|\\.)*)"|'([^']*)'/g;

function unescape(basic: string): string {
  return basic.replace(/\\(["\\/bfnrt])/g, (_, c: string) =>
    c === 'n' ? '\n' : c === 't' ? '\t' : c === 'b' || c === 'f' || c === 'r' ? '' : c,
  );
}

function strings(text: string): string[] {
  return [...text.matchAll(STRING)].map((m) => m[2] ?? unescape(m[1] ?? ''));
}

/** Whether every `[` of `text` outside strings is closed. */
function isBalanced(text: string): boolean {
  const bare = text.replace(STRING, '');
  return (bare.match(/\[/g) ?? []).length <= (bare.match(/\]/g) ?? []).length;
}

function parseValue(raw: string): TomlValue | undefined {
  const value = raw.trim();
  if (value === 'true' || value === 'false') return value === 'true';
  if (/^("(?:[^"\\]|\\.)*"|'[^']*')$/.test(value)) return strings(value)[0] ?? '';
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1);
    // Only an array of strings: anything else left over (numbers, tables) is not one.
    const rest = inner.replace(STRING, '').replace(/[\s,]/g, '');
    return rest === '' ? strings(inner) : undefined;
  }
  return undefined;
}

/** Every boolean, string and string-array setting of `toml`, keyed by its dotted path. */
export function readSupabaseToml(toml: string): ReadonlyMap<string, TomlValue> {
  const values = new Map<string, TomlValue>();
  let table = '';
  const lines = toml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = stripComment(lines[i] ?? '').trim();
    const header = /^\[\[?([^\]]*)\]\]?$/.exec(line);
    if (header !== null) {
      table = unquoteKey(header[1] ?? '');
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let raw = line.slice(eq + 1);
    // A multi-line array: read on until its brackets close.
    while (raw.trim().startsWith('[') && !isBalanced(raw) && i + 1 < lines.length) {
      i += 1;
      raw += ` ${stripComment(lines[i] ?? '').trim()}`;
    }
    const value = parseValue(raw);
    if (value === undefined) continue;
    const key = [table, unquoteKey(line.slice(0, eq))].filter((part) => part !== '').join('.');
    values.set(key, value);
  }
  return values;
}

/** `[api] auto_expose_new_tables`, or `null` when unset or not a boolean. */
export function autoExposeSetting(toml: string): boolean | null {
  const value = readSupabaseToml(toml).get('api.auto_expose_new_tables');
  return typeof value === 'boolean' ? value : null;
}
