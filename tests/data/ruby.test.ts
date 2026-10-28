import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseCask, parseFormula } from '../../scripts/data/ruby.ts';

const fixture = (name: string): string =>
  readFileSync(join(import.meta.dirname, '../fixtures/ruby', name), 'utf8');

const formula = (body: string, token = 'foo') =>
  parseFormula(`class Foo < Formula\n${body}\nend\n`, token);
const cask = (body: string, token = 'foo') => parseCask(`cask "${token}" do\n${body}\nend\n`, token);
const versionOf = (url: string, extra = '') => formula(`  url "${url}"${extra}`).version;

afterEach(() => {
  vi.useRealTimers();
});

describe('strings', () => {
  it('reads double-quoted escapes', () => {
    expect(formula(String.raw`  desc "Say \"hi\" to C:\\ now"`).desc).toBe('Say "hi" to C:\\ now');
  });

  it('turns escaped newlines and tabs into single spaces', () => {
    expect(formula(String.raw`  desc "One\ntwo\tthree"`).desc).toBe('One two three');
  });

  it('reads single-quoted escapes and leaves other backslashes alone', () => {
    expect(formula(String.raw`  desc 'It\'s a \\ and a \n'`).desc).toBe(String.raw`It's a \ and a \n`);
  });

  it('joins adjacent literals, also across a line continuation', () => {
    expect(formula('  desc "Fast " \\\n    "tool"').desc).toBe('Fast tool');
  });

  it('treats interpolated strings as unknown', () => {
    expect(formula('  desc "Tool for #{name}"').desc).toBeNull();
    expect(formula('  desc "Tool for #@name"').desc).toBeNull();
  });

  it('keeps a lone # that is not interpolation', () => {
    expect(formula('  desc "C# compiler" # not this').desc).toBe('C# compiler');
  });

  it('substitutes #{version} in homepage once the version is known', () => {
    const pkg = formula('  version "2.1"\n  homepage "https://example.com/v#{version}/"');
    expect(pkg.homepage).toBe('https://example.com/v2.1/');
    expect(formula('  homepage "https://example.com/v#{version}/"').homepage).toBeNull();
    expect(formula('  version "2.1"\n  homepage "https://example.com/#{version.major}/"').homepage).toBeNull();
  });

  it('treats an unterminated string as unknown', () => {
    expect(formula('  desc "never closed\n  homepage "https://example.com"').desc).toBeNull();
  });
});

describe('statements', () => {
  it('accepts calls with and without parentheses', () => {
    expect(formula('  desc("With parens")').desc).toBe('With parens');
    expect(formula('  desc ("Spaced parens")').desc).toBe('Spaced parens');
  });

  it('ignores comments, =begin blocks and heredocs', () => {
    const pkg = formula(
      [
        '  # desc "comment"',
        '=begin',
        '  desc "block comment"',
        '=end',
        '  NOTES = <<~EOS',
        '    desc "heredoc"',
        '    homepage "https://heredoc.example"',
        '  EOS',
        '  desc "Real"',
        '  homepage "https://real.example"',
      ].join('\n'),
    );
    expect(pkg.desc).toBe('Real');
    expect(pkg.homepage).toBe('https://real.example');
  });

  it('stops at __END__', () => {
    const pkg = parseFormula(
      'class Foo < Formula\n  url "https://x.org/foo-1.0.tar.gz"\n  patch :DATA\nend\n__END__\n  desc "patch"\n',
      'foo',
    );
    expect(pkg.desc).toBeNull();
    expect(pkg.version).toBe('1.0');
  });

  it('ignores livecheck, resource, head, patch and method bodies', () => {
    const pkg = formula(
      [
        '  livecheck do',
        '    url "https://example.com/foo-9.9.9.tar.gz"',
        '    regex(%r{href=["\']?foo-(\\d+(?:\\.\\d+)+)}i)',
        '  end',
        '  head do',
        '    url "https://example.com/foo.git"',
        '    depends_on "autoconf"',
        '  end',
        '  resource "bar" do',
        '    url "https://example.com/bar-5.0.tar.gz"',
        '    version "5.0"',
        '  end',
        '  def caveats',
        '    desc "not this"',
        '  end',
        '  url "https://example.com/foo-1.2.3.tar.gz"',
      ].join('\n'),
    );
    expect(pkg.version).toBe('1.2.3');
    expect(pkg.desc).toBeNull();
    expect(pkg.dependencies).toEqual([]);
  });

  it('only reads the formula class, not helper classes', () => {
    const pkg = parseFormula(
      [
        'class FooDownloadStrategy < CurlDownloadStrategy',
        '  desc "helper"',
        'end',
        'class Foo < Formula',
        '  desc "Real"',
        'end',
      ].join('\n'),
      'foo',
    );
    expect(pkg.desc).toBe('Real');
    expect(parseFormula('class Foo < PortableFormula\n  desc "Portable"\nend', 'foo').desc).toBe(
      'Portable',
    );
  });

  it('takes the first url and version, preferring the top level', () => {
    const nested = [
      '  on_macos do',
      '    url "https://example.com/foo-2.0-mac.tar.gz"',
      '    version "2.0"',
      '  end',
    ].join('\n');
    expect(formula(`${nested}\n  version "1.0"`).version).toBe('1.0');
    expect(formula(nested).version).toBe('2.0');
    expect(
      formula(`  on_intel do\n    version "3.0"\n  end\n  on_intel do\n    version "4.0"\n  end`).version,
    ).toBe('3.0');
  });

  it('prefers blocks that apply on current macOS on Apple silicon', () => {
    expect(
      formula(`  on_linux do\n    version "3.0"\n  end\n  on_macos do\n    version "4.0"\n  end`).version,
    ).toBe('4.0');
    const pkg = cask(
      [
        '  on_intel do',
        '    version "1.0-intel"',
        '  end',
        '  on_arm do',
        '    version "1.0-arm"',
        '  end',
      ].join('\n'),
    );
    expect(pkg.version).toBe('1.0-arm');
  });
});

