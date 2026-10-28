// The editorial layer: categories, collections, editor's picks and per-package overrides,
// hand-edited as YAML in content/. This module defines their shapes, reads the files and
// checks everything that doesn't need Homebrew's package list. Checks against the package
// list live in validate.ts.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isNode, LineCounter, parseDocument } from 'yaml';
import type { Document } from 'yaml';
import { z } from 'zod';

/** Icon tile gradients from docs/DESIGN-SYSTEM.md. */
export const TILES = [
  'blue',
  'orange',
  'green',
  'purple',
  'pink',
  'yellow',
  'teal',
  'slate',
  'terminal',
] as const;

export const CONTENT_FILES = [
  'categories.yaml',
  'collections.yaml',
  'picks.yaml',
  'packages.yaml',
  'overrides.yaml',
] as const;

export type ContentFile = (typeof CONTENT_FILES)[number];
export type IssuePath = (string | number)[];

export interface ContentIssue {
  file: ContentFile;
  /** Where in the file, as keys and list indexes: `[2, 'packages', 5, 'id']`. */
  path: IssuePath;
  message: string;
  /** 1-based line in the file, when known. */
  line?: number;
}

// --- Field schemas ---

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** `wget`, `python@3.14`, `logi-options+`, `llama.cpp`, or `owner/tap/name`. */
const PACKAGE_ID = /^(?:[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*\/)?[a-z0-9][a-z0-9@+._-]*$/;
/** A full stop, `!` or `?` followed by a capital: a second sentence starts. */
const SENTENCE_BREAK = /[.!?]\s+\p{Lu}/u;

const slug = z
  .string()
  .regex(SLUG, 'Use lowercase letters, digits and single hyphens, like "menu-bar".');

const packageId = z
  .string()
  .regex(
    PACKAGE_ID,
    'Not a package id: use a formula name ("wget"), a cask token ("rectangle") or "owner/tap/name".',
  );

/** One line of plain text. Trimmed, so folded YAML blocks (`>`) are fine. */
function line(max: number) {
  return z
    .string()
    .trim()
    .min(1, 'Must not be empty.')
    .max(max, `Keep it under ${max + 1} characters.`)
    .refine((s) => !s.includes('\n'), 'Keep it on one line.');
}

/** One sentence that ends with a full stop. */
function sentence(max: number) {
  return line(max)
    .refine((s) => s.endsWith('.'), 'End it with a full stop.')
    .refine((s) => !SENTENCE_BREAK.test(s), 'Keep it to one sentence.');
}

/** A list that may be left empty in YAML (`show:` with nothing under it parses as null). */
function list<T extends z.ZodType>(item: T) {
  return z
    .array(item)
    .nullish()
    .transform((v) => v ?? []);
}

type Ctx = z.RefinementCtx;

/** Adds an issue at each repeat of a value already seen earlier in the list. */
function unique(values: string[], ctx: Ctx, at: (i: number) => IssuePath, what: string): void {
  const seen = new Set<string>();
  values.forEach((value, i) => {
    if (seen.has(value)) {
      ctx.addIssue({ code: 'custom', path: at(i), message: `Duplicate ${what} "${value}".` });
    }
    seen.add(value);
  });
}

export const tileSchema = z.enum(TILES, `Use one of: ${TILES.join(', ')}.`);

// --- categories.yaml ---

export const subcategorySchema = z.strictObject({
  slug,
  name: line(30),
});

export const categoryPackageSchema = z.strictObject({
  id: packageId,
  /** Sub-category slug, from this category's `subcategories`. */
  sub: slug.optional(),
});

export const categorySchema = z
  .strictObject({
    slug,
    name: line(30),
    description: sentence(160),
    tile: tileSchema,
    subcategories: list(subcategorySchema),
    packages: z.array(categoryPackageSchema).min(1, 'List at least one package.'),
  })
  .superRefine((category, ctx) => {
    unique(
      category.subcategories.map((s) => s.slug),
      ctx,
      (i) => ['subcategories', i, 'slug'],
      'sub-category',
    );
    unique(
      category.packages.map((p) => p.id),
      ctx,
      (i) => ['packages', i, 'id'],
      'package',
    );
    const subs = category.subcategories.map((s) => s.slug);
    category.packages.forEach((p, i) => {
      if (p.sub === undefined || subs.includes(p.sub)) return;
      ctx.addIssue({
        code: 'custom',
        path: ['packages', i, 'sub'],
        message:
          subs.length === 0
            ? `Unknown sub-category "${p.sub}": "${category.slug}" has no sub-categories.`
            : `Unknown sub-category "${p.sub}": "${category.slug}" has ${subs.join(', ')}.`,
      });
    });
  });

export const categoriesSchema = z
  .array(categorySchema)
  .min(1, 'List at least one category.')
  .superRefine((categories, ctx) => {
    unique(
      categories.map((c) => c.slug),
      ctx,
      (i) => [i, 'slug'],
      'category',
    );
  });

// --- collections.yaml ---

export const collectionSchema = z
  .strictObject({
    slug,
    title: line(40),
    subtitle: line(60),
    tile: tileSchema,
    packages: z.array(packageId).min(1, 'List at least one package.'),
  })
  .superRefine((collection, ctx) => {
    unique(collection.packages, ctx, (i) => ['packages', i], 'package');
  });

export const collectionsSchema = list(collectionSchema).superRefine((collections, ctx) => {
  unique(
    collections.map((c) => c.slug),
    ctx,
    (i) => [i, 'slug'],
    'collection',
  );
});

// --- picks.yaml ---

export const pickSchema = z.strictObject({
  id: packageId,
  date: z.iso.date('Use a date like 2026-10-28.'),
  /** Category slug: category pages show their newest matching pick. */
  category: slug.optional(),
  blurb: line(200).refine((s) => s.endsWith('.'), 'End it with a full stop.'),
});

export const picksSchema = list(pickSchema).superRefine((picks, ctx) => {
  unique(
    picks.map((p) => p.id),
    ctx,
    (i) => [i, 'id'],
    'pick',
  );
  picks.forEach((pick, i) => {
    if (i > 0 && pick.date > picks[i - 1].date) {
      ctx.addIssue({
        code: 'custom',
        path: [i, 'date'],
        message: `List picks newest first: ${pick.date} is after the pick above it (${picks[i - 1].date}).`,
      });
    }
  });
});

// --- packages.yaml ---

const keyword = line(30).refine((s) => s === s.toLowerCase(), 'Use lowercase.');

export const packageEditorialSchema = z
  .strictObject({
    /** Shown in lists instead of Homebrew's description. */
    tagline: line(60)
      .refine((s) => !s.endsWith('.'), 'No full stop at the end, like Homebrew descriptions.')
      .optional(),
    developer: line(60).optional(),
    /** Search terms Homebrew's data doesn't link to the package: `vscode`, `tf`. */
    keywords: z.array(keyword).min(1).max(10, 'List 10 keywords at most.').optional(),
  })
  .superRefine((p, ctx) => {
    if (p.tagline === undefined && p.developer === undefined && p.keywords === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'Add a tagline, a developer or keywords, or remove this entry.',
      });
    }
    unique(p.keywords ?? [], ctx, (i) => ['keywords', i], 'keyword');
  });

