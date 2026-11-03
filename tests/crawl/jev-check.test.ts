import { describe, expect, it, vi } from 'vitest';
import {
  checkRequest,
  checkSentences,
  readAnswers,
  THRESHOLD,
} from '../../scripts/crawl/jev-check.ts';

const sentences = [
  {
    text: 'Tool finds files.',
    citations: [{ source: 'readme', quote: 'Tool is a fast file finder' }],
  },
  {
    text: 'Tool is the fastest.',
    citations: [{ source: 'readme', quote: 'Tool is a fast file finder' }],
  },
];

describe('checkRequest', () => {
  it('puts the sentences and quotes in the state, with one yes/no question each', () => {
    const body = checkRequest('Tool', sentences);
    expect(body.state.sentences).toEqual([
      { id: 's1', sentence: 'Tool finds files.', quotes: ['Tool is a fast file finder'] },
      { id: 's2', sentence: 'Tool is the fastest.', quotes: ['Tool is a fast file finder'] },
    ]);
    expect(Object.keys(body.questions)).toEqual(['s1', 's2']);
    expect(body.questions.s2).toMatchObject({ type: 'noul' });
  });
});

describe('readAnswers', () => {
  it('keeps a sentence at or above the threshold, and refuses a malformed reply', () => {
    const checked = readAnswers(sentences, {
      answers: { s1: { noul: THRESHOLD }, s2: { noul: 0.02 } },
    });
    expect(checked.map((c) => c.keep)).toEqual([true, false]);
    expect(() => readAnswers(sentences, { answers: { s1: { noul: 0.9 } } })).toThrow(/s2/);
    expect(() =>
      readAnswers(sentences, { answers: { s1: { noul: 1.5 }, s2: { noul: 0 } } }),
    ).toThrow(/s1/);
  });
});

describe('checkSentences', () => {
  const answered = (usage?: unknown) =>
    new Response(
      JSON.stringify({
        answers: { s1: { noul: 0.9 }, s2: { noul: 0.1 } },
        ...(usage ? { usage } : {}),
      }),
      { status: 200 },
    );

  async function run(responses: Response[]) {
    const calls: unknown[] = [];
    vi.stubGlobal('fetch', async (...args: unknown[]) => {
      calls.push(args);
      return responses.shift()!;
    });
    vi.useFakeTimers();
    try {
      const result = checkSentences('key', 'tool', sentences);
      result.catch(() => {});
      await vi.runAllTimersAsync();
      return { result: await result, calls: calls.length };
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }

  it('tries a rate limit again, and reads the usage', async () => {
    const { result, calls } = await run([
      new Response('slow down', { status: 429 }),
      answered({ input_tokens: 1234 }),
    ]);
    expect(calls).toBe(2);
    expect(result.checked.map((c) => c.keep)).toEqual([true, false]);
    expect(result).toMatchObject({ inputTokens: 1234, usageReported: true });
  });

  it('doesn’t try a server error again: it may have been charged', async () => {
    await expect(run([new Response('oops', { status: 503 }), answered()])).rejects.toThrow(
      /HTTP 503/,
    );
  });

  it('charges a reply without usage as the request’s size', async () => {
    const { result } = await run([answered()]);
    expect(result.usageReported).toBe(false);
    expect(result.inputTokens).toBe(
      Buffer.byteLength(JSON.stringify(checkRequest('tool', sentences))),
    );
  });
});
