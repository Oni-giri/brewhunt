// Deterministic checks on the AI step's draft (M5 C7). Model output is untrusted draft data: a
// sentence that fails a check is dropped, never repaired, and nothing here can approve content
// (the second model and the owner's review come after). Pure functions, no I/O.
//
// Every summary sentence and bullet must cite the sources the model read, by quoting them. The
// quote must be an exact span of the stored source text (whitespace collapsed, and curly quotes and
// dashes read as straight ones); when the model gives offsets too (Anthropic's citations), they
// must point at the same span. Then, per sentence:
// - every number written in digits must appear in its quotes (spelled-out numbers aren't checked);
// - no links, HTML or markdown;
// - another catalog package named in the sentence must be named in its quotes too. A package
//   named like a common word (watch, tree, less) can drop a good sentence: measure before tuning;
// - length limits, per sentence and for the whole summary.
// Tags must be short lowercase labels; the category must be one of the catalog's.
//
// The result keeps counts per part as the model produced them, so the quality gate (C8:
// unsupported sentences < 1%) is measured on the model's output, not on what survived.

/** A text the model read: a homepage's visible text or a README's (extract.ts), as stored. */
export interface Source {
  id: string;
  kind: 'homepage' | 'readme';
  url: string;
  text: string;
}

export interface Citation {
  /** The cited source's id. */
  source: string;
  quote: string;
  /** Character offsets into the source's text, when the model gives them. */
  start?: number;
  end?: number;
}

export interface Sentence {
  text: string;
  citations: Citation[];
}

export interface Draft {
  summary: Sentence[];
  bullets: Sentence[];
  tags: string[];
  category: string | null;
}

export interface CheckContext {
  /** The package's own names (name, token, aliases): naming them needs no citation. */
  ownNames: string[];
  /** Every other catalog package's name, as the catalog writes it. */
  otherNames: Iterable<string>;
  /** The categories a package may be given. */
  categories: Iterable<string>;
}

export const LIMITS = {
  quoteMinWords: 3,
  sentenceMaxWords: 40,
  sentenceMaxChars: 300,
  summaryMaxWords: 120,
  bulletMaxWords: 20,
  bulletMaxChars: 140,
  bullets: 5,
  tags: { min: 10, max: 15, maxChars: 30, maxWords: 3 },
  /** Shorter names than this are never matched as another product. */
  nameMinChars: 4,
};

export type Part = 'summary' | 'bullets' | 'tags' | 'category';

export interface Dropped {
  part: Part;
  text: string;
  reason: string;
}

export interface CheckResult {
  kept: Draft;
  dropped: Dropped[];
  /** Per part, what the model produced and what was kept. */
  counts: Record<Part, { produced: number; kept: number }>;
  /** Problems with the draft as a whole, such as too few tags left. */
  problems: string[];
}

/** Curly quotes and dashes read as straight ones; one character for one, so offsets still hold. */
const fold = (text: string) =>
  text
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, '-');
const collapse = (text: string) => text.replace(/\s+/g, ' ').trim();
const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

const LINK =
  /https?:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|app|sh|ai|co|me|so|xyz|gg|edu|gov|info|us|uk|de|fr|eu)\b/i;
const HTML = /<\/?[a-z][^>]*>|&(?:[a-z]+|#\d+|#x[0-9a-f]+);/i;
const MARKDOWN = /`|\*\*|__|\]\(|!\[|^\s*(?:#{1,6}\s|[-*+]\s|>\s|\d+\.\s)/;

/** Why the text breaks the format rules, or null. */
export function formatProblem(text: string): string | null {
  if (LINK.test(text)) return 'link';
  if (HTML.test(text)) return 'HTML';
  if (MARKDOWN.test(text)) return 'markdown';
  return null;
}

/** Numbers written in digits: `1,000` is 1000, and `1.2.3` or `10` stay whole. */
export function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d(?:[\d,.]*\d)?/g)].map((m) => m[0].replace(/,(?=\d{3}\b)/g, ''));
}

const hasNumber = (text: string, n: string) =>
  new RegExp(`(?<![\\d.])${n.replace(/\./g, '\\.')}(?![\\d]|[.,]\\d)`).test(
    text.replace(/(\d),(?=\d{3}\b)/g, '$1'),
  );

/** Why a citation doesn't hold, or null. */
export function citationProblem(citation: Citation, sources: Map<string, Source>): string | null {
  const source = sources.get(citation.source);
  if (!source) return 'unknown source';
  const quote = fold(collapse(citation.quote));
  if (words(quote) < LIMITS.quoteMinWords) return 'quote too short';
  const text = fold(source.text);
  if (citation.start !== undefined || citation.end !== undefined) {
    const { start, end } = citation;
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start! < 0 ||
      end! > text.length ||
      fold(collapse(text.slice(start, end))) !== quote
    )
      return 'offsets disagree with the quote';
    return null;
  }
  return text.includes(quote) ? null : 'quote not in source';
}

/** Word sequences of up to `n` words, as written. */
function phrases(text: string, n = 4): string[] {
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#@.-]*/gu)].map((m) =>
    m[0].replace(/[.-]+$/, ''),
  );
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i++)
    for (let j = i + 1; j <= Math.min(tokens.length, i + n); j++)
      out.push(tokens.slice(i, j).join(' '));
  return out;
}

const containsWord = (text: string, name: string) =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`,
    'iu',
  ).test(text);

