// The AI step's cost guard (M5 C10). Before each batch, its worst-case cost: every input token
// (counted, or estimated high), every image at the most tokens an image can take, and every
// request's `max_tokens` spent in full (it caps thinking and text together). Work goes in small
// batches that each fit what's left of the run's cap; the next is submitted only once the last
// one's real usage is reconciled, and when the cap can't cover the next batch the run stops
// before submitting it. Pure: the caller submits, polls and reports usage.
//
// Prices are list prices per million tokens (checked 3 Nov 2026; GLM on Inco 7 Nov 2026).
// Anthropic's Message Batches API charges half of them on every token; TypeSafe's Jev (the
// summary check, jev-check.ts) answers at once and charges for input only, and GLM (the icon
// judge, judge.ts) answers at once: neither has batches. `image` is the most tokens one image
// can take.

export const PRICES = {
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    long: { above: 100_000, input: 0.5, output: 2.5 },
    batches: true,
    // A high-resolution model, 2576px on the long edge.
    image: 4784,
  },
  'jev-latest': { input: 0.042, output: 0, batches: false, image: 0 },
  // The judge's images are its own numbered 128 × 160 candidates, about 32 tokens each (measured
  // 7 Nov 2026: GLM's count grows with the pixels, 5,201 for 2000 × 2000).
  'glm-5.3-flash': { input: 0.15, output: 0.5, batches: false, image: 256 },
} as const;
export type Model = keyof typeof PRICES;

export const BATCH_DISCOUNT = 0.5;
/** Cache writes (5-minute) and reads, as multiples of the input price. */
export const CACHE = { write: 1.25, read: 0.1 };
/** The most tokens one image can take on Haiku. */
export const IMAGE_MAX_TOKENS = PRICES['claude-haiku-5-5'].image;
/** The run's cap in dollars, unless set otherwise. */
export const DEFAULT_CAP = 10;

/** One request as the guard sees it before it's sent. */
export interface RequestCost {
  model: Model;
  /** Text input tokens: counted (count_tokens) or estimateTokens(). */
  inputTokens: number;
  images: number;
  maxTokens: number;
}

/** What a response's `usage` reports. */
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Text tokens, at most: one per byte of UTF-8. Every token covers at least one byte, so no text
 * can beat this, however it's written (crawled text is anyone's; one per two bytes, which English
 * stays well under, isn't a bound for punctuation or rare scripts). English runs about four
 * bytes a token, so it's four times too high there: count_tokens gives the real number before
 * a batch once there's a key.
 */
export const estimateTokens = (text: string) => Buffer.byteLength(text, 'utf8');

function rates(model: Model, promptTokens: number): { input: number; output: number } {
  const price = PRICES[model];
  return 'long' in price && promptTokens > price.long.above ? price.long : price;
}

const discount = (model: Model, batch: boolean) =>
  batch && PRICES[model].batches ? BATCH_DISCOUNT : 1;

/** Dollars for a request at its worst: every image at its largest, all of `max_tokens` used. */
export function worstCase(request: RequestCost, batch = true): number {
  const prompt = request.inputTokens + request.images * PRICES[request.model].image;
  const { input, output } = rates(request.model, prompt);
  return ((prompt * input + request.maxTokens * output) / 1e6) * discount(request.model, batch);
}

/** Dollars a finished request cost, from its usage. */
export function actualCost(model: Model, usage: Usage, batch = true): number {
  const written = usage.cache_creation_input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const { input, output } = rates(model, usage.input_tokens + written + read);
  const inputCost =
    usage.input_tokens * input + written * input * CACHE.write + read * input * CACHE.read;
  return ((inputCost + usage.output_tokens * output) / 1e6) * discount(model, batch);
}

export class BudgetError extends Error {}

/**
 * The run's budget. One batch is out at a time: `reserve` its worst case before submitting,
 * `reconcile` its real usage once it has ended, then plan the next.
 */
export class CostGuard {
  readonly cap: number;
  /** Reconciled spend. */
  spent = 0;
  private pending: { id: string; reserved: number } | null = null;

  constructor(cap = DEFAULT_CAP) {
    if (!(cap > 0)) throw new BudgetError(`the cap must be positive, not ${cap}`);
    this.cap = cap;
  }

