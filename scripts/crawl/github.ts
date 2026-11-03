// What the crawler asks GitHub about a repository: whether it's a fork, its homepage (to accept a
// repository linked from a package's homepage), its owner (for the organisation's avatar), its
// README text and revision (for screenshots and the summary) and its licence (recorded with each
// asset). One GraphQL query per BATCH repositories, one at a time, stopping before the hourly
// budget runs out. An organisation's website is where its logo is when the tool has none of its
// own (find-logos.ts). GitHub's API is a fixed endpoint, so this doesn't go through the
// SafeFetcher; the README's own links do.

/** Repositories per query: smaller than repos.ts's 50, since each brings its README. */
export const BATCH = 20;
/** README text kept per repository. */
export const README_MAX_CHARS = 200_000;
const ENDPOINT = 'https://api.github.com/graphql';
const README_PATHS = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README'];

export interface RepoDetails {
  nameWithOwner: string;
  isFork: boolean;
  homepageUrl: string | null;
  owner: {
    login: string;
    isOrganization: boolean;
    avatarUrl: string | null;
    /** An organisation's website; null for a user. */
    websiteUrl: string | null;
  };
  readme: string | null;
  /** The README blob's id: the revision a screenshot taken from it comes from. */
  readmeRevision: string | null;
  /** The repository's licence as an SPDX id; null when GitHub doesn't recognise one. */
  licence: string | null;
}

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

export function detailsQuery(keys: readonly string[]): {
  query: string;
  variables: Record<string, string>;
} {
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  keys.forEach((key, i) => {
    const [owner, name] = key.split('/');
    if (!OWNER.test(owner ?? '') || !NAME.test(name ?? ''))
      throw new Error(`not a repository: ${key}`);
    variables[`o${i}`] = owner;
    variables[`n${i}`] = name;
    declarations.push(`$o${i}: String!, $n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { ...F }`);
  });
  const readmes = README_PATHS.map(
    (path, i) => `m${i}: object(expression: "HEAD:${path}") { ... on Blob { oid text } }`,
  ).join(' ');
  const query = `query(${declarations.join(', ')}) {
  rateLimit { cost remaining }
  ${fields.join('\n  ')}
}
fragment F on Repository {
  nameWithOwner isFork homepageUrl
  licenseInfo { spdxId }
  owner { __typename login avatarUrl(size: 256) ... on Organization { websiteUrl } }
  ${readmes}
}`;
  return { query, variables };
}

interface Node {
  nameWithOwner: string;
  isFork: boolean;
  homepageUrl: string | null;
  owner: {
    __typename: string;
    login: string;
    avatarUrl: string | null;
    websiteUrl?: string | null;
  };
  licenseInfo: { spdxId: string | null } | null;
  [readme: `m${number}`]: { oid?: string; text?: string | null } | null;
}

export function readDetails(
  keys: readonly string[],
  data: Record<string, unknown>,
): Map<string, RepoDetails | null> {
  const out = new Map<string, RepoDetails | null>();
  keys.forEach((key, i) => {
    const node = data[`r${i}`] as Node | null | undefined;
    if (node === undefined) return;
    if (node === null) return out.set(key, null);
    const blob = README_PATHS.map((_, j) => node[`m${j}`]).find((b) => typeof b?.text === 'string');
    const readme = blob?.text ?? null;
    const spdx = node.licenseInfo?.spdxId;
    out.set(key, {
      nameWithOwner: node.nameWithOwner,
      isFork: node.isFork,
      homepageUrl: node.homepageUrl || null,
      owner: {
        login: node.owner.login,
        isOrganization: node.owner.__typename === 'Organization',
        avatarUrl: node.owner.avatarUrl,
        websiteUrl: node.owner.websiteUrl || null,
      },
      readme: readme === null ? null : readme.slice(0, README_MAX_CHARS),
      readmeRevision: blob?.oid ?? null,
      // NOASSERTION: a licence file GitHub can't name.
      licence: spdx && spdx !== 'NOASSERTION' ? spdx : null,
    });
  });
  return out;
}

/** Details for each key (null: no such public repository). Keys GitHub didn't answer are missing. */
export async function fetchDetails(
  keys: readonly string[],
  token: string,
  log: (line: string) => void = () => {},
): Promise<Map<string, RepoDetails | null>> {
  const out = new Map<string, RepoDetails | null>();
  let remaining = Infinity;
  let lastCost = 1;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    if (remaining < lastCost * 2) {
      log(`GitHub budget low (${remaining} points): ${keys.length - i} repositories not looked up`);
      break;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            authorization: `bearer ${token}`,
            'content-type': 'application/json',
            'user-agent': 'brewhunt-crawler',
          },
          body: JSON.stringify(detailsQuery(batch)),
          signal: AbortSignal.timeout(60_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {
          data?: Record<string, unknown> & { rateLimit?: { cost: number; remaining: number } };
          errors?: { type?: string; message: string }[];
        };
        if (!body.data) throw new Error(body.errors?.[0]?.message ?? 'no data');
        if (body.data.rateLimit) {
          remaining = body.data.rateLimit.remaining;
          lastCost = Math.max(1, body.data.rateLimit.cost);
        }
        for (const [key, value] of readDetails(batch, body.data)) out.set(key, value);
        break;
      } catch (error) {
        log(
          `GitHub batch ${i / BATCH + 1}: ${(error as Error).message}${attempt === 0 ? ', retrying' : ', skipped'}`,
        );
        if (attempt === 0) await new Promise((done) => setTimeout(done, 5_000));
      }
    }
  }
  return out;
}
