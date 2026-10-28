// Reads package metadata from community tap files without running them. Tap repositories are
// untrusted, so their Ruby is lexed as text and only literal values are kept: a field written
// as an expression, or as a string with interpolation in it, comes back null.

export interface RubyPackage {
  kind: 'formula' | 'cask';
  /** Formula: file basename without .rb. Cask: the token in `cask "token" do` (fallback: basename). */
  token: string;
  desc: string | null;
  /** http(s) URLs only. */
  homepage: string | null;
  /** Formulae: `version`, else read from the download URL. Casks: `version`, `:latest` → `latest`. */
  version: string | null;
  /** Formulae only: casks don't declare a licence. */
  license: string | null;
  /** Casks: the first `name`. Formulae: null. */
  name: string | null;
  /**
   * `deprecate!` dated today or earlier, or a future `disable!` without a `deprecate!`. Like
   * dependencies, only counts calls that apply on current macOS on Apple silicon.
   */
  deprecated: boolean;
  /** `disable!` dated today or earlier. */
  disabled: boolean;
  /**
   * Runtime dependencies (formula names) in file order. Formulae: `depends_on "x"` without
   * `:build`, `:test` or `:optional`, outside `on_linux`, `on_intel` and other conditional
   * blocks: what Homebrew's own API lists, for current macOS on Apple silicon. Casks:
   * `depends_on formula:`.
   */
  dependencies: string[];
  /** Casks: `auto_updates true`. */
  autoUpdates: boolean;
}

export function parseFormula(source: string, fileToken: string): RubyPackage {
  return parse('formula', source, fileToken);
}

export function parseCask(source: string, fileToken: string): RubyPackage {
  return parse('cask', source, fileToken);
}

const MAX_DESC = 300;
const MAX_NAME = 120;
const MAX_VERSION = 100;
const MAX_LICENSE = 200;
const MAX_URL = 2048;

function parse(kind: RubyPackage['kind'], source: string, fileToken: string): RubyPackage {
  const pkg: RubyPackage = {
    kind,
    token: fileToken,
    desc: null,
    homepage: null,
    version: null,
    license: null,
    name: null,
    deprecated: false,
    disabled: false,
    dependencies: [],
    autoUpdates: false,
  };
  try {
    const { calls, caskToken } = readDefinition(kind, source);
    if (caskToken !== null) pkg.token = caskToken;

    const version = first(calls, 'version');
    if (version) {
      const [arg] = version.args;
      pkg.version =
        kind === 'cask' && version.args.length === 1 && arg.type === 'sym' && arg.text === 'latest'
          ? 'latest'
          : cleanString(firstLiteral(version.args), MAX_VERSION, 'reject');
    } else if (kind === 'formula') {
      pkg.version = versionFromUrls(calls.get('url') ?? []);
    }

    const desc = first(calls, 'desc');
    if (desc) pkg.desc = cleanString(firstLiteral(desc.args), MAX_DESC, 'truncate');
    const homepage = first(calls, 'homepage');
    if (homepage) pkg.homepage = httpUrl(firstLiteral(homepage.args, pkg.version));
    if (kind === 'formula') {
      const license = first(calls, 'license');
      if (license) pkg.license = parseLicense(license.args);
    } else {
      const name = first(calls, 'name');
      if (name) pkg.name = cleanString(firstLiteral(name.args), MAX_NAME, 'truncate');
      const autoUpdates = first(calls, 'auto_updates');
      pkg.autoUpdates = autoUpdates?.args.length === 1 && isId(autoUpdates.args[0], 'true');
    }

    // Homebrew's rules: a future `deprecate!` date isn't in effect yet, and a future `disable!`
    // date deprecates the package until then, unless there is a `deprecate!`.
    const today = new Date().toISOString().slice(0, 10);
    const effective = (call: Call): boolean => call.applies && !call.conditional;
    const deprecations = (calls.get('deprecate!') ?? []).filter(effective);
    pkg.deprecated = deprecations.some((call) => !isFutureDate(call.args, today));
    for (const call of (calls.get('disable!') ?? []).filter(effective)) {
      if (!isFutureDate(call.args, today)) pkg.disabled = true;
      else if (deprecations.length === 0) pkg.deprecated = true;
    }

    pkg.dependencies = dependencies(kind, calls.get('depends_on') ?? []);
  } catch {
    // Hostile input can still find a corner the lexer doesn't expect: keep what was read.
  }
  return pkg;
}

// --- Lexer ---

type TokenType = 'id' | 'label' | 'sym' | 'str' | 'num' | 'op' | 'lit' | 'nl';

/** A piece of a string literal: plain text, or the Ruby code inside a `#{…}` interpolation. */
type StringPart = { text: string } | { code: string };

interface Token {
  /**
   * `id`: identifier or keyword (`desc`, `OS`, `mac?`, `deprecate!`). `label`: `key:` in keyword
   * arguments. `lit`: a literal whose value doesn't matter (regexp, heredoc, `%w[]`, backticks).
   * `nl`: end of a line or `;`.
   */
  type: TokenType;
  /** Identifier, label or symbol name; operator; number. Empty for strings and literals. */
  text: string;
  /** Strings only. */
  parts?: StringPart[];
  /** Whitespace comes right before the token: tells `foo /re/` from `a / b`. */
  space: boolean;
}

