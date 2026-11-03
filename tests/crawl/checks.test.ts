import { describe, expect, it } from 'vitest';
import {
  checkDraft,
  formatProblem,
  numbersIn,
  parseDraft,
  type Draft,
  type Sentence,
  type Source,
} from '../../scripts/crawl/checks.ts';
import { readmeText } from '../../scripts/crawl/extract.ts';

const readme: Source = {
  id: 'readme',
  kind: 'readme',
  url: 'https://github.com/tool/tool',
  text: 'Tool is a fast file finder for the terminal. It searches 1,000 files in 20 ms and respects “gitignore” rules. Unlike Ripgrep, it also indexes archives. Version 2.1.0 adds Windows support.',
};
const ctx = {
  ownNames: ['tool', 'Tool'],
  // As the catalog writes them: formulae lowercase, casks by display name.
  otherNames: ['ripgrep', 'watch', 'Docker Desktop', 'fd', 'tool'],
  categories: ['Developer Tools', 'Utilities'],
};
const tags = [
  'search',
  'files',
  'finder',
  'terminal',
  'cli',
  'fast',
  'gitignore',
  'archives',
  'grep',
  'index',
];
const cite = (quote: string, extra: Partial<Sentence['citations'][0]> = {}) => ({
  source: 'readme',
  quote,
  ...extra,
});
const draft = (summary: Sentence[], over: Partial<Draft> = {}): Draft => ({
  summary,
  bullets: [],
  tags,
  category: 'Developer Tools',
  ...over,
});
const reasons = (d: Draft) => checkDraft(d, [readme], ctx).dropped.map((x) => x.reason);

describe('checkDraft', () => {
  it('keeps a sentence whose quote is in the source, whatever the whitespace and quote marks', () => {
    const result = checkDraft(
      draft([
        {
          text: 'Tool finds files from the terminal.',
          citations: [cite('Tool is a fast   file finder for the terminal.')],
        },
        { text: 'It respects gitignore rules.', citations: [cite('respects "gitignore" rules')] },
      ]),
      [readme],
      ctx,
    );
    expect(result.dropped).toEqual([]);
    expect(result.counts.summary).toEqual({ produced: 2, kept: 2 });
    expect(result.problems).toEqual([]);
  });

  it('drops sentences without a citation, with an unknown source, a short or a made-up quote', () => {
    expect(
      reasons(
        draft([
          { text: 'Tool is fast.', citations: [] },
          {
            text: 'Tool is fast.',
            citations: [{ source: 'homepage', quote: 'Tool is a fast file finder' }],
          },
          { text: 'Tool is fast.', citations: [cite('is a')] },
          { text: 'Tool is the fastest finder.', citations: [cite('Tool is the fastest finder')] },
        ]),
      ),
    ).toEqual(['no citation', 'unknown source', 'quote too short', 'quote not in source']);
  });

  it('checks offsets against the quote when the model gives them', () => {
    const quote = 'a fast file finder';
    const start = readme.text.indexOf(quote);
    const ok = {
      text: 'Tool is a fast finder.',
      citations: [cite(quote, { start, end: start + quote.length })],
    };
    const off = {
      text: 'Tool is a fast finder.',
      citations: [cite(quote, { start: start + 2, end: start + 20 })],
    };
    expect(reasons(draft([ok, off]))).toEqual(['offsets disagree with the quote']);
  });

  it('needs every number in the sentence to be in its quotes', () => {
    const quote = cite('It searches 1,000 files in 20 ms');
    expect(
      reasons(
        draft([
          { text: 'It searches 1000 files in 20 ms.', citations: [quote] },
          { text: 'It searches 1,000 files in 2 ms.', citations: [quote] },
          {
            text: 'Version 2.1 adds Windows support.',
            citations: [cite('Version 2.1.0 adds Windows support.')],
          },
        ]),
      ),
    ).toEqual(['number 2 not in its quotes', 'number 2.1 not in its quotes']);
  });

  it('drops links, HTML and markdown', () => {
    const c = [cite('Tool is a fast file finder')];
    expect(
      reasons(
        draft([
          { text: 'See tool.dev for more.', citations: c },
          { text: 'Tool is <b>fast</b>.', citations: c },
          { text: 'Tool is **fast**.', citations: c },
          { text: 'Run `tool` to search.', citations: c },
        ]),
      ),
    ).toEqual(['link', 'HTML', 'markdown', 'markdown']);
  });

  it('drops a sentence naming another product its quotes don’t name', () => {
    expect(
      reasons(
        draft([
          {
            text: 'Unlike Ripgrep, it indexes archives.',
            citations: [cite('Unlike Ripgrep, it also indexes archives.')],
          },
          { text: 'It is faster than Ripgrep.', citations: [cite('Tool is a fast file finder')] },
          { text: 'It is faster than ripgrep.', citations: [cite('Tool is a fast file finder')] },
          {
            text: 'It runs beside Docker Desktop.',
            citations: [cite('Tool is a fast file finder')],
          },
        ]),
      ),
    ).toEqual([
      'names Ripgrep without a quote that does',
      'names ripgrep without a quote that does',
      'names Docker Desktop without a quote that does',
    ]);
  });

  it('doesn’t take a sentence’s first word for a package, but does a lowercase name', () => {
    const c = [cite('Tool is a fast file finder')];
    expect(
      reasons(
        draft([
          { text: 'Watch is not needed: Tool is a fast file finder.', citations: c },
          // The known cost: a package named like a common word drops a good sentence.
          { text: 'Tool can watch a fast file finder.', citations: c },
        ]),
      ),
    ).toEqual(['names watch without a quote that does']);
  });

  it('keeps the summary and bullets within their limits', () => {
    const c = [cite('Tool is a fast file finder')];
    const long = { text: `Tool is ${'very '.repeat(40)}fast.`, citations: c };
    const sentence = {
      text: `Tool is a fast file finder ${'and more '.repeat(14)}.`,
      citations: c,
    };
    const result = checkDraft(
      draft([sentence, sentence, sentence, sentence, long], {
        bullets: Array.from({ length: 6 }, () => ({ text: 'Fast file finder.', citations: c })),
      }),
      [readme],
      ctx,
    );
    expect(result.dropped.map((d) => `${d.part}: ${d.reason}`)).toEqual([
      'summary: summary too long',
      'summary: too long',
      'bullets: too many bullets',
    ]);
    expect(result.counts.summary).toEqual({ produced: 5, kept: 3 });
  });

  it('keeps short lowercase tags and catalog categories only', () => {
    const result = checkDraft(
      draft([], {
        tags: [
          ...tags,
          'Search',
          'search',
          'a tag with many words',
          'tool.dev',
          'x1',
          'x2',
          'x3',
          'x4',
          'x5',
          'x6',
        ],
        category: 'Search Tools',
      }),
      [readme],
      ctx,
    );
    expect(result.dropped.map((d) => `${d.part}: ${d.text}: ${d.reason}`)).toEqual([
      'tags: Search: not lowercase',
      'tags: search: duplicate',
      'tags: a tag with many words: too long',
      'tags: tool.dev: link',
      'tags: x6: too many tags',
      'category: Search Tools: not a catalog category',
    ]);
    expect(result.kept.tags).toHaveLength(15);
    expect(result.problems).toEqual(['no summary left']);
  });
});

