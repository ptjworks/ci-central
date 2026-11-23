'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ALLOWED_PROTOCOLS = new Set(['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'google-generate-content']);
const ANTHROPIC_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const ALLOWED_LANES = new Set(['A', 'B', 'C']);
const BUNDLE_PROVIDERS = new Set(['openai', 'command-code', 'opencode-go', 'anthropic']);

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
  // A model may speak a different protocol than its lane, for example a paid API behind two plans.
  if (model.protocol !== undefined && !ALLOWED_PROTOCOLS.has(model.protocol)) {
    throw new Error(`${location}.protocol is not supported.`);
  }
}

// Schema 2 fields a lane no longer takes, each with what replaced it. A stale config fails here
// instead of silently losing a route.
const RETIRED_LANE_FIELDS = {
  provider: 'routes[0].provider', credential_providers: 'key_slots', primary: 'model', fallbacks: 'routes',
  last_resort: 'a routes entry with "when": "plans_spent"', key_weights: 'keys used in order', key_order: 'keys used in order',
  resend_unserved: null,
};
const LANE_FIELDS = new Set(['id', 'advisory', 'protocol', 'request_timeout_ms', 'model_budget_ms', 'first_pass', 'model', 'routes']);
// The plans a paid API sits behind, and the protocols each paid API serves.
const PLAN_PROVIDERS = ['command-code', 'opencode-go'];
const NATIVE_PROTOCOLS = { anthropic: ['anthropic-messages'], openai: ['openai-responses', 'openai-chat-completions'] };

// The fixed secret slot a lane's request to `provider` uses: the lane's own slot when it holds that
// provider, otherwise the first slot, in A-B-C order, that does.
function keySlotFor(config, laneId, provider) {
  const slots = config.key_slots || {};
  if (slots[laneId]?.includes(provider)) return laneId;
  return ['A', 'B', 'C'].find((id) => slots[id]?.includes(provider));
}

