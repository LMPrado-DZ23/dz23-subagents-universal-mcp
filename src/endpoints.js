import net from 'node:net';

/**
 * The local exemption follows the endpoint, not the provider name: CUSTOM_BASE_URL pointing at a public
 * API is not local. A loopback or private-network gateway that forwards to paid clouds still counts as
 * local, so such gateways should be used with DZ23_ROTATION.
 */
export function isPrivateEndpoint(baseURL) {
  let host;
  try { host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host) return false;
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (version === 6) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  // Names: loopback, Docker's host alias, single-label LAN or compose service names (e.g. `ollama`) and mDNS `.local`.
  // Dotted public-looking names such as `10.0.0.1.evil.com` or `127.0.0.1.nip.io` are not private.
  return host === 'localhost' || host === 'host.docker.internal' || !host.includes('.') || host.endsWith('.local');
}