describe('parseDraft', () => {
  it('takes a reply shaped like a draft, and nothing else', () => {
    expect(
      parseDraft({ summary: [{ text: 'Tool finds files.', citations: [] }], extra: 1 }),
    ).toEqual({
      summary: [{ text: 'Tool finds files.', citations: [] }],
      bullets: [],
      tags: [],
      category: null,
    });
    expect(parseDraft({ summary: 'Tool finds files.' })).toBeNull();
    expect(
      parseDraft({ summary: [{ text: 'x', citations: [{ quote: 'no source' }] }] }),
    ).toBeNull();
    expect(parseDraft(null)).toBeNull();
  });
});

describe('formatProblem and numbersIn', () => {
  it('doesn’t take a dotted name for a link', () => {
    expect(formatProblem('Built on Node.js and ffmpeg.c, v1.2 or later.')).toBeNull();
    expect(formatProblem('Docs are on pandoc.org.')).toBe('link');
    expect(formatProblem('Read https://x.test')).toBe('link');
  });

  it('reads numbers as written', () => {
    expect(numbersIn('From 1,000 to 20,000 files, version 1.2.3, 10% faster.')).toEqual([
      '1000',
      '20000',
      '1.2.3',
      '10',
    ]);
  });
});

describe('readmeText', () => {
  it('keeps the prose and drops badges, code, images, HTML and link targets', () => {
    const markdown = [
      '<p align="center"><img src="logo.png" width="100"></p>',
      '',
      'Tool',
      '====',
      '',
      '[![CI](https://ci.test/badge.svg)](https://ci.test) ![stars](https://img.shields.io/x)',
      '',
      '> [!NOTE]',
      '> A **fast** finder for the [terminal](https://term.test).',
      '',
      '```sh',
      'brew install tool',
      '```',
      '',
      '- Searches `archives` too, see https://tool.test/docs',
      '',
      '| Flag | Meaning |',
      '| --- | --- |',
      '| -a | all &amp; more |',
      '',
      '[ref]: https://tool.test',
    ].join('\n');
    expect(readmeText(markdown)).toBe(
      'Tool A fast finder for the terminal. Searches archives too, see Flag Meaning -a all & more',
    );
  });
});