export const packagesEditorialSchema = z
  .record(packageId, packageEditorialSchema)
  .nullish()
  .transform((v) => v ?? {});

// --- overrides.yaml ---

export const overridesSchema = z
  .strictObject({
    library: z
      .strictObject({
        /** Formulae flagged as libraries that should still appear in charts and discovery. */
        show: list(packageId),
        /** Formulae to treat as libraries even though the heuristic doesn't flag them. */
        hide: list(packageId),
      })
      .nullish()
      .transform((v) => v ?? { show: [], hide: [] }),
    /** Removed from every list; the app page stays. */
    hidden: list(packageId),
  })
  .superRefine((overrides, ctx) => {
    const { show, hide } = overrides.library;
    unique(show, ctx, (i) => ['library', 'show', i], 'package');
    unique(hide, ctx, (i) => ['library', 'hide', i], 'package');
    unique(overrides.hidden, ctx, (i) => ['hidden', i], 'package');
    hide.forEach((id, i) => {
      if (show.includes(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['library', 'hide', i],
          message: `"${id}" is in both library.show and library.hide.`,
        });
      }
    });
  });

export type Tile = z.infer<typeof tileSchema>;
export type Subcategory = z.infer<typeof subcategorySchema>;
export type CategoryPackage = z.infer<typeof categoryPackageSchema>;
export type Category = z.infer<typeof categorySchema>;
export type Collection = z.infer<typeof collectionSchema>;
export type EditorsPick = z.infer<typeof pickSchema>;
export type PackageEditorial = z.infer<typeof packageEditorialSchema>;
export type Overrides = z.infer<typeof overridesSchema>;

