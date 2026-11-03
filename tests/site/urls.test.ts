import { describe, expect, it } from 'vitest';
import { externalUrl } from '../../src/lib/urls.ts';

describe('externalUrl', () => {
  it('keeps web links as given, and drops anything else', () => {
    expect(externalUrl('https://cli.github.com')).toBe('https://cli.github.com');
    expect(externalUrl(' http://www.gnu.org/software/wget/ ')).toBe(
      'http://www.gnu.org/software/wget/',
    );
    for (const bad of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<b>x</b>',
      'https://user:pass@example.com/',
      'https://user@example.com/',
      '//example.com',
      '/relative',
      'ftp://example.com',
      'not a url',
      '',
      null,
    ])
      expect(externalUrl(bad), String(bad)).toBeNull();
  });
});