interface Heredoc {
  id: string;
  /** `<<~` and `<<-` allow an indented terminator. */
  indented: boolean;
}

// prettier-ignore
const MULTI_OPS = [
  '**=', '<=>', '===', '...', '||=', '&&=', '<<=', '>>=',
  '**', '==', '!=', '>=', '<=', '&&', '||', '<<', '>>', '=>', '->', '::', '..', '&.',
  '+=', '-=', '*=', '/=', '|=', '&=', '%=', '=~', '!~',
];

/** Keywords after which an expression starts, so `/` and `%` open literals there. */
// prettier-ignore
const EXPR_KEYWORDS = new Set([
  'if', 'unless', 'elsif', 'while', 'until', 'when', 'and', 'or', 'not', 'return', 'then', 'do',
  'else', 'in', 'case', 'yield',
]);

const ESCAPES: Record<string, string> = {
  n: '\n',
  t: '\t',
  r: '\r',
  s: ' ',
  '0': '\0',
  e: '\x1b',
  a: '\x07',
  b: '\b',
  f: '\f',
  v: '\v',
  '\n': '',
};

const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** Deeper `"#{"#{…}"}"` nesting is treated as opaque, so hostile input can't exhaust the stack. */
const MAX_NESTING = 16;

function isIdentChar(code: number): boolean {
  return (
    (code >= 97 && code <= 122) ||
    (code >= 65 && code <= 90) ||
    (code >= 48 && code <= 57) ||
    code === 95 ||
    code > 127
  );
}

function isIdentStart(code: number): boolean {
  return isIdentChar(code) && !(code >= 48 && code <= 57);
}

function lineAt(src: string, i: number): string {
  const end = src.indexOf('\n', i);
  return src.slice(i, end === -1 ? src.length : end);
}

/** After a value (`x`, `)`, `"s"`), `/` and `%` are operators; elsewhere they open literals. */
function afterValue(tokens: Token[]): boolean {
  const prev = tokens[tokens.length - 1];
  if (!prev) return false;
  switch (prev.type) {
    case 'nl':
    case 'label':
      return false;
    case 'op':
      return prev.text === ')' || prev.text === ']' || prev.text === '}';
    case 'id':
      return !EXPR_KEYWORDS.has(prev.text);
    default:
      return true;
  }
}