  get remaining(): number {
    return this.cap - this.spent - (this.pending?.reserved ?? 0);
  }

  /**
   * The longest run of requests from the start of `queue` whose worst case fits what's left,
   * at most `maxRequests`. Empty when not even the first fits: the run stops there.
   */
  plan<T extends RequestCost>(queue: readonly T[], maxRequests: number): T[] {
    if (this.pending) throw new BudgetError(`batch ${this.pending.id} isn't reconciled yet`);
    const batch: T[] = [];
    let total = 0;
    for (const request of queue.slice(0, maxRequests)) {
      const cost = worstCase(request);
      if (total + cost > this.remaining) break;
      batch.push(request);
      total += cost;
    }
    return batch;
  }

  /** Sets aside a batch's worst case before it's submitted. */
  reserve(id: string, requests: readonly RequestCost[]): number {
    if (this.pending) throw new BudgetError(`batch ${this.pending.id} isn't reconciled yet`);
    const reserved = requests.reduce((sum, r) => sum + worstCase(r), 0);
    if (reserved > this.remaining)
      throw new BudgetError(
        `batch ${id} could cost $${reserved.toFixed(4)}, more than the $${this.remaining.toFixed(4)} left`,
      );
    this.pending = { id, reserved };
    return reserved;
  }

  /**
   * Records what the batch really cost: every result's usage, errored and expired ones
   * included when they report it. Returns the cost; more than was reserved means the worst
   * case was wrong, and the caller should stop.
   */
  reconcile(
    id: string,
    results: readonly { model: Model; usage: Usage }[],
  ): { cost: number; overReserved: boolean } {
    if (this.pending?.id !== id) throw new BudgetError(`batch ${id} isn't the one out`);
    const cost = results.reduce((sum, r) => sum + actualCost(r.model, r.usage), 0);
    const overReserved = cost > this.pending.reserved;
    this.spent += cost;
    this.pending = null;
    return { cost, overReserved };
  }
}

// --- The AI step's requests per package (step 6) ---

/** `max_tokens` per call: room for thinking (Haiku thinks by default) as well as the answer. */
export const MAX_TOKENS = {
  summary: 8000,
  labels: 4000,
  // GLM thinks too: at `max` effort about 1,300 tokens a package on the answer key, sometimes all
  // of them (judge.ts JUDGE_EFFORT).
  icon: 4000,
  screenshots: 2000,
};
/** Instructions and package details per call, allowed for generously. */
export const OVERHEAD_TOKENS = 2000;
/** The icon judge's candidates at most (judge.ts JUDGE_MAX). */
export const ICON_CANDIDATES = 12;

export interface PackageWork {
  /** The text the summary and labels calls read (sources.json). */
  sourceText: string;
  iconCandidates: number;
  screenshots: number;
}

/**
 * Every request the AI step makes for one package: summary, labels and screenshot classifier on
 * Haiku, the icon judge on GLM, then Jev checking the summary, whose input is at most the summary's own
 * output plus the spans it cites (no longer than the summary's `max_tokens`).
 */
export function packageRequests(work: PackageWork): RequestCost[] {
  const sources = estimateTokens(work.sourceText);
  const haiku = (inputTokens: number, images: number, maxTokens: number): RequestCost => ({
    model: 'claude-haiku-5-5',
    inputTokens: OVERHEAD_TOKENS + inputTokens,
    images,
    maxTokens,
  });
  const requests = [];
  if (sources > 0) {
    requests.push(haiku(sources, 0, MAX_TOKENS.summary), haiku(sources, 0, MAX_TOKENS.labels));
  }
  const icons = Math.min(work.iconCandidates, ICON_CANDIDATES);
  if (icons > 0)
    requests.push({
      model: 'glm-5.3-flash' as const,
      // The judge's prompt is longer than the others: its sources and rules.
      inputTokens: 3 * OVERHEAD_TOKENS,
      images: icons,
      maxTokens: MAX_TOKENS.icon,
    });
  if (work.screenshots > 0) requests.push(haiku(0, work.screenshots, MAX_TOKENS.screenshots));
  if (sources > 0) {
    requests.push({
      model: 'jev-latest' as const,
      inputTokens: OVERHEAD_TOKENS + 2 * MAX_TOKENS.summary,
      images: 0,
      maxTokens: 0,
    });
  }
  return requests;
}
