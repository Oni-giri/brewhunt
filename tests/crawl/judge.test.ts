import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it, vi } from 'vitest';
import { MAX_TOKENS } from '../../scripts/crawl/cost.ts';
import type { IconResult } from '../../scripts/crawl/dry-run.ts';
import {
  JudgeError,
  JudgeRequestError,
  askJudge,
  judgeParts,
  judgeTextTokens,
  readJudge,
  showable,
  type JudgePart,
} from '../../scripts/crawl/judge.ts';

const dir = mkdtempSync(join(tmpdir(), 'judge-'));
const logo = await sharp({
  create: { width: 64, height: 64, channels: 3, background: '#2a9d4b' },
})
  .png()
  .toBuffer();
writeFileSync(join(dir, 'logo.png'), logo);
writeFileSync(join(dir, 'icon.ico'), logo);

const icon = (over: Partial<IconResult> = {}): IconResult => ({
  source: 'apple-touch-icon',
  url: 'https://tool.test/logo.png',
  declared: null,
  status: 'ok',
  format: 'png',
  width: 64,
  height: 64,
  file: 'logo.png',
  ...over,
});

/** The white pixels in the band above the image, by column: where the digits are drawn. */
async function bandColumns(png: Buffer): Promise<number[]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const columns: number[] = [];
  for (let x = 0; x < info.width; x++)
    for (let y = 0; y < 32; y++)
      if (data[(y * info.width + x) * info.channels] > 200) {
        columns.push(x);
        break;
      }
  return columns;
}

describe('showable', () => {
  it('shows the candidate on grey, with its number drawn in a band above when given', async () => {
    const plain = (await showable(dir, icon()))!;
    expect(await sharp(plain).metadata()).toMatchObject({ width: 128, height: 128 });
    const numbered = (await showable(dir, icon(), 7))!;
    expect(await sharp(numbered).metadata()).toMatchObject({ width: 128, height: 160 });
    // One digit, centred; two digits are wider.
    const one = await bandColumns(numbered);
    expect(one.length).toBeGreaterThan(5);
    expect(Math.abs((one[0] + one.at(-1)!) / 2 - 64)).toBeLessThanOrEqual(2);
    const two = await bandColumns((await showable(dir, icon(), 12))!);
    expect(two.at(-1)! - two[0]).toBeGreaterThan(one.at(-1)! - one[0]);
    // The image itself is unchanged under the band.
    const below = await sharp(numbered).extract({ left: 0, top: 32, width: 128, height: 128 });
    const [a, b] = await Promise.all([below.raw().toBuffer(), sharp(plain).raw().toBuffer()]);
    expect(a.equals(b)).toBe(true);
  });

  it('can’t show an ICO or a missing file', async () => {
    expect(await showable(dir, icon({ format: 'ico', file: 'icon.ico' }), 1)).toBeNull();
    expect(await showable(dir, icon({ file: undefined }), 1)).toBeNull();
  });
});

describe('judgeParts', () => {
  it('numbers only the candidates it can show, label and image alike', async () => {
    const { parts, choices } = await judgeParts(dir, '{}', [
      icon({ format: 'ico', file: 'icon.ico', url: 'https://tool.test/favicon.ico' }),
      icon(),
    ]);
    expect(choices.map((c) => c.url)).toEqual(['https://tool.test/logo.png']);
    expect(parts.map((p) => p.type)).toEqual(['text', 'text', 'image_url']);
    expect((parts[1] as { text: string }).text).toMatch(/^Candidate 1: /);
    expect(judgeTextTokens('sys', parts)).toBe(
      3 +
        Buffer.byteLength((parts[0] as { text: string }).text) +
        Buffer.byteLength((parts[1] as { text: string }).text),
    );
  });
});

