import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  ReplyError,
  iconRequest,
  labelsRequest,
  readIcon,
  readLabels,
  readScreenshots,
  readSummary,
  summaryRequest,
  utf16Offsets,
} from '../../scripts/crawl/ai.ts';
import { checkDraft, type Source } from '../../scripts/crawl/checks.ts';

const README = 'wget retrieves files over HTTP. It resumes broken downloads 🚀 when asked to.';
const HOMEPAGE = 'GNU Wget is a free software package for retrieving files.';
const sources: Source[] = [
  { id: 'homepage', kind: 'homepage', url: 'https://www.gnu.org/software/wget/', text: HOMEPAGE },
  { id: 'readme', kind: 'readme', url: 'https://github.com/x/wget', text: README },
];

type Block = Anthropic.Messages.ContentBlock;

const message = (content: Block[], stop: Anthropic.Messages.StopReason = 'end_turn') =>
  ({ content, stop_reason: stop }) as unknown as Anthropic.Messages.Message;

const text = (t: string): Block => ({ type: 'text', text: t, citations: null });
const cited = (t: string, doc: number, start: number, end: number): Block => {
  const data = sources[doc].text;
  return {
    type: 'text',
    text: t,
    citations: [
      {
        type: 'char_location',
        cited_text: [...data].slice(start, end).join(''),
        document_index: doc,
        document_title: null,
        start_char_index: start,
        end_char_index: end,
        file_id: null,
      },
    ],
  };
};

describe('readSummary', () => {
  it('splits the reply into cited lines under their headings', () => {
    const reply = message([
      { type: 'thinking', thinking: '', signature: 'x' } as unknown as Block,
      text('Here it is.\nSUMMARY\n'),
      cited('Wget is free software for retrieving files.', 0, 0, HOMEPAGE.length),
      text('\nFEATURES\n- '),
      cited('Resumes broken downloads.', 1, 32, 57),
      text('\n'),
    ]);
    const { summary, bullets } = readSummary(reply, sources);
    expect(summary).toEqual([
      {
        text: 'Wget is free software for retrieving files.',
        citations: [{ source: 'homepage', quote: HOMEPAGE, start: 0, end: HOMEPAGE.length }],
      },
    ]);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].text).toBe('Resumes broken downloads.');
    expect(bullets[0].citations[0]).toMatchObject({ source: 'readme' });
  });

  it('gives a line every citation of the blocks that wrote it, once', () => {
    const reply = message([
      text('SUMMARY\nWget '),
      cited('retrieves files', 1, 0, 30),
      text(' and '),
      cited('resumes them.', 1, 31, 57),
      cited('', 1, 31, 57),
    ]);
    const [line] = readSummary(reply, sources).summary;
    expect(line.text).toBe('Wget retrieves files and resumes them.');
    expect(line.citations.map((c) => c.start)).toEqual([0, 31]);
  });

  it('splits a line of several sentences, each with its own citations', () => {
    const reply = message([
      text('SUMMARY\n'),
      cited('Wget retrieves files.', 1, 0, 31),
      text(' '),
      cited('It resumes downloads.', 1, 32, 57),
      text('\nFEATURES\n'),
      cited('Fetches files. Over HTTP.', 1, 0, 31),
    ]);
    const { summary, bullets } = readSummary(reply, sources);
    expect(summary.map((s) => [s.text, s.citations.map((c) => c.start)])).toEqual([
      ['Wget retrieves files.', [0]],
      ['It resumes downloads.', [32]],
    ]);
    expect(bullets).toEqual([
      { text: 'Fetches files. Over HTTP.', citations: [expect.objectContaining({ start: 0 })] },
    ]);
  });

  it('keeps uncited lines for the checks to drop, and refuses a reply with no sections', () => {
    const { summary } = readSummary(message([text('SUMMARY\nIt is the best.')]), sources);
    expect(summary).toEqual([{ text: 'It is the best.', citations: [] }]);
    const result = checkDraft({ summary, bullets: [], tags: [], category: null }, sources, {
      ownNames: ['wget'],
      otherNames: [],
      categories: [],
    });
    expect(result.dropped[0].reason).toBe('no citation');
    expect(() => readSummary(message([text('Sure!')]), sources)).toThrow(ReplyError);
  });

  it('refuses a reply that stopped early', () => {
    expect(() => readSummary(message([text('SUMMARY\nA')], 'max_tokens'), sources)).toThrow(
      /max_tokens/,
    );
    expect(() => readSummary(message([], 'refusal'), sources)).toThrow(/refusal/);
  });

  it('passes the checks with offsets counted in code points past an emoji', () => {
    // The rocket is one code point but two UTF-16 units, so the end differs by one.
    const reply = message([
      text('SUMMARY\n'),
      cited('It resumes broken downloads when asked to.', 1, 32, [...README].length),
    ]);
    const { summary } = readSummary(reply, sources);
    expect(summary[0].citations[0].end).toBe(README.length);
    const result = checkDraft({ summary, bullets: [], tags: [], category: null }, sources, {
      ownNames: ['wget'],
      otherNames: [],
      categories: [],
    });
    expect(result.dropped).toEqual([]);
  });

  it('cites nothing for a document that wasn’t sent', () => {
    const reply = message([text('SUMMARY\n'), cited('Retrieves files.', 1, 0, 30)]);
    const fake = { ...(reply.content[1] as Anthropic.Messages.TextBlock) };
    fake.citations = [
      { ...fake.citations![0], document_index: 5 } as Anthropic.Messages.TextCitation,
    ];
    const { summary } = readSummary(message([text('SUMMARY\n'), fake]), sources);
    expect(summary[0].citations[0].source).toBe('');
  });
});