function lex(source: string): Token[] {
  const src = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const tokens: Token[] = [];
  const heredocs: Heredoc[] = [];
  let space = false;
  // Where an unclosed regexp scan gave up. A later `/` before that point can't close either,
  // so skip the rescan: otherwise a file of escaped slashes (`(\/\/\/…`) takes quadratic time.
  let regexDeadUntil = { line: -1, multiline: -1 };
  let i = 0;

  const push = (type: TokenType, text: string, parts?: StringPart[]): void => {
    tokens.push(parts ? { type, text, parts, space } : { type, text, space });
    space = false;
  };

  while (i < src.length) {
    const c = src[i];
    if (i === 0 || src[i - 1] === '\n') {
      if (lineAt(src, i).trimEnd() === '__END__') break; // the rest is data, often a patch
      if (/^=begin(?:\s|$)/.test(lineAt(src, i))) {
        i = skipBlockComment(src, i);
        continue;
      }
    }

    if (c === '\n') {
      push('nl', '');
      i++;
      // Heredoc bodies start on the line after the one that opened them.
      for (const heredoc of heredocs.splice(0)) i = skipHeredoc(src, i, heredoc);
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') {
      space = true;
      i++;
      continue;
    }
    if (c === '\\' && src[i + 1] === '\n') {
      space = true;
      i += 2;
      continue;
    }
    if (c === '#') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '"' || c === '`') {
      const read = readString(src, i + 1, c, '', true, 0);
      push(c === '"' ? 'str' : 'lit', '', read.parts);
      i = read.end;
      continue;
    }
    if (c === "'") {
      const read = readString(src, i + 1, "'", '', false, 0);
      push('str', '', read.parts);
      i = read.end;
      continue;
    }

    const valueBefore = afterValue(tokens);
    // `foo %w[a b]` and `foo /re/` are literals; `a % b` and `a / b` are operators.
    const literalFollows = !valueBefore || (space && !/[\s=]/.test(src[i + 1] ?? ' '));

    if (c === '%' && literalFollows) {
      const m = /^%([qQwWiIrsx]?)([^\w\s])/.exec(src.slice(i, i + 3));
      if (m) {
        const [whole, type, open] = m;
        const close = PAIRS[open] ?? open;
        const interpolate = type === '' || 'QWIrx'.includes(type);
        const read = readString(src, i + whole.length, close, PAIRS[open] ? open : '', interpolate, 0);
        push(type === '' || type === 'q' || type === 'Q' ? 'str' : 'lit', '', read.parts);
        i = read.end;
        if (type === 'r') while (/[a-z]/.test(src[i] ?? '')) i++;
        continue;
      }
    }
    if (c === '/' && literalFollows) {
      // Where only an expression can start (`regex(/…/x)`), a regexp may span lines; after
      // `foo /` it could still be a division, so it must close on the same line.
      const multiline = !valueBefore;
      if (i >= (multiline ? regexDeadUntil.multiline : regexDeadUntil.line)) {
        const { end, stop } = regexEnd(src, i + 1, multiline);
        if (end !== -1) {
          push('lit', '');
          i = end;
          while (/[a-z]/.test(src[i] ?? '')) i++;
          continue;
        }
        regexDeadUntil = multiline
          ? { line: stop, multiline: stop }
          : { ...regexDeadUntil, line: stop };
      }
    }
    if (c === '<' && src[i + 1] === '<') {
      const m = /^<<([~-]?)(["'`]?)([A-Za-z_]\w*)\2/.exec(src.slice(i, i + 80));
      // `<<~ID` and `<<-ID` are always heredocs; a bare `<<ID` only where an argument can start.
      const plain = m !== null && (!valueBefore || space) && (m[2] !== '' || /^[A-Z_][A-Z0-9_]*$/.test(m[3]));
      if (m && (m[1] !== '' || plain)) {
        heredocs.push({ id: m[3], indented: m[1] !== '' });
        push('lit', '');
        i += m[0].length;
        continue;
      }
    }
    if (c === '?' && !valueBefore && /\S/.test(src[i + 1] ?? ' ')) {
      // Character literal: `?a`, `?"`, `?\n`.
      const len = src[i + 1] === '\\' ? 3 : 2;
      if (!isIdentChar(src.charCodeAt(i + len))) {
        push('lit', '');
        i += len;
        continue;
      }
    }

    const code = src.charCodeAt(i);
    if (code >= 48 && code <= 57) {
      const m = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)/.exec(
        src.slice(i, i + 64),
      );
      const text = m ? m[0] : c;
      push('num', text);
      i += text.length;
      continue;
    }
    if (isIdentStart(code) || c === '@' || c === '$') {
      let j = i;
      if (c === '$') j++;
      else while (src[j] === '@') j++;
      while (j < src.length && isIdentChar(src.charCodeAt(j))) j++;
      if ((src[j] === '?' || src[j] === '!') && src[j + 1] !== '=') j++;
      const name = src.slice(i, j);
      if (src[j] === ':' && src[j + 1] !== ':' && c !== '@' && c !== '$') {
        push('label', name);
        i = j + 1;
      } else {
        push('id', name);
        i = Math.max(j, i + 1);
      }
      continue;
    }
    if (c === ':' && src[i + 1] !== ':') {
      const next = src[i + 1] ?? '';
      if (next === '"' || next === "'") {
        const read = readString(src, i + 2, next, '', next === '"', 0);
        push('sym', joinText(read.parts) ?? '');
        i = read.end;
        continue;
      }
      if (isIdentStart(src.charCodeAt(i + 1))) {
        let j = i + 1;
        while (j < src.length && isIdentChar(src.charCodeAt(j))) j++;
        if (src[j] === '?' || src[j] === '!') j++;
        push('sym', src.slice(i + 1, j));
        i = j;
        continue;
      }
    }
    if (c === ';') {
      push('nl', '');
      i++;
      continue;
    }
    const op = MULTI_OPS.find((candidate) => src.startsWith(candidate, i)) ?? c;
    push('op', op);
    i += op.length;
  }
  return tokens;
}

function skipBlockComment(src: string, start: number): number {
  let i = start;
  while (i < src.length) {
    const end = src.indexOf('\n', i);
    const next = end === -1 ? src.length : end + 1;
    if (i !== start && /^=end(?:\s|$)/.test(lineAt(src, i))) return next;
    i = next;
  }
  return src.length;
}

function skipHeredoc(src: string, start: number, heredoc: Heredoc): number {
  let i = start;
  while (i < src.length) {
    const line = lineAt(src, i);
    i += line.length + 1;
    if ((heredoc.indented ? line.trim() : line.trimEnd()) === heredoc.id) return Math.min(i, src.length);
  }
  return src.length;
}

/**
 * Reads a string body from `start` (just after the opening quote) to its closing delimiter.
 * `open` is set for bracket delimiters, which nest: `%Q(a (b) c)`.
 */
function readString(
  src: string,
  start: number,
  close: string,
  open: string,
  interpolate: boolean,
  nesting: number,
): { parts: StringPart[]; end: number } {
  const parts: StringPart[] = [];
  let text = '';
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      const next = src[i + 1] ?? '';
      if (interpolate) {
        const escape = readEscape(src, i + 1);
        text += escape.text;
        i = escape.end;
      } else {
        text += next === close || next === '\\' || (open !== '' && next === open) ? next : c + next;
        i += 2;
      }
      continue;
    }
    if (open !== '' && c === open) {
      depth++;
    } else if (c === close) {
      if (depth === 0) {
        if (text) parts.push({ text });
        return { parts, end: i + 1 };
      }
      depth--;
    } else if (interpolate && c === '#' && src[i + 1] === '{') {
      if (text) parts.push({ text });
      text = '';
      const end = nesting < MAX_NESTING ? codeEnd(src, i + 2, nesting + 1) : src.length;
      parts.push({ code: src.slice(i + 2, Math.max(i + 2, end - 1)) });
      i = end;
      continue;
    } else if (interpolate && c === '#' && /^[@$][A-Za-z_]/.test(src.slice(i + 1, i + 3))) {
      // `"#@var"` interpolates an instance variable.
      if (text) parts.push({ text });
      text = '';
      let j = i + 2;
      while (j < src.length && isIdentChar(src.charCodeAt(j))) j++;
      parts.push({ code: src.slice(i + 1, j) });
      i = j;
      continue;
    }
    text += c;
    i++;
  }
  // Unterminated: the file is broken, so the value is as unknown as an interpolation.
  return { parts: [...parts, { code: '' }], end: src.length };
}