export function checkDraft(draft: Draft, sources: Source[], ctx: CheckContext): CheckResult {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const own = new Set(ctx.ownNames.map((n) => n.toLowerCase()));
  const others = new Set(
    [...ctx.otherNames].filter((n) => n.length >= LIMITS.nameMinChars && !own.has(n.toLowerCase())),
  );
  const dropped: Dropped[] = [];
  const problems: string[] = [];

  const sentenceProblem = (s: Sentence, maxWords: number, maxChars: number): string | null => {
    const text = collapse(s.text);
    if (!text) return 'empty';
    if (!s.citations?.length) return 'no citation';
    for (const c of s.citations) {
      const problem = citationProblem(c, byId);
      if (problem) return problem;
    }
    const format = formatProblem(text);
    if (format) return format;
    if (words(text) > maxWords || text.length > maxChars) return 'too long';
    const quoted = fold(s.citations.map((c) => collapse(c.quote)).join(' '));
    const missing = numbersIn(text).find((n) => !hasNumber(quoted, n));
    if (missing) return `number ${missing} not in its quotes`;
    const named = phrases(text).find((p) => others.has(p) && !containsWord(quoted, p));
    if (named) return `names ${named} without a quote that does`;
    return null;
  };

  const keepSentences = (
    part: 'summary' | 'bullets',
    list: Sentence[],
    maxWords: number,
    maxChars: number,
  ): Sentence[] => {
    const kept: Sentence[] = [];
    let total = 0;
    for (const s of list) {
      let reason = sentenceProblem(s, maxWords, maxChars);
      if (!reason && part === 'summary' && total + words(s.text) > LIMITS.summaryMaxWords)
        reason = 'summary too long';
      if (!reason && part === 'bullets' && kept.length >= LIMITS.bullets)
        reason = 'too many bullets';
      if (reason) dropped.push({ part, text: s.text, reason });
      else {
        kept.push({ ...s, text: collapse(s.text) });
        total += words(s.text);
      }
    }
    return kept;
  };

  const summary = keepSentences(
    'summary',
    draft.summary,
    LIMITS.sentenceMaxWords,
    LIMITS.sentenceMaxChars,
  );
  const bullets = keepSentences(
    'bullets',
    draft.bullets,
    LIMITS.bulletMaxWords,
    LIMITS.bulletMaxChars,
  );

  const tags: string[] = [];
  for (const raw of draft.tags) {
    const tag = collapse(raw);
    const reason = !tag
      ? 'empty'
      : tag !== tag.toLowerCase()
        ? 'not lowercase'
        : tag.length > LIMITS.tags.maxChars || words(tag) > LIMITS.tags.maxWords
          ? 'too long'
          : (formatProblem(tag) ??
            (tags.includes(tag) ? 'duplicate' : null) ??
            (tags.length >= LIMITS.tags.max ? 'too many tags' : null));
    if (reason) dropped.push({ part: 'tags', text: raw, reason });
    else tags.push(tag);
  }
  if (tags.length < LIMITS.tags.min) problems.push(`only ${tags.length} tags`);

  const categories = new Set(ctx.categories);
  let category = draft.category;
  if (category !== null && !categories.has(category)) {
    dropped.push({ part: 'category', text: category, reason: 'not a catalog category' });
    category = null;
  }
  if (!summary.length) problems.push('no summary left');

  return {
    kept: { summary, bullets, tags, category },
    dropped,
    counts: {
      summary: { produced: draft.summary.length, kept: summary.length },
      bullets: { produced: draft.bullets.length, kept: bullets.length },
      tags: { produced: draft.tags.length, kept: tags.length },
      category: { produced: draft.category === null ? 0 : 1, kept: category === null ? 0 : 1 },
    },
    problems,
  };
}
