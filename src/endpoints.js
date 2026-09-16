import net from 'node:net';

/** Hostnames the operator declared private (DZ23_PRIVATE_HOSTS), lowercase. */
export function privateHostList(raw = '') {
  return String(raw || '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
}

/**
 * The local exemption follows the endpoint, not the provider name: CUSTOM_BASE_URL pointing at a public API is not
 * local. Only literal loopback/private IPs, `localhost`, Docker's host alias and hostnames the operator lists in
 * DZ23_PRIVATE_HOSTS count as private. Single-label and `.local` names are not trusted by default: on Windows they
 * resolve through LLMNR, NetBIOS or mDNS, which any host on the LAN can answer. A private gateway that forwards to
 * paid clouds still counts as local, so its paid models belong in DZ23_ROTATION only deliberately.
 */
export function isPrivateEndpoint(baseURL, extraHosts = []) {
  let host;
  try { host = new URL(baseURL).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch { return false; }
  if (!host) return false;
  const version = net.isIP(host);
  if (version === 4) {
    const [a, b] = host.split('.').map(Number);
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (version === 6) return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host);
  return host === 'localhost' || host === 'host.docker.internal' || extraHosts.includes(host);
}
