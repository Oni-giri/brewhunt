// Checks content/ against the package list the data pipeline writes.
//
//   node scripts/content/validate.ts [--packages data/site/packages.json] [--content content]
//
// Errors exit with 1, warnings don't. Without a package list (before the data branch exists)
// only the schema and the references between content files are checked.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { caskCategoriesSchema, unmappedCategories } from '../data/categories.ts';
import type { CaskCategories } from '../data/categories.ts';
import type { Package } from '../data/types.ts';
import { CONTENT_FILES, formatIssue, inspectContent } from './schema.ts';
import type { Content, ContentFile, ContentIssue, IssuePath } from './schema.ts';

export const DEFAULT_PACKAGES = 'data/site/packages.json';
/** Categories with fewer packages than this get a warning. */
export const MIN_CATEGORY_SIZE = 6;

/** The fields of a `Package` the checks need. */
export type PackageInfo = Pick<Package, 'id' | 'deprecated' | 'disabled'> &
  Partial<Pick<Package, 'name' | 'token' | 'kind' | 'library' | 'aliases' | 'oldNames'>>;

export interface ValidationResult {
  errors: ContentIssue[];
  warnings: ContentIssue[];
}

interface Reference {
  id: string;
  file: ContentFile;
  path: IssuePath;
  /** Shown in a list (category, collection, pick), so hiding it matters. */
  listed: boolean;
}

function references(content: Content): Reference[] {
  const refs: Reference[] = [];
  content.categories.forEach((category, c) => {
    category.packages.forEach((p, i) => {
      refs.push({
        id: p.id,
        file: 'categories.yaml',
        path: [c, 'packages', i, 'id'],
        listed: true,
      });
    });
  });
  content.collections.forEach((collection, c) => {
    collection.packages.forEach((id, i) => {
      refs.push({ id, file: 'collections.yaml', path: [c, 'packages', i], listed: true });
    });
  });
  content.picks.forEach((pick, i) => {
    refs.push({ id: pick.id, file: 'picks.yaml', path: [i, 'id'], listed: true });
  });
  for (const id of Object.keys(content.packages)) {
    refs.push({ id, file: 'packages.yaml', path: [id], listed: false });
  }
  const { library, hidden } = content.overrides;
  library.show.forEach((id, i) => {
    refs.push({ id, file: 'overrides.yaml', path: ['library', 'show', i], listed: false });
  });
  library.hide.forEach((id, i) => {
    refs.push({ id, file: 'overrides.yaml', path: ['library', 'hide', i], listed: false });
  });
  hidden.forEach((id, i) => {
    refs.push({ id, file: 'overrides.yaml', path: ['hidden', i], listed: false });
  });
  return refs;
}

/** Edit distance, giving up (returning max + 1) once it's over `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
    }
    if (Math.min(...current) > max) return max + 1;
    previous = current;
  }
  return previous[b.length];
}

const simplify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Packages the owner may have meant: same app name ("ice"), same token in a tap, or a typo. */
function suggestions(id: string, packages: readonly PackageInfo[]): string[] {
  const key = simplify(id);
  const byName = packages.filter(
    (p) =>
      (p.name !== undefined && simplify(p.name) === key) ||
      (p.token !== undefined && simplify(p.token) === key),
  );
  const close =
    id.length < 4 ? [] : packages.filter((p) => !byName.includes(p) && distance(id, p.id, 2) <= 2);
  return [...byName, ...close].slice(0, 3).map((p) => p.id);
}

function unknownMessage(id: string, packages: readonly PackageInfo[]): string {
  const options = suggestions(id, packages);
  const hint =
    options.length === 0 ? '' : ` Did you mean ${options.map((o) => `"${o}"`).join(' or ')}?`;
  return `Unknown package "${id}".${hint}`;
}

/**
 * Checks content against the package list. Without one (`null`), runs only the checks that
 * don't need it. Schema problems and references between content files are `inspectContent`'s.
 */