function readEscape(src: string, i: number): { text: string; end: number } {
  const c = src[i] ?? '';
  if (c in ESCAPES) return { text: ESCAPES[c], end: i + 1 };
  const unicode = /^u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(src.slice(i, i + 9));
  if (unicode) {
    const point = parseInt(unicode[1] ?? unicode[2], 16);
    return { text: point <= 0x10ffff ? String.fromCodePoint(point) : '', end: i + unicode[0].length };
  }
  const hex = /^x([0-9a-fA-F]{1,2})/.exec(src.slice(i, i + 3));
  if (hex) return { text: String.fromCharCode(parseInt(hex[1], 16)), end: i + hex[0].length };
  return { text: c, end: i + 1 };
}

/** End (just past the closing `}`) of the code inside a `#{…}`. */
function codeEnd(src: string, start: number, nesting: number): number {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      if (depth === 0) return i + 1;
      depth--;
    } else if (c === '"' || c === '`' || c === "'") {
      i = readString(src, i + 1, c, '', c !== "'", nesting).end - 1;
    } else if (c === '\\') i++;
  }
  return src.length;
}

/** End of a `/regexp/` starting at `start`, or -1 when there is none (it was a division). */
/** End of a regexp literal (after the closing `/`), or -1 and where the scan stopped. */
function regexEnd(src: string, start: number, multiline: boolean): { end: number; stop: number } {
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '\n' && !multiline) return { end: -1, stop: i };
    if (c === '\\') i++;
    else if (c === '/') return { end: i + 1, stop: i + 1 };
    else if (c === '#' && src[i + 1] === '{') i = codeEnd(src, i + 2, 1) - 1;
  }
  return { end: -1, stop: src.length };
}

function joinText(parts: StringPart[] | undefined): string | null {
  let out = '';
  for (const part of parts ?? []) {
    if ('code' in part) return null;
    out += part.text;
  }
  return out;
}

// --- Statements and blocks ---

/**
 * Whether a block's contents apply on the current macOS on Apple silicon, the system Homebrew's
 * own API data describes: `on_macos`, `on_arm` and `if OS.mac?` do; `on_linux` and `on_intel`
 * don't; `on_ventura :or_older` or `if build.head?` may or may not.
 */
type Applies = 'yes' | 'no' | 'maybe';

interface Frame {
  /** What opened the block: a keyword (`if`, `def`, `class`) or the method given `do` (`on_macos`). */
  name: string;
  applies: Applies;
  /** An `if` on a single platform check, whose `else` is the opposite. */
  flips: boolean;
  /** The formula class or the `cask … do` block. */
  root: boolean;
}

interface Call {
  args: Token[];
  /** Directly in the definition, not in an `on_macos`-style or `if` block. */
  top: boolean;
  /** Every enclosing block applies on current macOS on Apple silicon (see Applies). */
  applies: boolean;
  /** Has a modifier: `depends_on "x" if build.with? "y"`. */
  conditional: boolean;
}

/** Operators that can't end a statement: the next line continues it. */
const CONTINUES = new Set([',', '=>', '&&', '||', '.', '&.', '=', '||=', '&&=', '+', '?', ':']);
/** Keywords that always open a block closed by `end`. */
const KEYWORD_BLOCKS = new Set(['case', 'for', 'begin', 'class', 'module', 'def']);
const CONDITIONALS = new Set(['if', 'unless', 'while', 'until']);
const LOOPS = new Set(['while', 'until', 'for']);
const MODIFIERS = new Set(['if', 'unless', 'while', 'until', 'rescue']);
const MAX_DEPTH = 64;
/** Blocks whose contents still describe the package (as opposed to `livecheck`, `resource`, `def`…). */
const TRANSPARENT = new Set(['if', 'unless', 'case', 'stable']);

function splitStatements(tokens: Token[]): Token[][] {
  const statements: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (let k = 0; k < tokens.length; k++) {
    const token = tokens[k];
    if (token.type !== 'nl') {
      if (token.type === 'op' && '([{'.includes(token.text)) depth++;
      else if (token.type === 'op' && ')]}'.includes(token.text)) depth = Math.max(0, depth - 1);
      current.push(token);
      continue;
    }
    let next = k + 1;
    while (tokens[next]?.type === 'nl') next++;
    k = next - 1; // blank lines in a row are one break
    if (current.length === 0) continue;
    const last = current[current.length - 1];
    const continues =
      depth > 0 ||
      (last.type === 'op' && CONTINUES.has(last.text)) ||
      (last.type === 'id' && (last.text === 'and' || last.text === 'or' || last.text === 'not')) ||
      (tokens[next]?.type === 'op' && (tokens[next].text === '.' || tokens[next].text === '&.'));
    if (!continues) {
      statements.push(current);
      current = [];
    }
  }
  if (current.length > 0) statements.push(current);
  return statements;
}