describe('formula versions', () => {
  it('prefers an explicit version over the URL', () => {
    expect(formula('  url "https://x.org/foo-1.0.tar.gz"\n  version "1.0.1"').version).toBe('1.0.1');
  });

  it.each([
    ['https://ftpmirror.gnu.org/wget/wget-1.25.0.tar.gz', '1.25.0'],
    ['https://releases.example.com/foo/1.2.3/foo_1.2.3_darwin_arm64.zip', '1.2.3'],
    ['https://github.com/o/foo/releases/download/v1.2.3/foo-darwin-arm64.tar.gz', '1.2.3'],
    ['https://github.com/o/foo/releases/download/v2.1.13/foo-macos-universal-v2.1.13.tar.gz', '2.1.13'],
    ['https://github.com/o/foo/releases/download/bun-v1.4.4/bun-darwin-aarch64.zip', '1.4.4'],
    ['https://github.com/o/foo/archive/refs/tags/v1.2.3.tar.gz', '1.2.3'],
    ['https://github.com/o/foo/archive/1.2.3.tar.gz', '1.2.3'],
    ['https://example.com/dl/v1.2.3/foo-macos.zip', '1.2.3'],
    ['https://github.com/o/foo/releases/download/v1.0/foo_1.0-beta.15_linux_amd64.tar.gz', '1.0'],
    ['https://example.com/foo-v2.0.0-rc1-x86_64-apple-darwin.tar.gz', '2.0.0-rc1'],
    ['https://example.com/ddev_macos-amd64.v1.25.5.tar.gz', '1.25.5'],
    ['https://registry.npmjs.org/birdclaw/-/birdclaw-0.16.3.tgz', '0.16.3'],
    ['https://www.openssl.org/source/openssl-1.1.1w.tar.gz', '1.1.1w'],
  ])('reads %s', (url, version) => {
    expect(versionOf(url)).toBe(version);
  });

  it('reads the tag of a git URL', () => {
    expect(versionOf('https://github.com/o/foo.git', ',\n      tag: "v1.2.3",\n      revision: "abc"')).toBe(
      '1.2.3',
    );
    expect(versionOf('https://github.com/o/foo.git', ', branch: "main"')).toBeNull();
  });

  it.each([
    ['https://example.com/foo-latest.tar.gz'],
    ['https://github.com/o/foo/archive/edd2392f7a87d8f1dc9b83f6a5b54a17edf20826.tar.gz'],
    ['https://downloads.example.com/bashdb-5.2-1.2.0.tar.bz2'],
    ['https://example.com/libedit-20260512-3.1.tar.gz'],
    ['https://example.com/lynx2.9.3.tar.bz2'],
    ['https://example.com/4.2/foo-4.2.8-weird.tar.gz'],
    ['https://example.com/download?file=foo-1.2.3.tar.gz'],
    ['ftp.example.com/foo-1.2.3.tar.gz'],
  ])('gives up on %s', (url) => {
    expect(versionOf(url)).toBeNull();
  });

  it('gives up when the URL needs a version it does not have', () => {
    expect(versionOf('https://x.org/foo-#{version}.tar.gz')).toBeNull();
  });

  it('reads the URL for current macOS, or needs the URLs to agree', () => {
    const urls = (a: string, b: string) =>
      formula(`  on_arm do\n    url "${a}"\n  end\n  on_intel do\n    url "${b}"\n  end`).version;
    expect(urls('https://x.org/v1.2.0/foo-arm64.zip', 'https://x.org/v1.2.0/foo-x64.zip')).toBe('1.2.0');
    expect(urls('https://x.org/v1.2.0/foo-arm64.zip', 'https://x.org/v1.1.0/foo-x64.zip')).toBe('1.2.0');
    expect(
      formula(
        '  on_macos do\n    url "https://x.org/foo-1.2.tar.gz"\n  end\n  on_linux do\n    url "https://x.org/foo-1.3.tar.gz"\n  end',
      ).version,
    ).toBe('1.2');
    expect(
      formula(
        '  if Hardware::CPU.avx2?\n    url "https://x.org/foo-1.2.tar.gz"\n  else\n    url "https://x.org/foo-1.3.tar.gz"\n  end',
      ).version,
    ).toBeNull();
  });
});

