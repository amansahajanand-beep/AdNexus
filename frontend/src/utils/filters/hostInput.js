/**
 * Manual host entry for filters that accept hosts the loaded list does not offer (e.g. a subdomain that is not in the
 * inventory picker yet). Accepts what people paste: "https://www.Finance2.Example.com/page" -> "finance2.example.com".
 */
export function normalizeHostInput(raw) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // protocol
    .replace(/[/?#].*$/, '') // path, query, fragment
    .replace(/:\d+$/, '') // port
    .replace(/^www\./, '')
    .replace(/\.+$/, '');
}

/** A hostname with at least one dot, letters/digits/hyphens per label. */
export function isValidHost(host) {
  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(String(host || ''));
}