export function validateContent(
  content: Content,
  packages: readonly PackageInfo[] | null = null,
  /** CaskFlow's category names by id (data/site/caskflow-categories.json), when there. */
  caskflow: CaskCategories | null = null,
): ValidationResult {
  const errors: ContentIssue[] = [];
  const warnings: ContentIssue[] = [];
  const byId = packages ? new Map(packages.map((p) => [p.id, p])) : null;
  const hidden = new Set(content.overrides.hidden);
  const libraryShow = new Set(content.overrides.library.show);

  for (const ref of references(content)) {
    const at = { file: ref.file, path: ref.path };
    if (ref.listed && hidden.has(ref.id)) {
      warnings.push({
        ...at,
        message: `"${ref.id}" is in overrides.yaml hidden, so it won't show.`,
      });
    }
    if (!byId || !packages) continue;
    const pkg = byId.get(ref.id);
    if (!pkg) {
      errors.push({ ...at, message: unknownMessage(ref.id, packages) });
    } else if (pkg.disabled) {
      errors.push({ ...at, message: `"${ref.id}" is disabled in Homebrew: remove it.` });
    } else if (pkg.deprecated) {
      warnings.push({ ...at, message: `"${ref.id}" is deprecated in Homebrew.` });
    }
    if (pkg?.library && ref.listed && !libraryShow.has(ref.id)) {
      warnings.push({
        ...at,
        message: `"${ref.id}" is flagged as a library, so charts and discovery hide it. Add it to library.show in overrides.yaml to list it.`,
      });
    }
    if (pkg?.kind === 'cask' && ref.file === 'overrides.yaml' && ref.path[0] === 'library') {
      warnings.push({
        ...at,
        message: `"${ref.id}" is a cask: only formulae are flagged as libraries, so this does nothing.`,
      });
    }
  }

  if (byId) {
    for (const [id, editorial] of Object.entries(content.packages)) {
      const pkg = byId.get(id);
      if (!pkg) continue;
      if (editorial.type && pkg.kind === 'formula') {
        errors.push({
          file: 'packages.yaml',
          path: [id, 'type'],
          message: `"${id}" is a formula: formulae are always command-line tools, so \`type\` only applies to casks.`,
        });
      }
      const linked = new Set([pkg.token, ...(pkg.aliases ?? []), ...(pkg.oldNames ?? [])]);
      editorial.keywords?.forEach((keyword, i) => {
        if (!linked.has(keyword)) return;
        warnings.push({
          file: 'packages.yaml',
          path: [id, 'keywords', i],
          message: `Homebrew already links "${keyword}" to "${id}" (name, alias or old name).`,
        });
      });
    }
  }

  if (caskflow) {
    const mapped = new Set<string>();
    content.categories.forEach((category, c) => {
      category.caskflow.forEach((id, i) => {
        mapped.add(id);
        if (!(id in caskflow.names)) {
          warnings.push({
            file: 'categories.yaml',
            path: [c, 'caskflow', i],
            message: `CaskFlow has no category "${id}" (it has ${Object.keys(caskflow.names).join(', ')}).`,
          });
        }
      });
    });
    // Apps filed under an unmapped id would quietly lose their category. The data job keeps
    // yesterday's file when CaskFlow adds one, so this catches an edit that drops a mapping.
    const unmapped = unmappedCategories(caskflow, mapped);
    for (const [id, name] of Object.entries(caskflow.names)) {
      if (mapped.has(id)) continue;
      const casks = unmapped.get(id);
      (casks ? errors : warnings).push({
        file: 'categories.yaml',
        path: [],
        message: casks
          ? `CaskFlow's "${id}" (${name}) files ${plural(casks, 'app')}: add it to a category's caskflow list.`
          : `CaskFlow's "${id}" (${name}) isn't in any category's caskflow list (it files no apps yet).`,
      });
    }
  }

  content.categories.forEach((category, c) => {
    // Filled from CaskFlow: the editorial list only leads it.
    if (category.caskflow.length > 0) return checkSubcategories(category, c);
    const usable = category.packages.filter((p) => {
      if (hidden.has(p.id)) return false;
      if (!byId) return true;
      const pkg = byId.get(p.id);
      return pkg !== undefined && !pkg.disabled;
    });
    if (usable.length < MIN_CATEGORY_SIZE) {
      warnings.push({
        file: 'categories.yaml',
        path: [c, 'packages'],
        message: `"${category.slug}" lists ${usable.length} usable packages; aim for at least ${MIN_CATEGORY_SIZE}.`,
      });
    }
    checkSubcategories(category, c);
  });

  function checkSubcategories(category: Content['categories'][number], c: number) {
    if (category.subcategories.length === 0) return;
    category.subcategories.forEach((sub, s) => {
      if (!category.packages.some((p) => p.sub === sub.slug)) {
        warnings.push({
          file: 'categories.yaml',
          path: [c, 'subcategories', s],
          message: `No package in "${category.slug}" uses the sub-category "${sub.slug}".`,
        });
      }
    });
    category.packages.forEach((p, i) => {
      if (p.sub === undefined) {
        warnings.push({
          file: 'categories.yaml',
          path: [c, 'packages', i],
          message: `"${p.id}" has no sub-category, so it only shows under All.`,
        });
      }
    });
  }

  return { errors, warnings };
}