describe('cask versions', () => {
  it('reads double- and single-quoted versions', () => {
    expect(cask('  version "1.2.3,456"').version).toBe('1.2.3,456');
    expect(cask("  version '0.21.3-Beta'").version).toBe('0.21.3-Beta');
  });

  it('reads :latest', () => {
    expect(cask('  version :latest').version).toBe('latest');
  });

  it('gives up on interpolation', () => {
    expect(cask('  version "#{MAJOR}.1"').version).toBeNull();
  });
});

describe('licenses', () => {
  it.each([
    ['license "MIT"', 'MIT'],
    ["license 'Apache-2.0'", 'Apache-2.0'],
    ['license :public_domain', 'LicenseRef-Homebrew-public-domain'],
    ['license :cannot_represent', null],
    ['license any_of: ["MIT", "Apache-2.0"]', 'MIT OR Apache-2.0'],
    ['license all_of: ["MIT", :public_domain]', 'MIT AND LicenseRef-Homebrew-public-domain'],
    ['license all_of: [\n    "MIT",\n    "BSD-3-Clause",\n  ]', 'MIT AND BSD-3-Clause'],
    ['license "GPL-3.0-or-later" => { with: "GCC-exception-3.1" }', null],
    ['license any_of: ["MIT", { "GPL-2.0-only" => { with: "x" } }]', null],
    ['license all_of: ["MIT", any_of: ["A", "B"]]', null],
  ])('reads %s', (line, license) => {
    expect(formula(`  ${line}`).license).toBe(license);
  });

  it('is null for casks', () => {
    expect(cask('  license "MIT"').license).toBeNull();
  });
});

describe('cleaning', () => {
  it('treats an empty or blank desc as missing', () => {
    expect(formula('  desc ""').desc).toBeNull();
    expect(formula('  desc "   "').desc).toBeNull();
  });

  it('trims and strips control and bidi characters', () => {
    expect(formula('  desc "  A\\u0000B\\e[31mC\\u202Ed  "').desc).toBe('A B [31mC d');
  });

  it('caps desc at 300 characters and name at 120', () => {
    const desc = formula(`  desc "${'a'.repeat(400)}"`).desc ?? '';
    expect(Array.from(desc)).toHaveLength(300);
    expect(desc.endsWith('…')).toBe(true);
    expect(Array.from(cask(`  name "${'é'.repeat(200)}"`).name ?? '')).toHaveLength(120);
  });

  it('only keeps http(s) homepages', () => {
    expect(formula('  homepage "https://example.com/"').homepage).toBe('https://example.com/');
    expect(formula('  homepage "http://example.com"').homepage).toBe('http://example.com');
    expect(formula('  homepage "ftp://example.com"').homepage).toBeNull();
    expect(formula('  homepage "javascript:alert(1)"').homepage).toBeNull();
    expect(formula('  homepage "example.com"').homepage).toBeNull();
    expect(formula('  homepage "https://exa mple.com"').homepage).toBeNull();
    expect(formula('  homepage ""').homepage).toBeNull();
  });

  it('keeps the first homepage argument', () => {
    expect(formula('  homepage "https://example.com/", browsed: "2026-09-05"').homepage).toBe(
      'https://example.com/',
    );
  });
});

