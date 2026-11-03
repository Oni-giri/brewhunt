import { describe, expect, it } from 'vitest';
import { checkRequest, readAnswers, THRESHOLD } from '../../scripts/crawl/jev-check.ts';

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
