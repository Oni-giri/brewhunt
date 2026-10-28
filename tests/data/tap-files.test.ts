import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCask, parseFormula } from '../../scripts/data/ruby.ts';
import { listTapFiles, readTapFile, type TapFile } from '../../scripts/data/tap-files.ts';

const formula = (name: string) => `class ${name} < Formula\n  desc "${name}"\nend\n`;

describe('tap files', () => {
  let root: string;
  let tap: string;
  let outside: string;

  /** Writes files under the tap: `{ 'Formula/a.rb': '…' }`. */
  const layout = async (files: Record<string, string>): Promise<void> => {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(tap, path)), { recursive: true });
      await writeFile(join(tap, path), content);
    }
  };
  const paths = async (): Promise<string[]> => (await listTapFiles(tap)).map((file) => file.path);

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'brewhunt-tap-'));
    tap = join(root, 'tap');
    outside = join(root, 'outside');
    await mkdir(tap);
    await mkdir(outside);
    await writeFile(join(outside, 'secret.rb'), 'class Secret < Formula\nend\n');
  });
  afterEach(() => rm(root, { recursive: true, force: true }));

  it('prefers Formula/ over HomebrewFormula/ and the root, and recurses into it', async () => {
    await layout({
      'Formula/a.rb': formula('A'),
      'Formula/w/wget.rb': formula('Wget'),
      'HomebrewFormula/b.rb': formula('B'),
      'root.rb': formula('Root'),
    });
    expect(await listTapFiles(tap)).toEqual([
      { kind: 'formula', token: 'a', path: 'Formula/a.rb' },
      { kind: 'formula', token: 'wget', path: 'Formula/w/wget.rb' },
    ]);
  });

  it('uses HomebrewFormula/ when there is no Formula/', async () => {
    await layout({ 'HomebrewFormula/b.rb': formula('B'), 'root.rb': formula('Root') });
    expect(await paths()).toEqual(['HomebrewFormula/b.rb']);
  });

  it('falls back to .rb files at the root, without subdirectories', async () => {
    await layout({
      'stripe.rb': formula('Stripe'),
      'tests/helper.rb': '',
      'cmd/brew-foo.rb': '',
      'lib/x.rb': '',
      'README.md': '',
    });
    expect(await listTapFiles(tap)).toEqual([{ kind: 'formula', token: 'stripe', path: 'stripe.rb' }]);
  });

  it('reads casks from Casks/, recursively, next to root formulae', async () => {
    await layout({
      'opencode.rb': formula('Opencode'),
      'Casks/hex.rb': 'cask "hex" do\nend\n',
      'Casks/f/font-x.rb': 'cask "font-x" do\nend\n',
    });
    expect(await listTapFiles(tap)).toEqual([
      { kind: 'cask', token: 'font-x', path: 'Casks/f/font-x.rb' },
      { kind: 'cask', token: 'hex', path: 'Casks/hex.rb' },
      { kind: 'formula', token: 'opencode', path: 'opencode.rb' },
    ]);
  });

  it('ignores test data, tooling and hidden directories', async () => {
    await layout({
      'Formula/real.rb': formula('Real'),
      'Formula/.hidden/x.rb': formula('X'),
      'Formula/.dotfile.rb': formula('Dot'),
      'util/formula_templater/testdata/consul.rb': formula('Consul'),
      '.github/scripts/tests/data/test-formula.rb': formula('TestFormula'),
      'cmd/brew-x.rb': '',
      'Formula/notes.txt': '',
      'Formula/bad name.rb': formula('Bad'),
    });
    expect(await paths()).toEqual(['Formula/real.rb']);
  });

  it('skips symlinked files and directories', async () => {
    await layout({ 'Formula/real.rb': formula('Real'), 'Casks/c.rb': 'cask "c" do\nend\n' });
    await symlink(join(outside, 'secret.rb'), join(tap, 'Formula/evil.rb'));
    await symlink('/etc/passwd', join(tap, 'Formula/passwd.rb'));
    await symlink(outside, join(tap, 'Formula/linked'));
    await symlink(outside, join(tap, 'Casks/linked'));
    expect(await paths()).toEqual(['Casks/c.rb', 'Formula/real.rb']);
  });

  it('does not follow a symlinked Formula/ or Casks/', async () => {
    await symlink(outside, join(tap, 'Formula'));
    await symlink(outside, join(tap, 'Casks'));
    await layout({ 'root.rb': formula('Root') });
    expect(await paths()).toEqual(['root.rb']);
  });

  it('skips files over 256 KiB', async () => {
    await layout({
      'Formula/fits.rb': 'x'.repeat(256 * 1024),
      'Formula/huge.rb': 'x'.repeat(256 * 1024 + 1),
    });
    expect(await paths()).toEqual(['Formula/fits.rb']);
  });

  it('keeps the first path when a token appears twice', async () => {
    await layout({ 'Formula/a/foo.rb': formula('Foo'), 'Formula/foo.rb': formula('Foo') });
    expect(await paths()).toEqual(['Formula/a/foo.rb']);
  });

  it('throws when the tap directory is missing', async () => {
    await expect(listTapFiles(join(root, 'missing'))).rejects.toThrow();
  });

  describe('readTapFile', () => {
    const file = (path: string): TapFile => ({ kind: 'formula', token: 'x', path });

    it('reads a listed file', async () => {
      await layout({ 'Formula/a.rb': formula('A') });
      const [listed] = await listTapFiles(tap);
      expect(await readTapFile(tap, listed)).toBe(formula('A'));
    });

    it('refuses paths that leave the tap', async () => {
      await layout({ 'Formula/a.rb': formula('A') });
      for (const path of [
        '../outside/secret.rb',
        'Formula/../../outside/secret.rb',
        join(outside, 'secret.rb'),
        'Formula\\a.rb',
        'Formula//a.rb',
        './Formula/a.rb',
        'Formula/a.rb\0',
      ]) {
        expect(await readTapFile(tap, file(path))).toBeNull();
      }
    });

    it('refuses symlinks, also on the way to the file', async () => {
      await mkdir(join(tap, 'Formula'));
      await symlink(join(outside, 'secret.rb'), join(tap, 'Formula/evil.rb'));
      await symlink(outside, join(tap, 'Formula/linked'));
      expect(await readTapFile(tap, file('Formula/evil.rb'))).toBeNull();
      expect(await readTapFile(tap, file('Formula/linked/secret.rb'))).toBeNull();
    });

    it('refuses missing, oversized and non-file entries', async () => {
      await layout({ 'Formula/huge.rb': 'x'.repeat(256 * 1024 + 1) });
      await mkdir(join(tap, 'Formula/dir.rb'));
      expect(await readTapFile(tap, file('Formula/missing.rb'))).toBeNull();
      expect(await readTapFile(tap, file('Formula/huge.rb'))).toBeNull();
      expect(await readTapFile(tap, file('Formula/dir.rb'))).toBeNull();
    });
  });
});

describe('a real tap layout', () => {
  // A trimmed copy of github.com/hashicorp/homebrew-tap: .rb files under util/ and .github/ are
  // test data, not packages.
  const tap = join(import.meta.dirname, '../fixtures/taps/hashicorp');

  it('lists and parses the packages only', async () => {
    const files = await listTapFiles(tap);
    expect(files).toEqual([
      { kind: 'cask', token: 'hashicorp-vagrant', path: 'Casks/hashicorp-vagrant.rb' },
      { kind: 'formula', token: 'vlt', path: 'Formula/vlt.rb' },
    ]);
    const [vagrant, vlt] = await Promise.all(files.map((file) => readTapFile(tap, file)));
    expect(parseCask(vagrant ?? '', 'hashicorp-vagrant')).toMatchObject({
      name: 'Vagrant',
      version: '2.4.9',
      homepage: 'https://www.vagrantup.com/',
    });
    expect(parseFormula(vlt ?? '', 'vlt')).toMatchObject({ desc: 'Vlt CLI', version: '1.0.0' });
  });
});
