'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-generate-content']);
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ALLOWED_LANES = new Set(['A', 'B', 'C']);
const BUNDLE_PROVIDERS = new Set(['openai', 'command-code', 'opencode-go', 'anthropic']);
// The paid APIs a lane may keep as its last resort behind the two plan providers.
const LAST_RESORT_PROVIDERS = new Set(['anthropic', 'openai']);

function configFileName(repository) {
  const parts = (repository || '').split('/');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository || '')
    || parts.some((part) => part === '.' || part === '..' || part.includes('..'))) {
    throw new Error(`Invalid repository identifier: ${repository || '<empty>'}`);
  }
  return `${repository.replace('/', '__')}.json`;
}

function validateModel(model, location) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error(`${location} must be an object.`);
  }
  if (typeof model.id !== 'string' || !model.id.trim()) {
    throw new Error(`${location}.id must be a non-empty string.`);
  }
  if (typeof model.label !== 'string' || !model.label.trim()) {
    throw new Error(`${location}.label must be a non-empty string.`);
  }
  if (!['full', 'kimi-k3-throttled'].includes(model.context_profile || 'full')) {
    throw new Error(`${location}.context_profile is not supported.`);
  }
  if (!Number.isInteger(model.max_output_tokens) || model.max_output_tokens < 1) {
    throw new Error(`${location}.max_output_tokens must be a positive integer.`);
  }
  if (model.request_timeout_ms !== undefined && (!Number.isInteger(model.request_timeout_ms) || model.request_timeout_ms < 1)) {
    throw new Error(`${location}.request_timeout_ms must be a positive integer when configured.`);
  }
  if (model.omit_max_tokens !== undefined && typeof model.omit_max_tokens !== 'boolean') {
    throw new Error(`${location}.omit_max_tokens must be a boolean.`);
  }
  // Context windows differ by model: a 1M-token model can take far more of a large
  // change than a 256K one, so the patch budget may be raised per model.
  if (model.diff_char_budget !== undefined && (!Number.isInteger(model.diff_char_budget) || model.diff_char_budget < 1)) {
    throw new Error(`${location}.diff_char_budget must be a positive integer when configured.`);
  }
  if (model.reporting_calibration !== undefined && typeof model.reporting_calibration !== 'boolean') {
    throw new Error(`${location}.reporting_calibration must be a boolean.`);
  }
  // A fallback may speak a different protocol than its lane primary; it still uses the lane's key.
  if (model.protocol !== undefined && !ALLOWED_PROTOCOLS.has(model.protocol)) {
    throw new Error(`${location}.protocol is not supported.`);
  }
}

// A cross-provider fallback makes one request through a configured fixed secret slot.
// A label identifies an explicitly different fallback model, not a provider alias.
function validateCrossProvider(config, lane, cross, protocol, location) {
  if (!cross || typeof cross !== 'object' || Array.isArray(cross)
    || Object.keys(cross).some((key) => !['credential_lane', 'credential_provider', 'id', 'label'].includes(key))) {
    throw new Error(`${location} must be an object with only credential_lane and id, optionally credential_provider and label.`);
  }
  if (typeof cross.id !== 'string' || !cross.id.trim()) {
    throw new Error(`${location}.id must be a non-empty string.`);
  }
  if (cross.label !== undefined && (typeof cross.label !== 'string' || !cross.label.trim())) {
    throw new Error(`${location}.label must be a non-empty string.`);
  }
  const target = config.lanes.find((candidate) => candidate?.id === cross.credential_lane);
  if (!target || (cross.credential_lane === lane.id && cross.credential_provider === undefined)) {
    throw new Error(`${location}.credential_lane must name another configured lane.`);
  }
  const provider = cross.credential_provider ?? target.provider;
  if (cross.credential_provider !== undefined
    && (!target.credential_providers?.includes(cross.credential_provider))) {
    throw new Error(`${location}.credential_provider must name a configured provider in the target slot.`);
  }
  if (typeof provider !== 'string' || provider === lane.provider) {
    throw new Error(`${location} must use a provider other than the lane's own.`);
  }
  if (protocol === 'google-generate-content') {
    throw new Error(`${location} is not supported by google-generate-content.`);
  }
  return provider;
}

