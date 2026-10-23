/** Transport policy is shared by settings and the privileged request boundary. */
export function providerEndpointIssue(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return "Endpoint must not contain credentials, a query or a fragment.";
    if (url.protocol === "https:") return null;
    if (url.protocol === "http:" && isLoopback(url.hostname)) return null;
  } catch { /* Report an authored validation result below. */ }
  return "Use HTTPS for a remote provider. HTTP is allowed only on this computer's loopback address.";
}

export function isAllowedProviderRequest(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(host);
}
