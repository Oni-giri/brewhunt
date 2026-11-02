import { describe, expect, it } from 'vitest';
import type { IconResult } from '../../scripts/crawl/dry-run.ts';
import { chooseIcon, rankIcons } from '../../scripts/crawl/rank.ts';
import { bucket } from '../../scripts/crawl/score.ts';

const icon = (over: Partial<IconResult>): IconResult => ({
  source: 'apple-touch-icon',
  url: `https://tool.test/${over.source ?? 'icon'}-${over.width ?? 'svg'}`,
  declared: null,
  status: 'ok',
  format: 'png',
  width: 180,
  height: 180,
  ...over,
});

describe('rankIcons', () => {
  it('orders by source, then SVG, then the larger file, and drops rejected ones', () => {
    const ranked = rankIcons([
      icon({ source: 'simple-icons', format: 'svg', width: null, height: null }),
      icon({ source: 'apple-touch-icon', width: 152, height: 152 }),
      icon({ source: 'manifest', width: 192, height: 192 }),
      icon({ source: 'manifest', width: 512, height: 512 }),
      icon({ source: 'devicon', status: 'rejected' }),
    ]);
    expect(ranked.map((i) => `${i.source} ${i.width}`)).toEqual([
      'manifest 512',
      'manifest 192',
      'apple-touch-icon 152',
      'simple-icons null',
    ]);
  });
});

describe('chooseIcon', () => {
  it('never picks the maker’s logo or an unmarked page or README image on its own', () => {
    expect(
      chooseIcon([
        icon({ source: 'org-avatar' }),
        icon({ source: 'maker-site' }),
        icon({ source: 'readme-logo', marked: false }),
        icon({ source: 'page-svg', format: 'svg', marked: false }),
      ]),
    ).toEqual({ icon: null, source: 'none' });
  });

  it('picks a marked logo', () => {
    const logo = icon({ source: 'page-logo', marked: true });
    expect(chooseIcon([icon({ source: 'org-avatar' }), logo])).toEqual({
      icon: logo.url,
      source: 'page-logo',
    });
  });
});

describe('bucket', () => {
  const owner = {
    id: 'x',
    icon: 'https://a.test/logo.svg',
    source: 'svg-icon',
    hash: '00ff00ff00ff00ff',
    seen: ['00ff00ff00ff00ff', '0f0f0f0f0f0f0f0f'],
  };
  const other = 'https://b.test/l.png';
  it('sorts a pick against the owner’s answer', () => {
    expect(bucket(owner, { icon: owner.icon })).toBe('exact');
    expect(bucket(owner, { icon: other, hash: '00ff00ff00ff00f0' })).toBe('same file');
    expect(bucket(owner, { icon: other, hash: '0f0f0f0f0f0f0f0f' })).toBe('passed over');
    expect(bucket(owner, { icon: other, hash: 'ff00ff00ff00ff00' })).toBe('never shown');
    expect(bucket(owner, { icon: null })).toBe('missed');
    expect(
      bucket(
        { ...owner, accepted: ['ff00ff00ff00ff00'] },
        { icon: other, hash: 'ff00ff00ff00ff00' },
      ),
    ).toBe('also fine');
    expect(
      bucket(
        { ...owner, rejected: ['0f0f0f0f0f0f0f0f'] },
        { icon: other, hash: '0f0f0f0f0f0f0f0f' },
      ),
    ).toBe('wrong');
  });

  it('counts an icon where the owner chose the tile as wrong only if the owner saw it', () => {
    const tile = { id: 'y', icon: null, source: 'none', seen: ['0f0f0f0f0f0f0f0f'] };
    expect(bucket(tile, { icon: null })).toBe('tile');
    expect(bucket(tile, { icon: other, hash: '0f0f0f0f0f0f0f0f' })).toBe('wrong');
    expect(bucket(tile, { icon: other, hash: 'ff00ff00ff00ff00' })).toBe('unreviewed icon');
    expect(bucket({ id: 'z', icon: null, source: 'findable' }, { icon: null })).toBeNull();
  });
});