describe('deprecation', () => {
  it('reads deprecate! and disable! at the top level', () => {
    expect(formula('  deprecate! date: "2000-01-01", because: :unmaintained').deprecated).toBe(true);
    expect(formula('  deprecate! because: :unmaintained').deprecated).toBe(true);
    expect(formula('  disable! date: "2000-01-01", because: :unmaintained').disabled).toBe(true);
    expect(cask('  deprecate! date: "2000-01-01", because: :discontinued').deprecated).toBe(true);
  });

  it('follows Homebrew for dates in the future', () => {
    expect(formula('  deprecate! date: "2999-01-01", because: :unmaintained').deprecated).toBe(false);
    const disabledLater = formula('  disable! date: "2999-01-01", because: :unmaintained');
    expect(disabledLater).toMatchObject({ deprecated: true, disabled: false });
    const both = formula(
      '  deprecate! date: "2998-01-01", because: :x\n  disable! date: "2999-01-01", because: :x',
    );
    expect(both).toMatchObject({ deprecated: false, disabled: false });
  });

  it('ignores calls in other blocks', () => {
    expect(formula('  def caveats\n    deprecate! date: "2000-01-01", because: :x\n  end').deprecated).toBe(
      false,
    );
    expect(formula('  on_linux do\n    disable! date: "2000-01-01", because: :x\n  end').disabled).toBe(
      false,
    );
    expect(formula('  on_macos do\n    disable! date: "2000-01-01", because: :x\n  end').disabled).toBe(
      true,
    );
  });
});

describe('dependencies', () => {
  it('keeps runtime formula dependencies in order, once each', () => {
    const pkg = formula(
      [
        '  depends_on "pkgconf" => :build',
        '  depends_on "cmake" => [:build, :test]',
        '  depends_on "bats" => :test',
        '  depends_on "python" => :optional',
        '  depends_on "go", type: :build',
        '  depends_on "openssl@3"',
        '  depends_on "hashicorp/tap/terraform"',
        '  depends_on "readline" => :recommended',
        '  depends_on "openssl@3"',
        '  depends_on :macos',
        '  depends_on macos: :sonoma',
        '  depends_on xcode: ["14.0", :build]',
        '  depends_on arch: :arm64',
        '  depends_on "jq" if build.with? "jq"',
        '  uses_from_macos "zlib"',
        '  on_macos do',
        '    depends_on "gettext"',
        '  end',
        '  on_linux do',
        '    depends_on "util-linux"',
        '  end',
        '  on_intel do',
        '    depends_on "intel-only"',
        '  end',
        '  on_sonoma :or_newer do',
        '    depends_on "new-macos"',
        '  end',
        '  on_ventura :or_older do',
        '    depends_on "old-macos"',
        '  end',
      ].join('\n'),
    );
    expect(pkg.dependencies).toEqual([
      'openssl@3',
      'hashicorp/tap/terraform',
      'readline',
      'gettext',
      'new-macos',
    ]);
  });

  it('reads formula dependencies of casks', () => {
    const pkg = cask(
      [
        '  depends_on formula: "git"',
        '  depends_on formula: ["gnupg", "pinentry"]',
        '  depends_on cask: "homebrew/cask/git-credential-manager"',
        '  depends_on macos: ">= :big_sur"',
      ].join('\n'),
    );
    expect(pkg.dependencies).toEqual(['git', 'gnupg', 'pinentry']);
  });
});

