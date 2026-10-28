// The chart periods: one static page each (/charts, /charts/90-days, /charts/1-year).

export const PERIODS = [
  { slug: undefined, key: 'd30', label: '30 days', href: '/charts' },
  { slug: '90-days', key: 'd90', label: '90 days', href: '/charts/90-days' },
  { slug: '1-year', key: 'd365', label: '1 year', href: '/charts/1-year' },
] as const;

export type Period = (typeof PERIODS)[number];