describe('readJudge', () => {
  const reply = (fields: Record<string, unknown>) => `Thinking done.\n${JSON.stringify(fields)}`;

  it('reads a choice among the candidates, as a number or a string', () => {
    expect(
      readJudge(reply({ choice: 2, kind: 'own', confidence: 'high', reason: 'Its logo.' }), 3),
    ).toEqual({
      index: 1,
      kind: 'own',
      confidence: 'high',
      reason: 'Its logo.',
    });
    expect(readJudge(reply({ choice: '3' }), 3)).toMatchObject({
      index: 2,
      kind: null,
      confidence: 'low',
    });
    expect(readJudge(reply({ choice: 'none', confidence: 'medium' }), 3).index).toBeNull();
  });

  it('refuses anything else', () => {
    expect(() => readJudge(reply({ choice: 4 }), 3)).toThrow(JudgeError);
    expect(() => readJudge(reply({ choice: 0 }), 3)).toThrow(/not a choice/);
    expect(() => readJudge(reply({ choice: '' }), 3)).toThrow(/not a choice/);
    expect(() => readJudge(reply({ choice: [1] }), 3)).toThrow(/not a choice/);
    expect(() => readJudge('', 3)).toThrow(/no JSON/);
    expect(() => readJudge('{choice: 1}', 3)).toThrow(/not JSON/);
  });
});

describe('askJudge', () => {
  const parts: JudgePart[] = [
    { type: 'text', text: 'Package details' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
  ];
  const answered = (usage?: object) =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"choice": 1}' } }],
        ...(usage ? { usage } : {}),
      }),
      { status: 200 },
    );

  async function run(responses: Response[]) {
    const calls: RequestInit[] = [];
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push(init);
      return responses.shift()!;
    });
    vi.useFakeTimers();
    try {
      const result = askJudge('key', 'sys', parts);
      result.catch(() => {});
      await vi.runAllTimersAsync();
      return { result: await result, calls };
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  }

  it('tries a rate limit again, and reads the usage', async () => {
    const { result, calls } = await run([
      new Response('slow down', { status: 429 }),
      answered({ prompt_tokens: 120, completion_tokens: 900 }),
    ]);
    expect(calls).toHaveLength(2);
    expect(JSON.parse(calls[0].body as string)).toMatchObject({
      model: 'glm-5.3-flash',
      max_tokens: MAX_TOKENS.icon,
      reasoning_effort: 'max',
    });
    expect(result).toEqual({
      text: '{"choice": 1}',
      usage: { input_tokens: 120, output_tokens: 900 },
      usageReported: true,
    });
  });

  const worst = () => ({
    input_tokens: judgeTextTokens('sys', parts) + 256,
    output_tokens: MAX_TOKENS.icon,
  });

  it('tries a server error twice more, charging each failed try at its worst', async () => {
    const { result, calls } = await run([
      new Response('oops', { status: 500 }),
      answered({ prompt_tokens: 120, completion_tokens: 900 }),
    ]);
    expect(calls).toHaveLength(2);
    expect(result.usage).toEqual({
      input_tokens: worst().input_tokens + 120,
      output_tokens: worst().output_tokens + 900,
    });
    const error = await run(
      [500, 502, 503, 500].map((status) => new Response('', { status })),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JudgeRequestError);
    expect((error as JudgeRequestError).message).toMatch(/HTTP 503/);
    expect((error as JudgeRequestError).charged).toEqual({
      input_tokens: 3 * worst().input_tokens,
      output_tokens: 3 * worst().output_tokens,
    });
  });

  it('asks once more after an empty answer, charging both', async () => {
    const empty = (usage: object) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '' } }], usage }), {
        status: 200,
      });
    const { result, calls } = await run([
      empty({ prompt_tokens: 100, completion_tokens: 4000 }),
      answered({ prompt_tokens: 100, completion_tokens: 50 }),
    ]);
    expect(calls).toHaveLength(2);
    expect(result).toMatchObject({
      text: '{"choice": 1}',
      usage: { input_tokens: 200, output_tokens: 4050 },
    });
    const twice = await run([
      empty({ prompt_tokens: 100, completion_tokens: 4000 }),
      empty({ prompt_tokens: 100, completion_tokens: 4000 }),
      answered(),
    ]);
    expect(twice.calls).toHaveLength(2);
    expect(twice.result.text).toBe('');
  });

  it('charges a refused request at its worst, without trying again', async () => {
    const error = await run([new Response('bad', { status: 400 }), answered()]).catch(
      (e: unknown) => e,
    );
    expect((error as JudgeRequestError).charged).toEqual(worst());
  });

  it('charges a reply without usage as its worst case', async () => {
    const { result } = await run([answered()]);
    expect(result.usageReported).toBe(false);
    expect(result.usage).toEqual(worst());
  });
});