describe('utf16Offsets', () => {
  it('leaves matching offsets and converts code-point ones', () => {
    const s = 'a 🚀 b c d';
    expect(utf16Offsets(s, 0, 1, 'a')).toEqual({ start: 0, end: 1 });
    expect(utf16Offsets(s, 4, 9, 'b c d')).toEqual({ start: 5, end: 10 });
    expect(utf16Offsets(s, 4, 6, 'nope')).toEqual({ start: 4, end: 6 });
  });
});

describe('labels, icon and screenshots', () => {
  it('reads labels and refuses a reply without them', () => {
    expect(readLabels(message([text('{"tags":["download"],"category":null}')]))).toEqual({
      tags: ['download'],
      category: null,
    });
    expect(() => readLabels(message([text('{"category":"x"}')]))).toThrow(/tags/);
    expect(() => readLabels(message([text('no')]))).toThrow(/not JSON/);
  });

  it('reads the icon choice among the candidates only', () => {
    const reply = (choice: string) =>
      message([
        text(JSON.stringify({ choice, kind: 'own', confidence: 'high', reason: 'Its logo.' })),
      ]);
    expect(readIcon(reply('2'), 3)).toEqual({
      index: 1,
      kind: 'own',
      confidence: 'high',
      reason: 'Its logo.',
    });
    expect(readIcon(reply('none'), 3).index).toBeNull();
    expect(() => readIcon(reply('4'), 3)).toThrow(/not a choice/);
  });

  it('reads each image’s kind, unanswered ones as other', () => {
    const reply = message([
      text(
        JSON.stringify({
          images: [
            { image: 1, kind: 'screenshot' },
            { image: 1, kind: 'ad' },
            { image: 3, kind: 'nonsense' },
            { image: 9, kind: 'demo' },
          ],
        }),
      ),
    ]);
    expect(readScreenshots(reply, 3)).toEqual(['screenshot', 'other', 'other']);
  });
});

describe('requests', () => {
  it('sends the summary’s sources as cited documents, in order, with no JSON format', () => {
    const r = summaryRequest('{}', sources);
    const docs = (r.messages[0].content as Anthropic.Messages.ContentBlockParam[]).filter(
      (b) => b.type === 'document',
    );
    expect(docs.map((d) => (d as { source: { data: string } }).source.data)).toEqual([
      HOMEPAGE,
      README,
    ]);
    expect(docs.every((d) => (d as { citations?: unknown }).citations)).toBe(true);
    expect(r.output_config).toBeUndefined();
    expect(r).not.toHaveProperty('temperature');
  });

  it('limits labels to the catalog’s categories and the icon to its candidates', () => {
    const labels = labelsRequest('{}', sources, [
      { slug: 'developer-tools', name: 'Developer tools', description: 'Code.' },
    ]);
    expect(JSON.stringify(labels.output_config)).toContain('"enum":["developer-tools"]');
    const icon = iconRequest('{}', [
      { label: 'Candidate 1', image: Buffer.from('a') },
      { label: 'Candidate 2', image: Buffer.from('b') },
    ]);
    expect(JSON.stringify(icon.output_config)).toContain('"enum":["none","1","2"]');
  });
});
