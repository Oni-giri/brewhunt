// Finds the formula and cask files in a checked-out community tap, following Homebrew's layout
// rules. The repository is untrusted: symlinks are never followed, and files are only read
// through readTapFile, which checks again that the path stays inside the tap.

import { constants, type Dirent } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface TapFile {
  kind: 'formula' | 'cask';
  /** The file name without `.rb`: the formula name or cask token. */
  token: string;
  /** Relative to the tap root, with forward slashes: `Formula/w/wget.rb`. */
  path: string;
}

/** Real formulae and casks are a few KiB; anything this big isn't one. */
const MAX_FILE_BYTES = 256 * 1024;
/** Limits for a hostile tree: homebrew-core is two levels deep with 8.7k formulae. */
const MAX_DEPTH = 6;
const MAX_FILES = 50_000;
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9@._+-]{0,99}\.rb$/;
const DIR_NAME = /^[A-Za-z0-9_][A-Za-z0-9@._+-]*$/;

/**
 * Lists a tap's formulae and casks, sorted by path. Formulae live in `Formula/` if it exists,
 * else `HomebrewFormula/`, else in `*.rb` files at the repository root (not in subdirectories,
 * which hold tests and tooling). Casks live in `Casks/`. A token found twice keeps its first
 * path. Throws when `tapDir` itself can't be read.
 */
export async function listTapFiles(tapDir: string): Promise<TapFile[]> {
  const root = await realpath(path.resolve(tapDir));
  if (!(await lstat(root)).isDirectory()) throw new Error(`Not a directory: ${tapDir}`);

  const files: TapFile[] = [];
  if (await isDirectory(root, 'Formula')) await collect(root, 'Formula', 'formula', true, files);
  else if (await isDirectory(root, 'HomebrewFormula')) {
    await collect(root, 'HomebrewFormula', 'formula', true, files);
  } else await collect(root, '', 'formula', false, files);
  if (await isDirectory(root, 'Casks')) await collect(root, 'Casks', 'cask', true, files);

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const seen = new Set<string>();
  return files.filter((file) => {
    const key = `${file.kind}:${file.token}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Reads a file listed by listTapFiles. Null when it's missing, not a regular file, reached
 * through a symlink, outside the tap, or larger than 256 KiB.
 */
export async function readTapFile(tapDir: string, file: TapFile): Promise<string | null> {
  try {
    const segments = file.path.split('/');
    const unsafe =
      path.isAbsolute(file.path) ||
      /[\\\0]/.test(file.path) ||
      segments.some((segment) => segment === '' || segment === '.' || segment === '..');
    if (unsafe || !file.path.endsWith('.rb')) return null;

    const root = await realpath(path.resolve(tapDir));
    const target = path.join(root, ...segments);
    // Any symlink on the way, in a directory or the file itself, makes the real path differ.
    if (!target.startsWith(root + path.sep) || (await realpath(target)) !== target) return null;

    // O_NOFOLLOW guards against a swap after the check; O_NONBLOCK keeps a FIFO from hanging.
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) return null;
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      return length > MAX_FILE_BYTES ? null : buffer.toString('utf8', 0, length);
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/** A real directory: a symlink to one doesn't count. */
async function isDirectory(root: string, name: string): Promise<boolean> {
  try {
    return (await lstat(path.join(root, name))).isDirectory();
  } catch {
    return false;
  }
}

async function collect(
  root: string,
  dir: string,
  kind: TapFile['kind'],
  recursive: boolean,
  files: TapFile[],
  depth = 0,
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(path.join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    if (files.length >= MAX_FILES) return;
    const relative = dir === '' ? entry.name : `${dir}/${entry.name}`;
    // Dirent types come from lstat: a symlink is neither a file nor a directory here.
    if (entry.isDirectory()) {
      if (recursive && depth < MAX_DEPTH && DIR_NAME.test(entry.name)) {
        await collect(root, relative, kind, recursive, files, depth + 1);
      }
      continue;
    }
    if (!entry.isFile() || !FILE_NAME.test(entry.name)) continue;
    try {
      const stats = await lstat(path.join(root, relative));
      if (!stats.isFile() || stats.size > MAX_FILE_BYTES) continue;
    } catch {
      continue;
    }
    files.push({ kind, token: entry.name.slice(0, -3), path: relative });
  }
}
