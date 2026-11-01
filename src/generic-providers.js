/**
 * Generic provider declarations: any OpenAI- or Anthropic-compatible API can be used
 * without touching the source catalog.
 *
 *   DZ23_PROVIDERS=myapi,teamgateway
 *   DZ23_MYAPI_BASE_URL=https://api.example.com/v1
 *   DZ23_MYAPI_API_KEY=sk-...
 *   DZ23_MYAPI_MODEL=fast-model
 *   DZ23_MYAPI_PROTOCOL=openai            # openai (default) | anthropic
 *   DZ23_MYAPI_TIER=mixed                 # paid | low-cost | mixed | free-tier | local
 *   DZ23_MYAPI_LABEL=Example API          # optional, human display only
 *
 * Secrets follow the same convention as the built-in catalog: the key may come from
 * DZ23_<NAME>_API_KEY directly or from DZ23_<NAME>_API_KEY_FILE pointing at a file.
 */

const NAME_PATTERN = /^[a-z][a-z0-9_]{1,30}$/;
const PROTOCOLS = new Set(['openai', 'anthropic']);
const TIERS = new Set(['paid', 'low-cost', 'mixed', 'free-tier', 'local']);

/** Capabilities this adapter surface implements — identical to the built-in catalog entries. */
const capabilities = () => ({
  text: true,
  coding: 'model-dependent',
  reasoning: 'model-dependent',
  vision: false,
  tools: false,
  embeddings: false,
  streaming: false,
});

/** Read a trimmed, non-empty string from the environment. */
function value(env, name) {
  const raw = env[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

/**
 * Expand DZ23_PROVIDERS into provider definitions understood by providerRegistry().
 * Returns an empty object when no generic provider is declared.
 * Throws on a malformed name, missing base URL, or unknown protocol/tier so that a
 * typo in .env fails loudly instead of silently disabling a provider.
 */
export function genericProviderDefs(env = process.env) {
  const declared = value(env, 'DZ23_PROVIDERS');
  if (!declared) return {};

  const defs = {};
  for (const entry of declared.split(',')) {
    const name = entry.trim().toLowerCase();
    if (!name) continue;
    if (!NAME_PATTERN.test(name)) {
      throw new Error(`Invalid provider name "${name}" in DZ23_PROVIDERS: use lowercase letters, digits and underscores, starting with a letter (max 31 chars)`);
    }
    if (defs[name]) continue;

    const prefix = `DZ23_${name.toUpperCase()}_`;
    const baseURL = value(env, `${prefix}BASE_URL`);
    if (!baseURL) {
      throw new Error(`Generic provider "${name}" needs ${prefix}BASE_URL`);
    }

    const protocol = (value(env, `${prefix}PROTOCOL`) || 'openai').toLowerCase();
    if (!PROTOCOLS.has(protocol)) {
      throw new Error(`Generic provider "${name}" has unsupported ${prefix}PROTOCOL "${protocol}": use openai or anthropic`);
    }

    const tier = (value(env, `${prefix}TIER`) || 'mixed').toLowerCase();
    if (!TIERS.has(tier)) {
      throw new Error(`Generic provider "${name}" has unsupported ${prefix}TIER "${tier}": use ${[...TIERS].join(', ')}`);
    }

    defs[name] = {
      baseURL,
      keyName: `${prefix}API_KEY`,
      defaultModel: value(env, `${prefix}MODEL`),
      tier,
      protocol,
      location: tier === 'local' ? 'local' : 'cloud',
      capabilities: capabilities(),
      label: value(env, `${prefix}LABEL`) || name,
      generic: true,
    };
  }
  return defs;
}