export interface Content {
  /** In display order. A package's first category in this order is its primary one. */
  categories: Category[];
  collections: Collection[];
  /** Newest first. */
  picks: EditorsPick[];
  /** Editorial fields keyed by package id. */
  packages: Record<string, PackageEditorial>;
  overrides: Overrides;
}

/** The parsed but unvalidated YAML of each file; a missing key stands for an empty file. */
export type RawContent = Partial<Record<ContentFile, unknown>>;

// --- Parsing and checks ---

const SCHEMAS = {
  'categories.yaml': categoriesSchema,
  'collections.yaml': collectionsSchema,
  'picks.yaml': picksSchema,
  'packages.yaml': packagesEditorialSchema,
  'overrides.yaml': overridesSchema,
} as const;

/** What an empty file (or one with only comments) stands for. */
const EMPTY: Record<ContentFile, unknown> = {
  'categories.yaml': [],
  'collections.yaml': [],
  'picks.yaml': [],
  'packages.yaml': {},
  'overrides.yaml': {},
};

/** Checks across files that don't need the package list. */
function crossCheck(content: Content): ContentIssue[] {
  const issues: ContentIssue[] = [];
  const categories = new Map(content.categories.map((c) => [c.slug, c]));
  content.picks.forEach((pick, i) => {
    if (pick.category === undefined) return;
    const category = categories.get(pick.category);
    if (!category) {
      issues.push({
        file: 'picks.yaml',
        path: [i, 'category'],
        message: `Unknown category "${pick.category}".`,
      });
    } else if (!category.packages.some((p) => p.id === pick.id)) {
      issues.push({
        file: 'picks.yaml',
        path: [i, 'id'],
        message: `"${pick.id}" isn't listed in the "${pick.category}" category.`,
      });
    }
  });
  return issues;
}

export interface ContentReport {
  /** Set when every file matches its schema, even if references between files are broken. */
  content: Content | null;
  /** Schema issues, then (once every file matches its schema) broken references between files. */
  issues: ContentIssue[];
}

function parseFiles(raw: RawContent, unreadable: ReadonlySet<ContentFile>): ContentReport {
  const issues: ContentIssue[] = [];
  const parsed: Partial<Record<ContentFile, unknown>> = {};
  for (const file of CONTENT_FILES) {
    if (unreadable.has(file)) continue;
    const result = SCHEMAS[file].safeParse(raw[file] ?? EMPTY[file]);
    if (result.success) {
      parsed[file] = result.data;
    } else {
      for (const issue of result.error.issues) {
        issues.push({ file, path: issue.path.map(pathKey), message: issue.message });
      }
    }
  }
  if (unreadable.size > 0 || issues.length > 0) return { content: null, issues };
  const content: Content = {
    categories: parsed['categories.yaml'] as Category[],
    collections: parsed['collections.yaml'] as Collection[],
    picks: parsed['picks.yaml'] as EditorsPick[],
    packages: parsed['packages.yaml'] as Record<string, PackageEditorial>,
    overrides: parsed['overrides.yaml'] as Overrides,
  };
  return { content, issues: crossCheck(content) };
}

