// robots.txt as RFC 9309 reads it: the groups naming our product token (or `*` when none does),
// merged; the longest matching rule wins, and Allow wins a tie. `*` matches anything and a final
// `$` anchors the end. Crawl-delay and sitemaps are ignored (the fetcher waits a second per host
// anyway).

interface Rule {
  allow: boolean;
  pattern: RegExp;
  /** The rule's length, to find the most specific match. */
  length: number;
}

const toPattern = (path: string): RegExp => {
  const anchored = path.endsWith('$');
  const body = (anchored ? path.slice(0, -1) : path)
    .split('*')
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${body}${anchored ? '$' : ''}`);
};

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
      if (!value) continue;
      const rule = { allow: key === 'allow', pattern: toPattern(value), length: value.length };
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
      if (!rule.pattern.test(path)) continue;
      if (!best || rule.length > best.length || (rule.length === best.length && rule.allow))
        best = rule;
    }
    return best?.allow ?? true;
  }
}
