export function normalizeUpdateProxy(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) {
    return undefined;
  }

  const proxy = value.trim();
  let url: URL;
  try {
    url = new URL(proxy);
  } catch {
    throw new Error('Invalid update proxy URL');
  }

  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !url.hostname) {
    throw new Error('Invalid update proxy URL');
  }

  return proxy;
}
