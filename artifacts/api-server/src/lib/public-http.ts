import { lookup as dnsLookup } from "dns/promises";

type LookupResult = { address: string };
type LookupAll = (
  hostname: string,
  options: { all: true; verbatim: true },
) => Promise<LookupResult[]>;

export type PublicHttpDependencies = {
  fetch?: typeof globalThis.fetch;
  lookup?: LookupAll;
};

export function buildArtifactFetchInit(
  isTrustedInternalArtifact: boolean,
  cookie: string,
  internalSecret: string,
): RequestInit {
  if (!isTrustedInternalArtifact) return {};
  return {
    headers: {
      Cookie: cookie,
      "X-Internal-Agent": internalSecret,
    },
  };
}

export function isInternalHost(hostname: string): boolean {
  const host = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;

  if (host === "localhost" || host === "::1" || host === "0.0.0.0" || host === "::") {
    return true;
  }

  const v4parts = host.split(".").map(Number);
  if (
    v4parts.length === 4
    && v4parts.every(number => Number.isFinite(number) && number >= 0 && number <= 255)
  ) {
    if (v4parts[0] === 127 || v4parts[0] === 10 || v4parts[0] === 0) return true;
    if (v4parts[0] === 172 && v4parts[1] >= 16 && v4parts[1] <= 31) return true;
    if (v4parts[0] === 192 && v4parts[1] === 168) return true;
    if (v4parts[0] === 169 && v4parts[1] === 254) return true;
    if (v4parts[0] === 100 && v4parts[1] >= 64 && v4parts[1] <= 127) return true;
    return false;
  }

  if (host.includes(":")) {
    const lower = host.toLowerCase().replace(/%25.*$/, "").replace(/%.*$/, "");
    if (lower.startsWith("fe80:") || /^f[cd][0-9a-f]{2}:/.test(lower) || lower.startsWith("ff")) {
      return true;
    }
    const mapped = /^::ffff:(.+)$/.exec(lower);
    if (mapped) {
      if (mapped[1].includes(".")) return isInternalHost(mapped[1]);
      const words = mapped[1].split(":");
      if (words.length === 2 && words.every(word => /^[0-9a-f]{1,4}$/.test(word))) {
        const high = Number.parseInt(words[0], 16);
        const low = Number.parseInt(words[1], 16);
        return isInternalHost(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
      }
      return true;
    }
  }

  return false;
}

export async function assertPublicHttpUrl(
  urlValue: string,
  dependencies: PublicHttpDependencies = {},
): Promise<URL> {
  const parsed = new URL(urlValue);
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Only http/https URLs can be read.");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    isInternalHost(hostname)
    || hostname.endsWith(".local")
    || hostname === "metadata.google.internal"
  ) {
    throw new Error("Cannot read internal/private network URLs.");
  }
  const lookup = dependencies.lookup ?? (dnsLookup as LookupAll);
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(address => isInternalHost(address.address))) {
    throw new Error("Cannot read a hostname that resolves to an internal/private network.");
  }
  return parsed;
}

export async function fetchPublicUrl(
  urlValue: string,
  init: RequestInit = {},
  maxRedirects = 5,
  dependencies: PublicHttpDependencies = {},
): Promise<globalThis.Response> {
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  let current = await assertPublicHttpUrl(urlValue, dependencies);
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const response = await fetchImpl(current, { ...init, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) throw new Error("Redirect response did not include a location.");
    if (redirectCount === maxRedirects) throw new Error("Too many redirects.");
    current = await assertPublicHttpUrl(new URL(location, current).toString(), dependencies);
  }
  throw new Error("Too many redirects.");
}
