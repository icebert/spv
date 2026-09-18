/**
 * Why a dataset URL must not be opened, or null when it may be. `#url=` arrives from whoever sent
 * the link, so only http(s) targets are fetched: no `javascript:`, `data:`, `blob:` or `file:`
 * schemes, and no embedded credentials. Relative paths resolve against `base` (the page URL).
 */
export function unsafeUrlReason(url: string, base: string = location.href): string | null {
  const shown = url.length > 80 ? `${url.slice(0, 77)}…` : url;
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return `"${shown}" is not a valid URL.`;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return `Only http(s) URLs can be opened, not ${parsed.protocol.replace(/:$/, '')}: links.`;
  }
  if (parsed.username || parsed.password) return 'URLs with embedded credentials are not opened.';
  return null;
}
