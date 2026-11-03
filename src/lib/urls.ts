// External links on Brewhunt's pages come from data it doesn't write: Homebrew's homepages,
// GitHub's repositories and, later, crawled pages. Only an absolute web URL without credentials
// is rendered, so a `javascript:` or `data:` URL never becomes a link. Plain `http:` stays: 177
// of Homebrew's homepages use it (Nov 2026), and the scheme isn't the danger.

/** The URL as given when it's a plain web link, else null. */
export function externalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return text;
}