function validateModelOptions(config, lane, model, location) {
  const protocol = model.protocol ?? lane.protocol;
  if (model.cache_system_prompt !== undefined
    && (protocol !== 'openai-responses' || typeof model.cache_system_prompt !== 'boolean')) {
    throw new Error(`${location}.cache_system_prompt must be a boolean and requires openai-responses.`);
  }
  // Chat Completions takes the effort as a top-level `reasoning_effort` (DeepSeek V4.1 Flash on Go, 2026-11-20).
  if (model.reasoning_effort !== undefined && (!['openai-responses', 'openai-chat-completions'].includes(protocol)
    || !['none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(model.reasoning_effort))) {
    throw new Error(`${location}.reasoning_effort requires openai-responses or openai-chat-completions and a supported effort.`);
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
  // A model's other providers are the lane's routes now; a stale config must not lose them silently.
  for (const field of ['cross_provider', 'quota_overflow']) {
    if (model[field] !== undefined) throw new Error(`${location}.${field} was replaced by the lane's routes.`);
  }
  if (model.thinking_level === undefined) return;
  if (protocol !== 'google-generate-content') {
    throw new Error(`${location}.thinking_level is only supported by google-generate-content.`);
  }
  if (!['minimal', 'low', 'medium', 'high'].includes(model.thinking_level)) {
    throw new Error(`${location}.thinking_level is not supported.`);
  }
}

// Each fixed secret slot holds one provider's key (a plain value) or two providers' keys (a
// version-1 bundle). A provider may sit in more than one slot; a lane uses its own slot first.
function validateKeySlots(config) {
  const slots = config.key_slots;
  if (!slots || typeof slots !== 'object' || Array.isArray(slots)) throw new Error('key_slots must map each lane id to its slot providers.');
  const laneIds = config.lanes.map((lane) => lane?.id);
  if (Object.keys(slots).sort().join(',') !== [...laneIds].sort().join(',')) {
    throw new Error('key_slots must name exactly the configured lanes.');
  }
  for (const [id, providers] of Object.entries(slots)) {
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > 2 || new Set(providers).size !== providers.length
      || providers.some((provider) => typeof provider !== 'string' || !provider.trim())
      || (providers.length === 2 && providers.some((provider) => !BUNDLE_PROVIDERS.has(provider)))) {
      throw new Error(`key_slots.${id} must list one provider, or two of openai, command-code, opencode-go and anthropic for a bundle.`);
    }
  }
}

// The slow-stream resend on a lane's own provider (the owner's decision, 2026-11-19): Go serves a model from
// a fast or a slow backend at random, so a first route on Go may stop a stream whose output over its
// first after_ms (counted from the first streamed event) is below min_chars_per_second, and send the
// same request once more there with the rest of the window.
function validateSlowResend(route, at) {
  const slow = route.slow_resend;
  if (route.provider !== 'opencode-go') throw new Error(`${at}.slow_resend is allowed only on an opencode-go first route.`);
  if (!slow || typeof slow !== 'object' || Array.isArray(slow)
      || Object.keys(slow).sort().join(',') !== 'after_ms,min_chars_per_second') {
    throw new Error(`${at}.slow_resend must set exactly after_ms and min_chars_per_second.`);
  }
  if (!Number.isSafeInteger(slow.after_ms) || slow.after_ms < 10000 || slow.after_ms > 300000) {
    throw new Error(`${at}.slow_resend.after_ms must be an integer from 10000 to 300000.`);
  }
  if (!Number.isSafeInteger(slow.min_chars_per_second) || slow.min_chars_per_second < 1 || slow.min_chars_per_second > 100000) {
    throw new Error(`${at}.slow_resend.min_chars_per_second must be an integer from 1 to 100000.`);
  }
}

// A lane's routes are the providers it asks, in order, each once with the lane's model. A later
// route may name the model's id on its provider; a label marks an explicitly different model. The
// last route may be a paid API asked only when the two plans before it both report a spent quota;
// it may bring its own model and a first pass for a PR that has none.
function validateRoutes(config, lane, location) {
  const routes = lane.routes;
  if (!Array.isArray(routes) || routes.length < 1 || routes.length > 3) throw new Error(`${location}.routes must list one to three providers.`);
  const protocol = lane.model.protocol ?? lane.protocol;
  routes.forEach((route, index) => {
    const at = `${location}.routes[${index}]`;
    if (!route || typeof route !== 'object' || Array.isArray(route)) throw new Error(`${at} must be an object.`);
    const gated = route.when !== undefined;
    const allowed = gated ? ['provider', 'when', 'model', 'first_pass'] : index === 0 ? ['provider', 'slow_resend'] : ['provider', 'id', 'label'];
    if (Object.keys(route).some((key) => !allowed.includes(key))) {
      throw new Error(`${at} may only set ${allowed.join(', ')}.`);
    }
    if (typeof route.provider !== 'string' || !route.provider.trim()) throw new Error(`${at}.provider must be non-empty.`);
    if (route.slow_resend !== undefined) validateSlowResend(route, at);
    if (!keySlotFor(config, lane.id, route.provider)) throw new Error(`${at}.provider ${route.provider} is not in any key slot.`);
    for (const field of ['id', 'label']) {
      if (route[field] !== undefined && (typeof route[field] !== 'string' || !route[field].trim())) {
        throw new Error(`${at}.${field} must be a non-empty string.`);
      }
    }
    if (index > 0 && !gated && protocol === 'google-generate-content') {
      throw new Error(`${at} is not supported by google-generate-content.`);
    }
    if (!gated) return;
    if (route.when !== 'plans_spent') throw new Error(`${at}.when must be "plans_spent".`);
    if (index !== routes.length - 1 || !NATIVE_PROTOCOLS[route.provider]) {
      throw new Error(`${at} must be the last route and a paid API (anthropic or openai).`);
    }
    // The gate reads the routes before it, and only Go and Command Code are the plans it sits behind.
    if (routes.slice(0, index).map((earlier) => earlier.provider).sort().join(',') !== PLAN_PROVIDERS.join(',')) {
      throw new Error(`${at} serves only behind opencode-go and command-code: the routes before it must be those two plans.`);
    }
    if (lane.first_pass !== undefined) {
      throw new Error(`${at} needs a lane without first_pass; its gate judges the plan routes alone.`);
    }
    const served = route.model ?? lane.model;
    const entries = [[served, route.model ? `${at}.model` : `${location}.model`],
      ...(route.first_pass === undefined ? [] : [[route.first_pass, `${at}.first_pass`]])];
    for (const [model, modelLocation] of entries) {
      validateModel(model, modelLocation);
      // A model inherits the lane's protocol, which belongs to the plan provider; the paid API must speak its own.
      if (!NATIVE_PROTOCOLS[route.provider].includes(model.protocol ?? lane.protocol)) {
        throw new Error(`${modelLocation} must use a protocol ${route.provider} serves (${NATIVE_PROTOCOLS[route.provider].join(' or ')}); set protocol when the lane's differs.`);
      }
      validateModelOptions(config, lane, model, modelLocation);
    }
    if (route.first_pass !== undefined && route.first_pass.id === served.id) {
      throw new Error(`${at}.first_pass must name a model other than the model it leads.`);
    }
  });
  const providers = routes.map((route) => route.provider);
  if (new Set(providers).size !== providers.length) throw new Error(`${location}.routes must list distinct providers.`);
}

function validateConfig(config, repository) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Repository config must be a JSON object.');
  }
  if (config.schema_version !== 2) throw new Error('Unsupported repository config schema_version; schema 2 lists each lane\'s routes.');
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
  }
  validateKeySlots(config);
  for (const [index, lane] of config.lanes.entries()) {
    const location = `lanes[${index}]`;
    for (const field of Object.keys(lane)) {
      if (Object.hasOwn(RETIRED_LANE_FIELDS, field)) {
        throw new Error(`${location}.${field} was ${RETIRED_LANE_FIELDS[field] ? `replaced by ${RETIRED_LANE_FIELDS[field]}` : 'removed'} in schema 2.`);
      }
      if (!LANE_FIELDS.has(field)) throw new Error(`${location}.${field} is not a lane field.`);
    }
    if (lane.advisory !== undefined && typeof lane.advisory !== 'boolean') throw new Error(`${location}.advisory must be a boolean.`);
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
    validateModel(lane.model, `${location}.model`);
    validateModelOptions(config, lane, lane.model, `${location}.model`);
    // An optional first pass reviews a PR's first commit ahead of the model, on the lane's first
    // route only. Later commits go straight to the model, so when it cannot serve, the routes do.
    if (lane.first_pass !== undefined) {
      validateModel(lane.first_pass, `${location}.first_pass`);
      validateModelOptions(config, lane, lane.first_pass, `${location}.first_pass`);
      if (lane.first_pass.id === lane.model.id) throw new Error(`Lane ${lane.id} contains a duplicate first-pass/model id.`);
    }
    validateRoutes(config, lane, location);
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

module.exports = { configFileName, loadConfig, validateConfig, keySlotFor, run };