describe('casks', () => {
  it('takes the token from the cask block, else the file name', () => {
    expect(parseCask('cask "real-token" do\nend', 'file-token').token).toBe('real-token');
    expect(parseCask('cask "../../etc" do\nend', 'file-token').token).toBe('file-token');
    expect(parseCask('# nothing here', 'file-token').token).toBe('file-token');
  });

  it('reads the first name and auto_updates', () => {
    const pkg = cask('  name "First"\n  name "Second"\n  auto_updates true');
    expect(pkg).toMatchObject({ name: 'First', autoUpdates: true, license: null });
    expect(cask('  auto_updates false').autoUpdates).toBe(false);
  });

  it('gives formulae no name', () => {
    expect(formula('  name "Nope"')).toMatchObject({ name: null, token: 'foo', kind: 'formula' });
  });
});

describe('malformed input', () => {
  it.each([
    [''],
    ['class Foo < Formula'],
    ['end end end\ndesc "x"'],
    ['class Foo < Formula\n  desc "#{"#{"#{'],
    ['class Foo < Formula\n  url %w(\n'],
    ['\u0000\u0001\uFFFD binary'],
    ['class Foo < Formula\n' + 'a do\n'.repeat(5000)],
  ])('does not throw on %j', (source) => {
    expect(() => parseFormula(source, 'x')).not.toThrow();
    expect(() => parseCask(source, 'x')).not.toThrow();
  });

  it('does not throw on any prefix of a real file', () => {
    const source = fixture('terraform.rb') + fixture('aerospace.rb');
    for (let end = 0; end <= source.length; end += 7) {
      expect(() => parseFormula(source.slice(0, end), 'x')).not.toThrow();
      expect(() => parseCask(source.slice(0, end), 'x')).not.toThrow();
    }
  });

  it('ignores a definition nested too deep to be real', () => {
    expect(formula(`${'  on_macos do\n'.repeat(10)}  desc "nested"`).desc).toBe('nested');
    expect(formula(`${'  on_macos do\n'.repeat(100)}  desc "deep"`).desc).toBeNull();
  });
});

describe('real files', () => {
  it('bats-assert: version from an archive URL', () => {
    expect(parseFormula(fixture('bats-assert.rb'), 'bats-assert')).toEqual({
      kind: 'formula',
      token: 'bats-assert',
      desc: 'Common assertions for Bats',
      homepage: 'https://github.com/bats-core/bats-assert',
      version: '2.2.4',
      license: 'MIT',
      name: null,
      deprecated: false,
      disabled: false,
      dependencies: [],
      autoUpdates: false,
      artifacts: [],
      platforms: null,
    });
  });

  it('fuego: explicit version, any_of licence, dated deprecation', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    const pkg = parseFormula(fixture('fuego.rb'), 'fuego');
    expect(pkg).toMatchObject({
      version: '1.1',
      license: 'GPL-3.0-only OR LGPL-3.0-only',
      dependencies: ['boost'],
      deprecated: true,
      disabled: false,
    });
    vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
    expect(parseFormula(fixture('fuego.rb'), 'fuego').deprecated).toBe(false);
    vi.setSystemTime(new Date('2027-05-01T12:00:00Z'));
    expect(parseFormula(fixture('fuego.rb'), 'fuego').disabled).toBe(true);
  });

  it('blink1: version from a git tag, Linux-only dependencies left out', () => {
    expect(parseFormula(fixture('blink1.rb'), 'blink1')).toMatchObject({
      version: '2.5.0',
      license: 'CC-BY-SA-4.0 OR MIT',
      dependencies: [],
    });
  });

  it('wget: stable block, head block and per-platform dependencies', () => {
    expect(parseFormula(fixture('wget.rb'), 'wget')).toMatchObject({
      version: '1.25.0',
      license: 'GPL-3.0-or-later',
      dependencies: ['libidn2', 'libpsl', 'openssl@4', 'gettext', 'libunistring'],
    });
  });

  it('opencode: URLs in on_macos/on_linux blocks', () => {
    expect(parseFormula(fixture('opencode.rb'), 'opencode')).toMatchObject({
      desc: 'The AI coding agent built for the terminal.',
      homepage: 'https://github.com/anomalyco/opencode',
      version: '1.19.4',
      license: null,
      dependencies: ['ripgrep'],
    });
  });

  it('terraform: shell heredocs and if OS.mac? blocks', () => {
    expect(parseFormula(fixture('terraform.rb'), 'terraform')).toMatchObject({
      desc: 'Terraform',
      homepage: 'https://www.terraform.io/',
      version: '1.17.0',
      dependencies: [],
    });
  });

  it('bun: livecheck URL and a regexp with quotes in it', () => {
    expect(parseFormula(fixture('bun.rb'), 'bun')).toMatchObject({
      homepage: 'https://bun.sh/',
      version: '1.4.4',
      license: 'MIT',
    });
  });

  it('aerospace: single-quoted cask version', () => {
    expect(parseCask(fixture('aerospace.rb'), 'aerospace')).toEqual({
      kind: 'cask',
      token: 'aerospace',
      desc: 'AeroSpace is an i3-like tiling window manager for macOS',
      homepage: 'https://github.com/nikitabobko/AeroSpace',
      version: '0.21.3-Beta',
      license: null,
      name: 'AeroSpace',
      deprecated: false,
      disabled: false,
      dependencies: [],
      autoUpdates: false,
      artifacts: ['app', 'binary'],
      platforms: null,
    });
  });

  it('aloha-browser: version :latest', () => {
    expect(parseCask(fixture('aloha-browser.rb'), 'aloha-browser')).toMatchObject({
      version: 'latest',
      name: 'Aloha Browser',
      desc: 'Web browser focused on privacy',
    });
  });

  it('virtualbox@beta: interpolated desc', () => {
    expect(parseCask(fixture('virtualbox@beta.rb'), 'virtualbox@beta')).toMatchObject({
      token: 'virtualbox@beta',
      desc: null,
      name: 'Oracle VirtualBox',
      version: '7.2.15-174740',
    });
  });

  it('apparency: the version for current macOS', () => {
    expect(parseCask(fixture('apparency.rb'), 'apparency')).toMatchObject({
      version: '3.4',
      desc: 'Inspect application bundles',
    });
  });

  it('microsoft-git: single quotes everywhere, no desc', () => {
    expect(parseCask(fixture('microsoft-git.rb'), 'microsoft-git')).toMatchObject({
      desc: null,
      name: 'Microsoft-fork of Git',
      homepage: 'https://github.com/microsoft/git',
      version: '2.56.0.vfs.0.4',
      dependencies: [],
    });
  });
});