function isId(token: Token | undefined, text?: string): boolean {
  return token?.type === 'id' && (text === undefined || token.text === text);
}

function isOp(token: Token | undefined, text: string): boolean {
  return token?.type === 'op' && token.text === text;
}

const CHECKS: Record<string, boolean> = {
  'OS.mac?': true,
  'OS.linux?': false,
  'Hardware::CPU.arm?': true,
  'Hardware::CPU.intel?': false,
};

/** Whether a condition holds on current macOS on Apple silicon, for plain platform checks. */
function conditionApplies(cond: Token[]): { applies: Applies; single: boolean } {
  const parts: boolean[] = [];
  let text = '';
  for (const token of [...cond.filter((t) => !isId(t, 'then')), null]) {
    if (token === null || isOp(token, '&&') || isId(token, 'and')) {
      if (!(text in CHECKS)) return { applies: 'maybe', single: false };
      parts.push(CHECKS[text]);
      text = '';
    } else text += token.text;
  }
  const applies = parts.every(Boolean) ? 'yes' : 'no';
  return { applies, single: parts.length === 1 };
}

function opposite(applies: Applies): Applies {
  return applies === 'yes' ? 'no' : applies === 'no' ? 'yes' : 'maybe';
}

function keywordFrame(keyword: string, rest: Token[]): Frame {
  if (keyword === 'if' || keyword === 'unless') {
    const { applies, single } = conditionApplies(rest);
    // `unless a && b` holds when either fails: only a single check can be turned around.
    const value = keyword === 'if' ? applies : single ? opposite(applies) : 'maybe';
    return { name: keyword, applies: value, flips: single, root: false };
  }
  return { name: keyword, applies: keyword === 'case' ? 'maybe' : 'yes', flips: false, root: false };
}

function blockFrame(statement: Token[]): Frame {
  const name = isId(statement[0]) ? statement[0].text : '';
  const symbols = statement.filter((token) => token.type === 'sym').map((token) => token.text);
  let applies: Applies = 'yes';
  if (name === 'on_linux' || name === 'on_intel') applies = 'no';
  else if (name === 'on_system') {
    // `on_system :linux, macos: :sonoma_or_newer`
    const macos = statement.findIndex((token) => token.type === 'label' && token.text === 'macos');
    const version = macos === -1 ? '' : statement[macos + 1]?.text ?? '';
    applies = macos === -1 || version.endsWith('_or_older') ? 'no' : version.endsWith('_or_newer') ? 'yes' : 'maybe';
  }
  else if (/^on_\w+$/.test(name) && name !== 'on_macos' && name !== 'on_arm') {
    // A macOS version: `on_sonoma :or_newer` covers the current one.
    applies = symbols.includes('or_newer') ? 'yes' : symbols.includes('or_older') ? 'no' : 'maybe';
  }
  return { name, applies, flips: false, root: false };
}

/** `def name = value` has no `end`; `def name=(value)` (a setter) does. */
function isEndlessDef(statement: Token[], start: number): boolean {
  let depth = 0;
  for (let k = start + 1; k < statement.length; k++) {
    const token = statement[k];
    if (token.type !== 'op') continue;
    if ('([{'.includes(token.text)) depth++;
    else if (')]}'.includes(token.text)) depth--;
    else if (token.text === '=' && depth === 0 && token.space) return true;
  }
  return false;
}

/** `class Foo < Formula`, or a subclass of it by name: `< PortableFormula`, `< ::Formula`. */
function isFormulaClass(statement: Token[]): boolean {
  const lt = statement.findIndex((token) => isOp(token, '<'));
  const parent = statement.slice(lt + 1).filter((token) => !isOp(token, '::'));
  return lt !== -1 && parent.length === 1 && isId(parent[0]) && parent[0].text.endsWith('Formula');
}

/**
 * Lexes the file, follows its blocks, and returns the calls made in the package definition,
 * grouped by method name: `desc`, `url`, `depends_on`…
 */
