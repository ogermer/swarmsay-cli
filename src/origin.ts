import { CliError, EXIT } from './io.js';

export const DEFAULT_ORIGIN = 'https://swarmsay.com';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', 'host.docker.internal']);

export function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.test');
}

/**
 * The instance to talk to: `--origin`, else `SWARMSAY_ORIGIN`, else swarmsay.com. Normalised to
 * `scheme://host[:port]`. Plain http is refused except for a local development host, because the
 * bearer token travels in every authenticated request.
 */
export function resolveOrigin(flag: string | undefined, env: Record<string, string | undefined>): string {
  const raw = flag ?? env.SWARMSAY_ORIGIN ?? DEFAULT_ORIGIN;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`invalid origin: ${raw} (expected a URL such as ${DEFAULT_ORIGIN})`, EXIT.usage);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new CliError(`invalid origin: ${raw} (only http and https are supported)`, EXIT.usage);
  }
  if (url.protocol === 'http:' && !isLocalHost(url.hostname)) {
    throw new CliError(
      `refusing plain http for ${url.host}: tokens would travel unencrypted. Use https, or a local development host.`,
      EXIT.usage,
    );
  }
  if (url.username || url.password) {
    throw new CliError('invalid origin: credentials in the URL are not supported', EXIT.usage);
  }
  return url.origin;
}