/** Validates already-parsed YAML, keyed by file name; a missing file is an empty one. */
export function parseContent(raw: RawContent): ContentReport {
  return parseFiles(raw, new Set());
}

function pathKey(key: PropertyKey): string | number {
  return typeof key === 'number' ? key : String(key);
}

/** `[2].packages[5].id`, `rectangle.tagline`. */
export function formatPath(issuePath: IssuePath): string {
  return issuePath
    .map((key, i) => (typeof key === 'number' ? `[${key}]` : i === 0 ? key : `.${key}`))
    .join('');
}

/** `content/categories.yaml:57 [2].packages[5].id: Unknown package "rectangel".` */
export function formatIssue(issue: ContentIssue, dir = 'content'): string {
  const where = path.join(dir, issue.file) + (issue.line === undefined ? '' : `:${issue.line}`);
  const at = issue.path.length > 0 ? ` ${formatPath(issue.path)}` : '';
  return `${where}${at}: ${issue.message}`;
}

export class ContentError extends Error {
  readonly issues: ContentIssue[];

  constructor(issues: ContentIssue[], dir: string) {
    const count = issues.length === 1 ? '1 problem' : `${issues.length} problems`;
    super(
      `Invalid content in ${dir}/ (${count}):\n` +
        issues.map((issue) => `  ${formatIssue(issue, dir)}`).join('\n'),
    );
    this.name = 'ContentError';
    this.issues = issues;
  }
}

interface Source {
  doc: Document;
  lineCounter: LineCounter;
}

export interface InspectedContent extends ContentReport {
  /** 1-based line of a path in a file, or of its closest parent that exists. */
  locate: (file: ContentFile, issuePath: IssuePath) => number | undefined;
}

/**
 * Reads and validates content/ without throwing on content problems: returns every issue,
 * with line numbers, and a way to point later issues at lines.
 */
export function inspectContent(dir = 'content'): InspectedContent {
  const issues: ContentIssue[] = [];
  const raw: RawContent = {};
  const unreadable = new Set<ContentFile>();
  const sources = new Map<ContentFile, Source>();

  for (const file of CONTENT_FILES) {
    let text: string;
    try {
      text = readFileSync(path.join(dir, file), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Only categories are required; a missing file is an empty one.
      if (file === 'categories.yaml') {
        issues.push({ file, path: [], message: 'File not found.' });
        unreadable.add(file);
      }
      continue;
    }
    const lineCounter = new LineCounter();
    const doc = parseDocument(text, { lineCounter });
    if (doc.errors.length > 0) {
      for (const error of doc.errors) {
        const message = error.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
        issues.push({
          file,
          path: [],
          line: error.linePos?.[0].line,
          message: `Invalid YAML: ${message}`,
        });
      }
      unreadable.add(file);
      continue;
    }
    raw[file] = doc.toJS();
    sources.set(file, { doc, lineCounter });
  }

  const locate = (file: ContentFile, issuePath: IssuePath): number | undefined => {
    const source = sources.get(file);
    if (!source) return undefined;
    for (let n = issuePath.length; n >= 0; n--) {
      const node = n === 0 ? source.doc.contents : source.doc.getIn(issuePath.slice(0, n), true);
      if (isNode(node) && node.range) return source.lineCounter.linePos(node.range[0]).line;
    }
    return undefined;
  };

  const report = parseFiles(raw, unreadable);
  issues.push(...report.issues);
  return {
    content: report.content,
    issues: issues.map((issue) => ({
      ...issue,
      line: issue.line ?? locate(issue.file, issue.path),
    })),
    locate,
  };
}

/** Reads and validates every file in content/. Throws a ContentError listing every problem. */
export function loadContent(dir = 'content'): Content {
  const { content, issues } = inspectContent(dir);
  if (!content || issues.length > 0) throw new ContentError(issues, dir);
  return content;
}
