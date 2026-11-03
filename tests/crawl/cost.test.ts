import { describe, expect, it } from 'vitest';
import {
  actualCost,
  BudgetError,
  CostGuard,
  estimateTokens,
  ICON_CANDIDATES,
  IMAGE_MAX_TOKENS,
  packageRequests,
  worstCase,
  type RequestCost,
} from '../../scripts/crawl/cost.ts';

const haiku = (inputTokens: number, maxTokens = 8000, images = 0): RequestCost => ({
  model: 'claude-haiku-5-5',
  inputTokens,
  images,
  maxTokens,
});

describe('worstCase', () => {
  it('charges every input token, every image at its largest and all of max_tokens, at half price', () => {
    // (10,000 × $0.10 + 8,000 × $0.50) / 1M, halved.
    expect(worstCase(haiku(10_000))).toBeCloseTo(0.0025, 10);
    expect(worstCase(haiku(10_000), false)).toBeCloseTo(0.005, 10);
    expect(worstCase(haiku(0, 0, 2))).toBeCloseTo((2 * IMAGE_MAX_TOKENS * 0.1) / 1e6 / 2, 12);
    expect(
      worstCase({ model: 'claude-sonnet-5-5', inputTokens: 1000, images: 0, maxTokens: 1000 }),
    ).toBeCloseTo(0.006, 10);
  });

  it('uses Haiku’s long-prompt prices past 100,000 tokens', () => {
    expect(worstCase(haiku(100_001, 0))).toBeCloseTo((100_001 * 0.5) / 1e6 / 2, 10);
    // Images count toward the prompt's length.
    expect(worstCase(haiku(99_000, 1000, 1))).toBeCloseTo(
      ((99_000 + IMAGE_MAX_TOKENS) * 0.5 + 1000 * 2.5) / 1e6 / 2,
      10,
    );
  });
});

describe('actualCost', () => {
  it('prices cache writes and reads from the input price', () => {
    expect(
      actualCost('claude-sonnet-5-5', {
        input_tokens: 1000,
        output_tokens: 100,
        cache_creation_input_tokens: 1000,
        cache_read_input_tokens: 1000,
      }),
    ).toBeCloseTo(((1000 * 2 + 1000 * 2.5 + 1000 * 0.2 + 100 * 10) / 1e6) * 0.5, 10);
  });
});

describe('estimateTokens', () => {
  it('estimates high: a token per two bytes', () => {
    expect(estimateTokens('abcd')).toBe(2);
    expect(estimateTokens('é')).toBe(1);
  });
});

describe('CostGuard', () => {
  it('plans batches that fit what’s left, one out at a time, and stops when none fits', () => {
    const guard = new CostGuard(0.01);
    // $0.0025 each at worst: four fit in $0.01.
    const queue = Array.from({ length: 10 }, () => haiku(10_000));
    const first = guard.plan(queue, 3);
    expect(first).toHaveLength(3);
    guard.reserve('b1', first);
    expect(guard.remaining).toBeCloseTo(0.0025, 10);
    expect(() => guard.plan(queue, 3)).toThrow(BudgetError);
    expect(() => guard.reserve('b2', first)).toThrow(BudgetError);

    // Real use is far below the worst case.
    const { cost, overReserved } = guard.reconcile(
      'b1',
      first.map(() => ({
        model: 'claude-haiku-5-5' as const,
        usage: { input_tokens: 9000, output_tokens: 1000 },
      })),
    );
    expect(cost).toBeCloseTo((3 * (9000 * 0.1 + 1000 * 0.5)) / 1e6 / 2, 10);
    expect(overReserved).toBe(false);
    expect(guard.plan(queue, 10)).toHaveLength(3);

    const broke = new CostGuard(0.001);
    expect(broke.plan(queue, 10)).toEqual([]);
    expect(() => broke.reserve('b', [haiku(10_000)])).toThrow(/more than the \$0.0010 left/);
  });

  it('reconciles only the batch that’s out, and says when the worst case was beaten', () => {
    const guard = new CostGuard();
    expect(() => guard.reconcile('nope', [])).toThrow(BudgetError);
    guard.reserve('b1', [haiku(10, 10)]);
    expect(
      guard.reconcile('b1', [
        { model: 'claude-haiku-5-5', usage: { input_tokens: 10_000, output_tokens: 0 } },
      ]).overReserved,
    ).toBe(true);
    expect(() => new CostGuard(0)).toThrow(BudgetError);
  });
});

describe('packageRequests', () => {
  it('asks Sonnet to check only a package that has sources, and caps the icon candidates', () => {
    const full = packageRequests({
      sourceText: 'x'.repeat(4000),
      iconCandidates: 20,
      screenshots: 3,
    });
    expect(full.map((r) => [r.model, r.images])).toEqual([
      ['claude-haiku-5-5', 0],
      ['claude-haiku-5-5', 0],
      ['claude-haiku-5-5', ICON_CANDIDATES],
      ['claude-haiku-5-5', 3],
      ['claude-sonnet-5-5', 0],
    ]);
    expect(packageRequests({ sourceText: '', iconCandidates: 2, screenshots: 0 })).toHaveLength(1);
  });
});
