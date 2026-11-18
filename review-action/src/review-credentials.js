'use strict';

// The six caller secrets stay fixed: a key and an API base per lane slot. A slot that holds two
// providers carries a versioned, provider-named bundle; a slot with one provider is a plain value,
// which may list several keys of that provider, one per line (separate accounts).
// `keySlots` maps each slot id to its providers, as the repository config's key_slots does.
function readCredentials(keySlots, env, maskSecret = () => {}) {
  const slots = new Map();
  const keysOf = (value) => String(value || '').split(/\r?\n/).map((key) => key.trim()).filter(Boolean);
  const credential = (key, base) => {
    const keys = keysOf(key);
    for (const value of keys) maskSecret(value);
    return { apiKey: keys[0], keys, baseUrl: String(base || '').replace(/\/$/, '') };
  };
  const envelope = (raw, providers) => {
    const value = JSON.parse(raw);
    if (!value || value.schema_version !== 1 || Object.keys(value).sort().join(',') !== 'providers,schema_version'
      || !value.providers || Array.isArray(value.providers)
      || Object.keys(value.providers).sort().join(',') !== [...providers].sort().join(',')
      || providers.some((provider) => typeof value.providers[provider] !== 'string' || !value.providers[provider].trim())) {
      throw new Error('Invalid credential bundle');
    }
    return value.providers;
  };
  for (const [id, providers] of Object.entries(keySlots || {})) {
    const key = env[`LANE_${id}_KEY`] || '';
    const base = env[`LANE_${id}_API_BASE`] || '';
    const profiles = new Map();
    try {
      if (providers.length > 1) {
        if (!key && !base) {
          for (const provider of providers) profiles.set(provider, credential('', ''));
        } else {
          try {
            const keys = envelope(key, providers);
            for (const provider of providers) {
              for (const value of keysOf(keys[provider])) maskSecret(value);
            }
            const bases = envelope(base, providers);
            for (const provider of providers) {
              const keysForProvider = keysOf(keys[provider]);
              profiles.set(provider, { apiKey: keysForProvider[0], keys: keysForProvider, baseUrl: bases[provider].trim().replace(/\/$/, '') });
            }
            for (const { baseUrl } of profiles.values()) {
              const url = new URL(baseUrl);
              if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid endpoint');
            }
          } catch {
            // Never include JSON parser errors: they may quote the secret input.
            throw new Error(`Lane ${id} requires matching version-1 provider credential bundles; no requests were sent.`);
          }
        }
      } else {
        if (key.trim().startsWith('{') || base.trim().startsWith('{')) {
          throw new Error(`Lane ${id} does not configure provider credential bundles; no requests were sent.`);
        }
        profiles.set(providers[0], credential(key, base));
      }
    } catch {
      // A bad slot disables only the routes that use it. Independent lanes may still meet the
      // quorum; no profile may borrow a different provider's key.
      profiles.clear();
      for (const provider of providers) {
        profiles.set(provider, { apiKey: undefined, keys: [], baseUrl: '', invalid: true });
      }
    }
    slots.set(id, profiles);
  }
  return (slotId, provider) => slots.get(slotId)?.get(provider);
}

module.exports = { readCredentials };