function readDefinition(
  kind: RubyPackage['kind'],
  source: string,
): { calls: Map<string, Call[]>; caskToken: string | null } {
  const calls = new Map<string, Call[]>();
  let caskToken: string | null = null;
  let rootFound = false;
  let stack: Frame[] = [];

  for (const statement of splitStatements(lex(source))) {
    if (stack.length > MAX_DEPTH) break; // no package nests this deep: hostile or broken
    record(calls, statement, stack);

    let loopDo = LOOPS.has(statement[0].text) && isId(statement[0]);
    for (let k = 0; k < statement.length; k++) {
      const token = statement[k];
      if (token.type !== 'id') continue;
      const prev = statement[k - 1];
      // `foo.end` and `Foo::Begin` are method calls and constants, not keywords.
      if (prev && (isOp(prev, '.') || isOp(prev, '&.') || isOp(prev, '::'))) continue;

      if (token.text === 'end') {
        stack = stack.slice(0, -1);
      } else if (token.text === 'do') {
        if (loopDo) {
          loopDo = false;
          continue;
        }
        const frame = blockFrame(statement);
        if (kind === 'cask' && !rootFound && stack.length === 0 && frame.name === 'cask') {
          frame.root = rootFound = true;
          caskToken = validCaskToken(literal(statement.slice(1, 2)));
        }
        stack = [...stack, frame];
      } else if (
        KEYWORD_BLOCKS.has(token.text) ||
        // `if` and friends open a block at the start of a statement or expression (`x = if …`,
        // `args << if …`); after a value they are modifiers (`depends_on "x" if y`), no `end`.
        (CONDITIONALS.has(token.text) &&
          (k === 0 || prev.type === 'label' || (prev.type === 'op' && !')]}'.includes(prev.text))))
      ) {
        if (token.text === 'def' && isEndlessDef(statement, k)) continue;
        const frame = keywordFrame(token.text, statement.slice(k + 1));
        if (kind === 'formula' && token.text === 'class' && !rootFound && stack.length === 0) {
          frame.root = rootFound = isFormulaClass(statement);
        }
        stack = [...stack, frame];
      } else if (k === 0 && (token.text === 'elsif' || token.text === 'else')) {
        const top = stack[stack.length - 1];
        if (top && (top.name === 'if' || top.name === 'unless')) {
          const applies =
            token.text === 'else'
              ? top.flips
                ? opposite(top.applies)
                : 'maybe'
              : conditionApplies(statement.slice(1)).applies;
          stack = [...stack.slice(0, -1), { ...top, applies, flips: false }];
        }
      }
    }
  }
  return { calls, caskToken };
}

/** Files a statement under its method name when it sits in the package definition. */
function record(calls: Map<string, Call[]>, statement: Token[], stack: Frame[]): void {
  if (stack.length === 0 || !stack[0].root) return;
  const nested = stack.slice(1);
  if (!nested.every((frame) => TRANSPARENT.has(frame.name) || /^on_\w+$/.test(frame.name))) return;
  const [method] = statement;
  if (method.type !== 'id') return;
  const parsed = callArgs(statement);
  if (!parsed) return;
  const call: Call = {
    args: parsed.args,
    top: nested.length === 0,
    applies: nested.every((frame) => frame.applies === 'yes'),
    conditional: parsed.conditional,
  };
  const list = calls.get(method.text);
  if (list) list.push(call);
  else calls.set(method.text, [call]);
}

/** The arguments of a call statement (`desc "x"`, `desc("x")`), without a trailing modifier or block. */
function callArgs(statement: Token[]): { args: Token[]; conditional: boolean } | null {
  let args = statement.slice(1);
  if (args[0]?.type === 'op' && args[0].text !== '(' && args[0].text !== '[') return null; // `desc = x`
  let conditional = false;
  let depth = 0;
  for (let k = 0; k < args.length; k++) {
    const token = args[k];
    if (token.type === 'op' && '([{'.includes(token.text)) depth++;
    else if (token.type === 'op' && ')]}'.includes(token.text)) depth--;
    else if (depth === 0 && token.type === 'id' && (MODIFIERS.has(token.text) || token.text === 'do')) {
      conditional = token.text !== 'do';
      args = args.slice(0, k);
      break;
    }
  }
  if (isOp(args[0], '(') && closingIndex(args, 0) === args.length - 1) args = args.slice(1, -1);
  return { args, conditional };
}

function closingIndex(tokens: Token[], open: number): number {
  let depth = 0;
  for (let k = open; k < tokens.length; k++) {
    if (tokens[k].type !== 'op') continue;
    if ('([{'.includes(tokens[k].text)) depth++;
    else if (')]}'.includes(tokens[k].text) && --depth === 0) return k;
  }
  return -1;
}

/** Splits arguments at top-level commas. */
function splitArgs(args: Token[]): Token[][] {
  const out: Token[][] = [[]];
  let depth = 0;
  for (const token of args) {
    if (token.type === 'op' && '([{'.includes(token.text)) depth++;
    else if (token.type === 'op' && ')]}'.includes(token.text)) depth--;
    if (depth === 0 && isOp(token, ',')) out.push([]);
    else out[out.length - 1].push(token);
  }
  return out.filter((arg) => arg.length > 0);
}

/**
 * Calls in order of preference: directly in the definition, then in blocks that apply on current
 * macOS on Apple silicon (`on_arm`, `on_sonoma :or_newer`), then in any other block.
 */
function preferred(calls: Call[]): Call[] {
  const top = calls.filter((call) => call.top);
  if (top.length > 0) return top;
  const applying = calls.filter((call) => call.applies);
  return applying.length > 0 ? applying : calls;
}

function first(calls: Map<string, Call[]>, method: string): Call | undefined {
  return preferred(calls.get(method) ?? [])[0];
}

// --- Values ---

/**
 * The value of a string argument (adjacent literals are joined, as Ruby does). Null for anything
 * else, or for a string with interpolation, except `#{version}` when the version is known.
 */