const packageListSchema = z.array(
  z.looseObject({
    id: z.string(),
    name: z.string().optional(),
    token: z.string().optional(),
    kind: z.enum(['formula', 'cask']).optional(),
    deprecated: z.boolean(),
    disabled: z.boolean(),
    library: z.boolean().optional(),
    aliases: z.array(z.string()).optional(),
    oldNames: z.array(z.string()).optional(),
  }),
);

/** Reads the pipeline's package list (an array of `Package`). */
export function readPackages(file: string): PackageInfo[] {
  const result = packageListSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(
      `${file} isn't a list of packages: ${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
  }
  return result.data;
}

// --- CLI ---

const USAGE = `Usage: node scripts/content/validate.ts [--packages ${DEFAULT_PACKAGES}] [--content content]`;

function plural(n: number, word: string, words = `${word}s`): string {
  return `${n} ${n === 1 ? word : words}`;
}

function byPosition(a: ContentIssue, b: ContentIssue): number {
  const file = CONTENT_FILES.indexOf(a.file) - CONTENT_FILES.indexOf(b.file);
  return file !== 0 ? file : (a.line ?? 0) - (b.line ?? 0);
}

function printIssues(title: string, issues: ContentIssue[], dir: string): void {
  if (issues.length === 0) return;
  console.log(`\n${title} (${issues.length}):`);
  for (const issue of [...issues].sort(byPosition)) console.log(`  ${formatIssue(issue, dir)}`);
}

function summary(content: Content): string {
  const ids = new Set(content.categories.flatMap((c) => c.packages.map((p) => p.id)));
  const { library, hidden } = content.overrides;
  return (
    `Content: ${plural(content.categories.length, 'category', 'categories')} ` +
    `(${plural(ids.size, 'package')}), ${plural(content.collections.length, 'collection')}, ` +
    `${plural(content.picks.length, 'pick')}, ${plural(Object.keys(content.packages).length, 'package note')}, ` +
    `overrides: ${library.show.length} library.show, ${library.hide.length} library.hide, ${hidden.length} hidden.`
  );
}

export function main(args: string[]): number {
  let options;
  try {
    options = parseArgs({
      args,
      options: {
        packages: { type: 'string' },
        content: { type: 'string', default: 'content' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values;
  } catch (error) {
    console.error(`${(error as Error).message}\n${USAGE}`);
    return 1;
  }
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  const dir = options.content;

  const { content, issues, locate } = inspectContent(dir);
  if (!content) {
    printIssues('Errors', issues, dir);
    console.log(`\nInvalid: ${plural(issues.length, 'error')}. Package ids weren't checked.`);
    return 1;
  }
  console.log(summary(content));

  const packagesFile = options.packages ?? DEFAULT_PACKAGES;
  let packages: PackageInfo[] | null = null;
  if (existsSync(packagesFile)) {
    try {
      packages = readPackages(packagesFile);
    } catch (error) {
      console.log(`\nError: ${(error as Error).message}`);
      return 1;
    }
    console.log(
      `Packages: checked against ${packagesFile} (${plural(packages.length, 'package')}).`,
    );
  } else {
    const hint = options.packages === undefined ? ' Pass --packages to use another list.' : '';
    console.log(
      `Packages: ${packagesFile} not found, so package ids weren't checked: only the schema and ` +
        `the references between content files.${hint}`,
    );
  }

  // CaskFlow's categories sit next to the package list (scripts/data/categories.ts).
  const caskflowFile = join(dirname(packagesFile), 'caskflow-categories.json');
  let caskflow: CaskCategories | null = null;
  if (existsSync(caskflowFile)) {
    try {
      caskflow = caskCategoriesSchema.parse(JSON.parse(readFileSync(caskflowFile, 'utf8')));
    } catch (error) {
      console.log(
        `\nError: ${caskflowFile} isn't a CaskFlow categories file: ${(error as Error).message}`,
      );
      return 1;
    }
    console.log(`CaskFlow categories: checked against ${caskflowFile}.`);
  }

  const result = validateContent(content, packages, caskflow);
  const withLines = (list: ContentIssue[]) =>
    list.map((issue) => ({ ...issue, line: locate(issue.file, issue.path) }));
  // Broken references between content files, then the package checks.
  const errors = [...issues, ...withLines(result.errors)];
  const warnings = withLines(result.warnings);
  printIssues('Errors', errors, dir);
  printIssues('Warnings', warnings, dir);

  if (errors.length > 0) {
    console.log(
      `\nInvalid: ${plural(errors.length, 'error')}, ${plural(warnings.length, 'warning')}.`,
    );
    return 1;
  }
  console.log(
    warnings.length > 0 ? `\nValid, with ${plural(warnings.length, 'warning')}.` : '\nValid.',
  );
  return 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2));
}
