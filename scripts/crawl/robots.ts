// robots.txt as RFC 9309 reads it: the groups naming our product token (or `*` when none does),
// merged; the longest matching rule wins, and Allow wins a tie. `*` matches anything and a final
// `$` anchors the end. Crawl-delay and sitemaps are ignored (the fetcher waits a second per host
// anyway).

interface Rule {
  allow: boolean;
  /** The rule's path split at each `*`. */
  parts: string[];
  /** A final `$`: the path must end where the rule does. */
  anchored: boolean;
  /** The rule's length, to find the most specific match. */
  length: number;
}

/** Longer rules are ignored: no real path rule comes close. */
const MAX_RULE_LENGTH = 2_000;

function toRule(allow: boolean, path: string): Rule {
  const anchored = path.endsWith('$');
  return {
    allow,
    parts: (anchored ? path.slice(0, -1) : path).split('*'),
    anchored,
    length: path.length,
  };
}

/**
 * Whether the rule matches the path, in linear time: a regular expression built from a hostile
 * rule like `/*a*a*a…*b` backtracks exponentially, and robots.txt is anyone's text. Each part
 * after the first matches at its leftmost place after the one before, which finds a match
 * whenever there is one.
 */
function matches(rule: Rule, path: string): boolean {
  const { parts, anchored } = rule;
  if (!path.startsWith(parts[0])) return false;
  if (parts.length === 1) return !anchored || path.length === parts[0].length;
  let at = parts[0].length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const found = path.indexOf(parts[i], at);
    if (found < 0) return false;
    at = found + parts[i].length;
  }
  if (!anchored) return path.indexOf(parts[last], at) >= 0;
  return path.length - parts[last].length >= at && path.endsWith(parts[last]);
}

export class Robots {
  readonly #rules: Rule[];
  readonly #blocked: boolean;

  private constructor(rules: Rule[], blocked = false) {
    this.#rules = rules;
    this.#blocked = blocked;
  }

  static allowAll(): Robots {
    return new Robots([]);
  }

  static disallowAll(): Robots {
    return new Robots([], true);
  }

  static parse(text: string, agent: string): Robots {
    const wanted = agent.toLowerCase();
    const ours: Rule[] = [];
    const anyone: Rule[] = [];
    let agents: string[] = [];
    let inRules = false;
    let named = false;
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const line = raw.replace(/#.*$/, '').trim();
      const colon = line.indexOf(':');
      if (colon < 0) continue;
      const key = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      if (key === 'user-agent') {
        // A user-agent line after rules starts a new group.
        if (inRules) agents = [];
        inRules = false;
        agents.push(value.toLowerCase());
        if (value.toLowerCase() === wanted) named = true;
        continue;
      }
      if (key !== 'allow' && key !== 'disallow') continue;
      inRules = true;
      // An empty Disallow allows everything: no rule.
      if (!value || value.length > MAX_RULE_LENGTH) continue;
      const rule = toRule(key === 'allow', value);
      if (agents.includes(wanted)) ours.push(rule);
      if (agents.includes('*')) anyone.push(rule);
    }
    return new Robots(named ? ours : anyone);
  }

  /** Whether we may fetch this path (with its query string). */
  allows(path: string): boolean {
    if (this.#blocked) return false;
    // /robots.txt itself is always allowed.
    if (path === '/robots.txt') return true;
    let best: Rule | null = null;
    for (const rule of this.#rules) {
      if (!matches(rule, path)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && rule.allow))
        best = rule;
    }
    return best?.allow ?? true;
  }
}
