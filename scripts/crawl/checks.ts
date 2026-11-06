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
// - no first person ("we", "our"): Brewhunt writes the summary, so the developer's own voice would
//   read as Brewhunt's ("Our software is tested daily");
// - another catalog package named in the sentence must be named in its quotes too: as the catalog
//   writes it, or capitalised mid-sentence (formula names are lowercase: "faster than Ripgrep").
//   A name that is also a common word can still drop a good sentence: measure before tuning;
// - length limits, per sentence and for the whole summary.
// Tags must be short lowercase labels; the category must be one of the catalog's.
//
// The result keeps counts per part as the model produced them, so the quality gate (C8:
// unsupported sentences < 1%) is measured on the model's output, not on what survived. The
// model's reply goes through parseDraft first: a reply that isn't a draft is a failed package.

import { z } from 'zod';

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

const SentenceSchema = z.object({
  text: z.string(),
  citations: z.array(
    z.object({
      source: z.string(),
      quote: z.string(),
      start: z.number().int().optional(),
      end: z.number().int().optional(),
    }),
  ),
});
const DraftSchema = z.object({
  summary: z.array(SentenceSchema).max(50),
  bullets: z.array(SentenceSchema).max(50).default([]),
  tags: z.array(z.string()).max(100).default([]),
  category: z.string().nullable().default(null),
});

/** The model's reply as a draft, or null when it isn't one (extra fields are dropped). */
export function parseDraft(reply: unknown): Draft | null {
  const parsed = DraftSchema.safeParse(reply);
  return parsed.success ? parsed.data : null;
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

/** "We", "our", "us": lowercase "us" only, so the US stays. */
const FIRST_PERSON = /\b(?:[Ww]e|[Oo]urs?|us)\b/;

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

/** Word sequences of up to `n` words, as written, and whether each starts the sentence. */
function phrases(text: string, n = 4): { text: string; first: boolean }[] {
  const tokens = [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}+#@.-]*/gu)].map((m) =>
    m[0].replace(/[.-]+$/, ''),
  );
  const out: { text: string; first: boolean }[] = [];
  for (let i = 0; i < tokens.length; i++)
    for (let j = i + 1; j <= Math.min(tokens.length, i + n); j++)
      out.push({ text: tokens.slice(i, j).join(' '), first: i === 0 });
  return out;
}

/**
 * Another package's name in the sentence: as the catalog writes it, or, since formula names are
 * lowercase and a sentence capitalises them (ripgrep → "Ripgrep"), capitalised mid-sentence. A
 * lowercase common word ("watch files") or a sentence's first word isn't a name.
 */
function namedProducts(text: string, exact: Set<string>, lower: Set<string>): string[] {
  const names = new Set<string>();
  for (const p of phrases(text)) {
    if (exact.has(p.text)) names.add(p.text);
    else if (!p.first && /^\p{Lu}/u.test(p.text) && lower.has(p.text.toLowerCase()))
      names.add(p.text);
  }
  return [...names];
}

/** Decimal digits other than 0–9 (Arabic-Indic, Devanagari…), which the number check can't read. */
const OTHER_DIGITS = /(?![0-9])\p{Nd}/u;

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
  const othersLower = new Set([...others].map((n) => n.toLowerCase()));
  const dropped: Dropped[] = [];
  const problems: string[] = [];

  const sentenceProblem = (s: Sentence, maxWords: number, maxChars: number): string | null => {
    // Checked in compatibility form, so full-width letters and digits (ｗｗｗ, ９９) can't slip
    // past the patterns. The sentence is kept as written.
    const text = collapse(s.text).normalize('NFKC');
    if (!text) return 'empty';
    if (!s.citations?.length) return 'no citation';
    for (const c of s.citations) {
      const problem = citationProblem(c, byId);
      if (problem) return problem;
    }
    const format = formatProblem(text);
    if (format) return format;
    if (FIRST_PERSON.test(text)) return 'first person';
    if (words(text) > maxWords || text.length > maxChars) return 'too long';
    const quoted = fold(s.citations.map((c) => collapse(c.quote)).join(' ')).normalize('NFKC');
    if (OTHER_DIGITS.test(text)) return 'digits other than 0–9';
    const missing = numbersIn(text).find((n) => !hasNumber(quoted, n));
    if (missing) return `number ${missing} not in its quotes`;
    const named = namedProducts(text, others, othersLower).find((n) => !containsWord(quoted, n));
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