describe('hostile input', () => {
  it('stays linear on a file of escaped slashes that never close a regexp', () => {
    // Each `/` could start a regexp; rescanning to the end of the file from each one was quadratic.
    const src = `class Foo < Formula\n  desc "x"\n  (${'\\/'.repeat(128_000)}\nend\n`;
    const start = performance.now();
    expect(parseFormula(src, 'foo').desc).toBe('x');
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe('cask artifacts and platforms', () => {
  it('lists artifact stanzas and reads a Linux-only `os`', () => {
    const cask = parseCask(
      `cask "asusctl-linux" do
  arch arm: "arm64", intel: "amd64"
  os linux: "linux"
  version "6.5.0,4"
  url "https://example.com/asusctl-#{version}.tar.gz"
  name "asusctl"
  desc "ASUS laptop control CLI"
  homepage "https://example.com"
  binary "asusctl/usr/bin/asusctl"
  binary "asusctl/usr/bin/asusd"
end
`,
      'asusctl-linux',
    );
    expect(cask.artifacts).toEqual(['binary']);
    expect(cask.platforms).toEqual(['linux']);
  });

  it('reads both systems, `depends_on :macos`, and apps', () => {
    const both = parseCask(
      `cask "x" do
  os macos: "darwin", linux: "linux"
  app "X.app"
  binary "x"
end
`,
      'x',
    );
    expect(both.platforms).toEqual(['macos', 'linux']);
    expect(both.artifacts).toEqual(['app', 'binary']);
    const mac = parseCask(`cask "y" do
  depends_on :macos
  pkg "Y.pkg"
end
`, 'y');
    expect(mac.platforms).toEqual(['macos']);
    expect(mac.artifacts).toEqual(['pkg']);
    expect(parseCask(`cask "z" do
  app "Z.app"
end
`, 'z').platforms).toBeNull();
    expect(parseFormula(`class Z < Formula
  desc "z"
end
`, 'z').artifacts).toEqual([]);
  });
});
