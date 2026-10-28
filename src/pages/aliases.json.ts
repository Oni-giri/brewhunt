// Old names and formula aliases → current package id, for the 404 page to redirect
// /app/<old-name> (Cloudflare's _redirects file is capped at 2,000 rules).
import { getCatalog } from '../lib/catalog';

export function GET() {
  const { entries, byId } = getCatalog();
  const aliases: Record<string, string> = {};
  for (const entry of entries) {
    if (!entry.hasPage) continue;
    for (const name of [...entry.oldNames, ...entry.aliases]) {
      if (!byId.get(name)?.hasPage && !(name in aliases)) aliases[name] = entry.id;
    }
  }
  return new Response(JSON.stringify(aliases), { headers: { 'content-type': 'application/json' } });
}