function validateModelOptions(config, lane, model, location) {
  const protocol = model.protocol ?? lane.protocol;
  if (model.reasoning_effort !== undefined && (protocol !== 'openai-responses'
    || !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.reasoning_effort))) {
    throw new Error(`${location}.reasoning_effort requires openai-responses and a supported effort.`);
  }
  if (model.omit_max_tokens && protocol !== 'openai-chat-completions') {
    throw new Error(`${location}.omit_max_tokens is only supported by openai-chat-completions.`);
  }
  if (model.effort !== undefined) {
    if (protocol !== 'anthropic-messages') throw new Error(`${location}.effort is only supported by anthropic-messages.`);
    if (!ANTHROPIC_EFFORTS.has(model.effort)) throw new Error(`${location}.effort is not supported.`);
  }
  // Claude models with adaptive thinking reject non-default sampling values.
  if (model.temperature !== undefined && protocol === 'anthropic-messages') {
    throw new Error(`${location}.temperature is not supported by anthropic-messages.`);
  }
  // The quota-only overflow became cross_provider; a stale config must not lose it silently.
  if (model.quota_overflow !== undefined) {
    throw new Error(`${location}.quota_overflow was replaced by cross_provider.`);
  }
  if (Array.isArray(model.cross_provider)) {
    if (model.cross_provider.length !== 2) throw new Error(`${location}.cross_provider must list exactly two routes.`);
    const providers = model.cross_provider.map((route, index) =>
      validateCrossProvider(config, lane, route, protocol, `${location}.cross_provider[${index}]`));
    if (new Set(providers).size !== providers.length) throw new Error(`${location}.cross_provider must list distinct providers.`);
  } else if (model.cross_provider !== undefined) {
    validateCrossProvider(config, lane, model.cross_provider, protocol, `${location}.cross_provider`);
  }
  if (model.thinking_level === undefined) return;
  if (protocol !== 'google-generate-content') {
    throw new Error(`${location}.thinking_level is only supported by google-generate-content.`);
  }
  if (!['minimal', 'low', 'medium', 'high'].includes(model.thinking_level)) {
    throw new Error(`${location}.thinking_level is not supported.`);
  }
}

// A lane's last resort (the owner's decision, 2026-11-03): a paid API behind the two plan
// providers, asked only when the primary's own provider and its cross-provider route both report
// a spent quota. It uses the lane's own fixed slot, as the second provider of its bundle, and may
// lead with a first pass on a PR that has none. Its models never cross again.
function validateLastResort(config, lane, location) {
  const last = lane.last_resort;
  if (!last || typeof last !== 'object' || Array.isArray(last)
    || Object.keys(last).some((key) => !['provider', 'key_weights', 'first_pass', 'primary'].includes(key))) {
    throw new Error(`${location}.last_resort must be an object with provider and primary, optionally key_weights and first_pass.`);
  }
  if (!LAST_RESORT_PROVIDERS.has(last.provider) || last.provider === lane.provider
    || !lane.credential_providers?.includes(last.provider)) {
    throw new Error(`${location}.last_resort.provider must be anthropic or openai, configured as the second provider of the lane's own slot.`);
  }
  const cross = lane.primary.cross_provider;
  if (Array.isArray(cross)) throw new Error(`${location}.last_resort requires exactly one cross_provider route.`);
  const crossProvider = cross && (cross.credential_provider ?? config.lanes.find((candidate) => candidate?.id === cross.credential_lane)?.provider);
  if (!crossProvider || crossProvider === last.provider) {
    throw new Error(`${location}.last_resort needs a primary cross_provider route on another plan provider; it serves only when both are spent.`);
  }
  // The gate reads the primary's own two routes, and only Go and Command Code are the plans it sits behind.
  if ([lane.provider, crossProvider].sort().join(',') !== 'command-code,opencode-go') {
    throw new Error(`${location}.last_resort serves only behind opencode-go and command-code: the primary and its cross_provider route must be those two plans.`);
  }
  if (lane.fallbacks.length || lane.first_pass !== undefined) {
    throw new Error(`${location}.last_resort needs a lane without fallbacks or first_pass; its gate judges the primary's two routes alone.`);
  }
  if (last.key_weights !== undefined && (!Array.isArray(last.key_weights) || last.key_weights.length < 2 || last.key_weights.length > 4
    || last.key_weights.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > 100))) {
    throw new Error(`${location}.last_resort.key_weights must be an array of 2 to 4 integers from 1 to 100.`);
  }
  const entries = [[last.primary, `${location}.last_resort.primary`],
    ...(last.first_pass === undefined ? [] : [[last.first_pass, `${location}.last_resort.first_pass`]])];
  // A model inherits the lane's protocol, which belongs to the plan provider; the paid API must speak its own.
  const nativeProtocols = { anthropic: ['anthropic-messages'], openai: ['openai-responses', 'openai-chat-completions'] }[last.provider];
  for (const [model, modelLocation] of entries) {
    validateModel(model, modelLocation);
    if (model.cross_provider !== undefined) throw new Error(`${modelLocation} cannot configure cross_provider; the last resort never crosses.`);
    if (!nativeProtocols.includes(model.protocol ?? lane.protocol)) {
      throw new Error(`${modelLocation} must use a protocol ${last.provider} serves (${nativeProtocols.join(' or ')}); set protocol when the lane's differs.`);
    }
    validateModelOptions(config, lane, model, modelLocation);
  }
  if (last.first_pass !== undefined && last.first_pass.id === last.primary.id) {
    throw new Error(`${location}.last_resort.first_pass must name a model other than its primary.`);
  }
}

