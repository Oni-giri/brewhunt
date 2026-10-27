// Links shared by the header nav and the mobile menu. Routes that don't exist yet point at
// where they will live (see docs/PRODUCT.md); "Categories" has no index route, so it targets
// the "Browse by what you need" section on /discover.
export interface NavLink {
  label: string;
  href: string;
  /** Path prefix that marks this link as the current page. */
  match: string;
}

export const mainNav: NavLink[] = [
  { label: 'Discover', href: '/discover', match: '/discover' },
  { label: 'Top charts', href: '/charts', match: '/charts' },
  { label: 'Categories', href: '/discover#categories', match: '/category' },
  { label: 'New', href: '/new', match: '/new' },
  { label: 'For developers', href: '/#developers', match: '/developers' },
];

/** Page path without the `.html` (build.format: 'file') or trailing slash, e.g. `/discover`. */
export function cleanPath(pathname: string): string {
  const path = pathname.replace(/\.html$/, '').replace(/\/+$/, '');
  return path === '' || path === '/index' ? '/' : path;
}

export function isCurrent(link: NavLink, pathname: string): boolean {
  const path = cleanPath(pathname);
  return path === link.match || path.startsWith(`${link.match}/`);
}