function literal(args: Token[], version: string | null = null): string | null {
  if (args.length === 0 || args.some((token) => token.type !== 'str')) return null;
  let out = '';
  for (const token of args) {
    for (const part of token.parts ?? []) {
      if ('text' in part) out += part.text;
      else if (version !== null && part.code.trim() === 'version') out += version;
      else return null;
    }
  }
  return out;
}

/** The first argument as a string: `homepage "https://…", browsed: "2026-09-05"`. */
function firstLiteral(args: Token[], version: string | null = null): string | null {
  const [first] = splitArgs(args);
  return first ? literal(first, version) : null;
}

/** Control and bidi-override characters become spaces; runs of whitespace collapse to one. */
function stripControl(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    const control =
      code < 0x20 ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069);
    out += control ? ' ' : char;
  }
  return out.replace(/\s+/g, ' ').trim();
}

/** Cleans a display string. Too long: `truncate` cuts it with an ellipsis, `reject` gives null. */
function cleanString(value: string | null, max: number, overflow: 'truncate' | 'reject'): string | null {
  if (value === null) return null;
  const clean = stripControl(value);
  if (clean === '') return null;
  const chars = Array.from(clean);
  if (chars.length <= max) return clean;
  return overflow === 'reject' ? null : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

function httpUrl(value: string | null): string | null {
  const url = cleanString(value, MAX_URL, 'reject');
  if (url === null || !/^https?:\/\/\S+$/i.test(url)) return null;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function validCaskToken(value: string | null): string | null {
  return value !== null && value.length <= 100 && /^[a-z0-9][a-z0-9@._+-]*$/i.test(value) ? value : null;
}

// formula.json spells `:public_domain` this way; use the same so both sources agree.
const PUBLIC_DOMAIN = 'LicenseRef-Homebrew-public-domain';

function parseLicense(args: Token[]): string | null {
  if (args.length === 1 && args[0].type === 'sym') {
    return args[0].text === 'public_domain' ? PUBLIC_DOMAIN : null; // and :cannot_represent
  }
  const [label, open] = args;
  if (label?.type === 'label' && (label.text === 'any_of' || label.text === 'all_of')) {
    if (!isOp(open, '[') || closingIndex(args, 1) !== args.length - 1) return null;
    const items: string[] = [];
    for (const item of splitArgs(args.slice(2, -1))) {
      const value =
        item.length === 1 && item[0].type === 'sym' && item[0].text === 'public_domain'
          ? PUBLIC_DOMAIN
          : cleanString(literal(item), MAX_LICENSE, 'reject');
      if (value === null) return null; // a nested expression: too complex to flatten
      items.push(value);
    }
    if (items.length === 0) return null;
    const joined = items.join(label.text === 'any_of' ? ' OR ' : ' AND ');
    return joined.length <= MAX_LICENSE ? joined : null;
  }
  return cleanString(literal(args), MAX_LICENSE, 'reject');
}

function isFutureDate(args: Token[], today: string): boolean {
  const index = args.findIndex((token) => token.type === 'label' && token.text === 'date');
  const date = index === -1 ? null : literal(args.slice(index + 1, index + 2));
  return date !== null && /^\d{4}-\d{2}-\d{2}$/.test(date) && date > today;
}

const DEPENDENCY = /^[A-Za-z0-9][A-Za-z0-9@._+-]*(?:\/[A-Za-z0-9][A-Za-z0-9@._+-]*){0,2}$/;
const NOT_RUNTIME = new Set(['build', 'test', 'optional']);

function dependencies(kind: RubyPackage['kind'], calls: Call[]): string[] {
  const names = new Set<string>();
  const add = (name: string | null): void => {
    if (name !== null && name.length <= 200 && DEPENDENCY.test(name)) names.add(name);
  };
  for (const call of calls) {
    if (call.conditional || !call.applies) continue;
    const args = splitArgs(call.args);
    if (kind === 'cask') {
      // `depends_on formula: "x"` or `formula: ["x", "y"]`; casks and macOS versions aren't formulae.
      for (const arg of args) {
        if (arg[0].type !== 'label' || arg[0].text !== 'formula') continue;
        const value = arg.slice(1);
        if (isOp(value[0], '[')) for (const item of splitArgs(value.slice(1, -1))) add(literal(item));
        else add(literal(value));
      }
      continue;
    }
    // `depends_on "x"`, `"x" => :build`, `"x" => [:build, :test]`. Symbols and `macos:` are
    // requirements, not formulae.
    if (args.length === 0 || args[0][0].type !== 'str') continue;
    const tags = call.args.filter((token) => token.type === 'sym').map((token) => token.text);
    if (tags.some((tag) => NOT_RUNTIME.has(tag))) continue;
    add(literal(args[0].slice(0, 1)));
  }
  return [...names];
}

// --- Versions from download URLs ---

/** `1.2`, `1.2.3`, with an optional pre-release (`-beta.15`, `rc1`), patch (`p18`) or letter (`1.1.1w`). */
const DOTTED = String.raw`\d+(?:\.\d+)+(?:[-.]?(?:alpha|beta|rc|pre|p)(?:[.-]?\d+)?|[a-z](?![a-z]))?`;
/** A tag naming a version: `v1.2.3`, `1.2.3`, `r1.2`, `release-1.2.3`, `bun-v1.4.4`, `v24`. */
const TAG = new RegExp(String.raw`^(?:(?:@?[a-z][\w+/-]*?[-_/@])?[rv]?(${DOTTED})|v?(\d+))$`, 'i');
/** A version ending a file name: `foo-1.2.3`, `foo_1.2.3`, `foo-v1.2.3`, `foo.v1.2`, `v1.2.3`. */
const FILE_VERSION = new RegExp(String.raw`(?:^|[-_@]|\.(?=[rv]))[rv]?(${DOTTED})$`, 'i');
const DIR_VERSION = new RegExp(String.raw`^[rv]?(${DOTTED})$`, 'i');
/** Words that follow the version in release file names, stripped from the end. */
const SUFFIX =
  /[-_.](?:darwin|macos|mac|osx|apple|linux|unknown|gnu|musl|windows|win|pc|universal2?|amd64|x86_64|x86-64|x64|arm64|aarch64|armv\d\w*|arm|i[3-6]86|x86|386|noarch|all|bin|binary|static|portable|src|sources?|dist|full|final|stable|(?:macos|osx|ubuntu|debian|fedora|centos)[-_]?\d+(?:\.\d+)*|el\d+|orig)$/i;
/**
 * Before the version, another dotted number (`bashdb-5.2-1.2.0`, `uvw-v3.4.0_libuv_v1.48`) or a
 * date (`libedit-20260512-3.1`) means the version has several parts: too ambiguous to guess.
 */
const COMPOUND = /\d\.\d|(?:^|[-_.])\d{6,}[-_.]?$/;
const FILE_EXT =
  /\.(?:tar\.(?:gz|bz2|xz|lz|lzma|zst|Z)|tgz|tbz2?|txz|tar|zip|7z|gz|bz2|xz|zst|dmg|pkg|gem|jar|war|deb|rpm|apk|AppImage|exe|msi|phar|pyz|whl|vsix|run|sh|bin|crate)$/i;
/** GitHub source archives: `…/archive/v1.2.3.tar.gz`, `…/archive/refs/tags/v1.2.3.zip`, `…/tarball/v1.2.3`. */
const ARCHIVE = /\/(?:archive|tarball|zipball)\/(?:refs\/tags\/)?([^/]+)$/;

/**
 * Formula version from its `url` (and `tag:` for git URLs): the top-level one, else those in
 * blocks for current macOS (see preferred), which must then agree.
 */
function versionFromUrls(urls: Call[]): string | null {
  const candidates = preferred(urls);
  let found: string | null = null;
  for (const call of candidates[0]?.top ? candidates.slice(0, 1) : candidates) {
    const [first, ...options] = splitArgs(call.args);
    const url = first ? literal(first) : null;
    const tag = options.find((arg) => arg[0].type === 'label' && arg[0].text === 'tag');
    const version =
      url === null ? null : tag ? versionFromTag(literal(tag.slice(1))) : versionFromUrl(url);
    if (version === null || (found !== null && found !== version)) return null;
    found = version;
  }
  return found;
}

function versionFromTag(tag: string | null): string | null {
  const m = tag !== null && tag.length <= MAX_VERSION ? TAG.exec(tag) : null;
  return m ? (m[1] ?? m[2]) : null;
}

/**
 * The version in a download URL, for the shapes release URLs commonly take. Null when none
 * matches: a wrong version is worse than none.
 */
function versionFromUrl(url: string): string | null {
  if (url.length > MAX_URL) return null;
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(url).pathname);
  } catch {
    return null;
  }
  const segments = pathname.split('/').filter(Boolean);
  const file = segments.pop() ?? '';

  // …/releases/download/<tag>/file on GitHub, GitLab, Gitea and Forgejo. A plain `v1.2.3` tag
  // wins; a prefixed one (`foo-v1.2`) only when the file name has no version.
  const download = segments.lastIndexOf('download');
  const release =
    download > 0 && segments[download - 1] === 'releases' && download === segments.length - 2
      ? segments[download + 1]
      : null;
  if (release !== null && DIR_VERSION.test(release)) return versionFromTag(release);
  const archive = ARCHIVE.exec(pathname);
  if (archive) {
    const version = versionFromTag(archive[1].replace(FILE_EXT, ''));
    if (version) return version;
  }

  // The file name, once its extension and platform words are gone.
  let stem = file.replace(FILE_EXT, '');
  for (let previous = ''; previous !== stem; ) {
    previous = stem;
    stem = stem.replace(SUFFIX, '');
  }
  const named = FILE_VERSION.exec(stem);
  if (named) return COMPOUND.test(stem.slice(0, named.index)) ? null : named[1];
  if (/\d/.test(stem)) {
    // `releases/download/v23/fastd-23.tar.xz`: a whole-number release named in the file too.
    const whole = release === null ? null : /^[rv]?(\d+)$/i.exec(release);
    return whole && new RegExp(String.raw`[-_]${whole[1]}$`).test(stem) ? whole[1] : null;
  }
  if (release !== null) return versionFromTag(release);

  // A directory named after the version, for a file name without one: …/v1.2.3/foo-macos.zip.
  for (const segment of segments.reverse()) {
    const m = DIR_VERSION.exec(segment);
    if (m) return m[1];
  }
  return null;
}