function validateConfig(config, repository) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Repository config must be a JSON object.');
  }
  if (config.schema_version !== 1) throw new Error('Unsupported repository config schema_version.');
  if (config.repository !== repository) {
    throw new Error(`Config repository mismatch: expected ${repository}, found ${config.repository || '<empty>'}.`);
  }
  if (!config.review_policy || typeof config.review_policy.system_prompt !== 'string' || !config.review_policy.system_prompt.trim()) {
    throw new Error('review_policy.system_prompt must be a non-empty string.');
  }
  if (config.review_policy.max_attempts !== 1) throw new Error('review_policy.max_attempts must be 1; model retries are disabled.');
  for (const field of ['diff_char_budget', 'request_timeout_ms', 'model_budget_ms', 'max_attempts']) {
    if (!Number.isInteger(config.review_policy[field]) || config.review_policy[field] < 1) {
      throw new Error(`review_policy.${field} must be a positive integer.`);
    }
  }
  for (const field of ['issue_char_budget', 'issue_excerpt_chars', 'description_char_limit']) {
    const value = config.review_policy[field];
    if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
      throw new Error(`review_policy.${field} must be a positive integer when configured.`);
    }
  }
  if (!Array.isArray(config.lanes) || config.lanes.length === 0) {
    throw new Error('Config must contain at least one lane.');
  }

  const minimum = config.review_policy.min_valid_lanes;
  if (minimum !== undefined && (!Number.isInteger(minimum) || minimum < 1 || minimum > config.lanes.length)) {
    throw new Error(`review_policy.min_valid_lanes must be an integer between 1 and the ${config.lanes.length} configured lane(s).`);
  }
  const laneIds = new Set();
  for (const [index, lane] of config.lanes.entries()) {
    const location = `lanes[${index}]`;
    if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new Error(`${location} must be an object.`);
    if (!ALLOWED_LANES.has(lane.id)) throw new Error(`${location}.id must be A, B, or C.`);
    if (laneIds.has(lane.id)) throw new Error(`Lane ${lane.id} is configured more than once.`);
    laneIds.add(lane.id);
    if (typeof lane.provider !== 'string' || !lane.provider.trim()) throw new Error(`${location}.provider must be non-empty.`);
    if (lane.credential_providers !== undefined
      && (!Array.isArray(lane.credential_providers) || lane.credential_providers.length !== 2
        || new Set(lane.credential_providers).size !== 2
        || lane.credential_providers.some((provider) => !BUNDLE_PROVIDERS.has(provider))
        || !lane.credential_providers.includes(lane.provider) || lane.key_weights !== undefined)) {
      throw new Error(`${location}.credential_providers must name two of openai, command-code, opencode-go and anthropic, include the lane provider, and cannot use key_weights.`);
    }
    if (lane.advisory !== undefined && typeof lane.advisory !== 'boolean') throw new Error(`${location}.advisory must be a boolean.`);
    if (lane.resend_unserved !== undefined && typeof lane.resend_unserved !== 'boolean') {
      throw new Error(`${location}.resend_unserved must be a boolean.`);
    }
    // A lane's secret slot may hold several keys of one provider, one per line (separate accounts).
    // The weights split PRs between them in order; a key past the list counts 1.
    if (lane.key_weights !== undefined && (!Array.isArray(lane.key_weights) || lane.key_weights.length < 2 || lane.key_weights.length > 4
      || lane.key_weights.some((weight) => !Number.isInteger(weight) || weight < 1 || weight > 100))) {
      throw new Error(`${location}.key_weights must be an array of 2 to 4 integers from 1 to 100.`);
    }
    // Or the lane's own keys are used in order: every PR starts on the first, and a later key only
    // takes a request the one before it could not serve for an account reason.
    if (lane.key_order !== undefined && lane.key_order !== 'sequential') {
      throw new Error(`${location}.key_order must be "sequential" when configured.`);
    }
    if (lane.key_order !== undefined && lane.key_weights !== undefined) {
      throw new Error(`${location}.key_order cannot be combined with key_weights.`);
    }
    if (!ALLOWED_PROTOCOLS.has(lane.protocol)) throw new Error(`${location}.protocol is not supported.`);
    for (const field of ['request_timeout_ms', 'model_budget_ms']) {
      if (lane[field] !== undefined && (!Number.isInteger(lane[field]) || lane[field] < 1)) {
        throw new Error(`${location}.${field} must be a positive integer when configured.`);
      }
    }
    if (lane.request_timeout_ms !== undefined && lane.model_budget_ms !== undefined
      && lane.model_budget_ms < lane.request_timeout_ms) {
      throw new Error(`${location}.model_budget_ms must be greater than or equal to request_timeout_ms.`);
    }
    validateModel(lane.primary, `${location}.primary`);
    if (!Array.isArray(lane.fallbacks)) throw new Error(`${location}.fallbacks must be an array.`);
    if (lane.fallbacks.length > 1) throw new Error(`${location} supports at most one fallback.`);
    lane.fallbacks.forEach((model, modelIndex) => validateModel(model, `${location}.fallbacks[${modelIndex}]`));
    // An optional first pass reviews a PR's first commit ahead of the primary, on the lane's own
    // provider and key. Later commits go straight to the primary, so it has no cross-provider
    // fallback of its own: when it cannot serve, the lane's normal chain does.
    const modelEntries = [[lane.primary, `${location}.primary`],
      ...lane.fallbacks.map((model, modelIndex) => [model, `${location}.fallbacks[${modelIndex}]`])];
    if (lane.first_pass !== undefined) {
      validateModel(lane.first_pass, `${location}.first_pass`);
      if (lane.first_pass.cross_provider !== undefined) {
        throw new Error(`${location}.first_pass cannot configure cross_provider; the lane's own chain serves when it cannot.`);
      }
      modelEntries.unshift([lane.first_pass, `${location}.first_pass`]);
    }
    for (const [model, modelLocation] of modelEntries) validateModelOptions(config, lane, model, modelLocation);
    const ids = modelEntries.map(([model]) => model.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Lane ${lane.id} contains a duplicate first-pass/primary/fallback model id.`);
    }
    if (lane.last_resort !== undefined) validateLastResort(config, lane, location);
  }
  // Advisory lanes never gate a review, so a config where every lane is advisory has no
  // enforcement left at all. Reject it here rather than let it degrade silently.
  if (config.lanes.every((lane) => lane.advisory === true)) {
    throw new Error('At least one lane must be required; every configured lane is advisory.');
  }
  return config;
}

function loadConfig(repository, actionPath) {
  const file = path.join(actionPath, 'config', 'repositories', configFileName(repository));
  if (!fs.existsSync(file)) throw new Error(`No central PR review config exists for ${repository}.`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot parse ${path.basename(file)}: ${error.message}`);
  }
  return validateConfig(parsed, repository);
}

function setOutput(name, value, outputPath) {
  if (!outputPath) throw new Error('GITHUB_OUTPUT is not set.');
  fs.appendFileSync(outputPath, `${name}=${value}\n`, 'utf8');
}

function run(env = process.env) {
  const repository = env.INPUT_REPOSITORY || env.GITHUB_REPOSITORY;
  const actionPath = env.GITHUB_ACTION_PATH || path.resolve(__dirname, '..');
  const config = loadConfig(repository, actionPath);
  setOutput('config', JSON.stringify(config), env.GITHUB_OUTPUT);
  process.stdout.write(`Resolved central PR review config for ${repository}: ${config.lanes.length} lane(s).\n`);
}

if (require.main === module) {
  try {
    run();
  } catch (error) {
    process.stderr.write(`::error::${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { configFileName, loadConfig, validateConfig, run };
