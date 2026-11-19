#!/usr/bin/env node

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const actionPath = path.join(here, '..', 'review-action');
const probeScript = fs.readFileSync(path.join(here, '..', 'scripts', 'probe-provider.ps1'), 'utf8');
const source = require(path.join(actionPath, 'src', 'index.js'));
const bundled = require(path.join(actionPath, 'dist', 'index.js'));

const repositories = [
  'ptjworks/ci-central',
  'TshyGO/NebulaLab',
  'TshyGO/NebulaLab-Docs',
  'ptjworks/NebulaLab-Docs',
  'TshyGO/NebulaLab-Plugins',
  'ptjworks/NebulaLab-Plugins',
  'TshyGO/resume-form-assistant-plugin',
  'ptjworks/resume-form-assistant-plugin',
  'ptjworks/AI-Thesis-Polisher',
  'TshyGO/NebulaGraph-License-Service',
];
assert.match(probeScript, /provider -ne 'volcengine-ark-coding'/, 'only Ark Coding may tolerate a missing or incomplete /models response');
assert.match(probeScript, /foreach \(\$modelConfig in \$models\)/, 'provider probe must validate the first pass and the model on the first route');
assert.match(probeScript, /\$provider = \$laneConfig\.routes\[0\]\.provider/, 'provider probe must use the lane\'s first route');
assert.match(probeScript, /request\.max_tokens = 512\b/, 'provider probe must leave enough output room for reasoning models to return final text');
assert.match(probeScript, /foreach \(\$modelConfig in \$models\) \{\s*\$model = \$modelConfig\.id\s*[\s\S]*?\$protocol = if \(\[string\]::IsNullOrWhiteSpace\(\$modelConfig\.protocol\)\) \{ \$laneConfig\.protocol \} else \{ \$modelConfig\.protocol \}/, 'provider probe must validate every configured model with its own protocol');
assert.match(probeScript, /elseif \(\$protocol -eq 'google-generate-content'\)[\s\S]*?inference\/go\/v1/, 'Go Gemini probe must use the inference endpoint');
assert.match(probeScript, /elseif \(\$protocol -eq 'anthropic-messages'\)[\s\S]*?'x-api-key' = \$key/, 'Anthropic Messages probe must authenticate with x-api-key');

// Every model a lane may serve: its first pass, its model, and a paid route's own models.
const modelsOf = (lane) => [lane.first_pass, lane.model, ...lane.routes.flatMap((route) => [route.first_pass, route.model])].filter(Boolean);
const LUNA = { id: 'gpt-6-luna', label: 'GPT-6 Luna', protocol: 'openai-responses', context_profile: 'full', max_output_tokens: 65536, reporting_calibration: true, reasoning_effort: 'xhigh' };
const SOL = { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', protocol: 'openai-responses', context_profile: 'full', max_output_tokens: 65536, reporting_calibration: true, reasoning_effort: 'high' };

// NebulaLab's Lane B runs on Anthropic: Sonnet 5.5 reviews each PR's first commit and Haiku 5.5
// the later ones, on one provider and key. The other repositories keep Haiku on OpenCode Go.
const anthropicLaneB = new Set(['TshyGO/NebulaLab']);
for (const repository of repositories) {
  const fromSource = source.loadConfig(repository, actionPath);
  const fromBundle = bundled.loadConfig(repository, actionPath);
  const onAnthropic = anthropicLaneB.has(repository);
  assert.equal(fromSource.schema_version, 2);
  assert.equal(fromSource.review_policy.max_attempts, 1);
  assert.deepEqual(fromBundle, fromSource, `${repository} source and dist loaders disagree`);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.id), ['A', 'B', 'C']);
  const cModel = onAnthropic ? 'gpt-6.1-terra' : 'minimax-m3.1-flash';
  assert.deepEqual(fromSource.lanes.map((lane) => lane.model.id), ['muse-spark-1.3-contributor', 'claude-haiku-5-5', cModel]);
  // Which providers each fixed slot holds. A slot with two is a version-1 bundle. NebulaLab keeps
  // one Go key, its Anthropic accounts and an OpenAI + Command Code bundle; the others keep a Go key,
  // a Go + Anthropic bundle and a Command Code + OpenAI bundle.
  assert.deepEqual(fromSource.key_slots, onAnthropic
    ? { A: ['opencode-go'], B: ['anthropic'], C: ['openai', 'command-code'] }
    : { A: ['opencode-go'], B: ['opencode-go', 'anthropic'], C: ['command-code', 'openai'] }, `${repository} key slots changed`);
  // Each lane asks its providers in order, the same model on each (the owner's decision,
  // 2026-10-18): when a provider yields no usable review, for any reason, the next one gets the
  // same request. Outside NebulaLab, Lanes B and C end with a paid API asked only when both plans
  // report a spent quota (2026-11-03): Haiku on Anthropic, and on OpenAI GPT-6.1 Sol for a PR's
  // first pass and GPT-6 Luna at xhigh after. Their Lane C runs MiniMax M3.1 Flash on Go first
  // (2026-11-18), with Go's key from the Lane A slot. NebulaLab reviews on both APIs first; its
  // Lane C falls back to GPT-6 Luna, labelled, on Go and Command Code.
  assert.deepEqual(fromSource.lanes.map((lane) => lane.routes), onAnthropic ? [
    [{ provider: 'opencode-go' }, { provider: 'command-code', id: 'meta/muse-spark-1.3-contributor' }],
    [{ provider: 'anthropic' }, { provider: 'opencode-go' }, { provider: 'command-code' }],
    [{ provider: 'openai' }, { provider: 'opencode-go', id: 'gpt-6-luna', label: 'GPT-6 Luna' },
      { provider: 'command-code', id: 'gpt-6-luna', label: 'GPT-6 Luna' }],
  ] : [
    [{ provider: 'opencode-go' }, { provider: 'command-code', id: 'meta/muse-spark-1.3-contributor' }],
    [{ provider: 'opencode-go' }, { provider: 'command-code' }, { provider: 'anthropic', when: 'plans_spent' }],
    [{ provider: 'opencode-go' }, { provider: 'command-code', id: 'minimax/minimax-m3.1-flash' }, { provider: 'openai', when: 'plans_spent', model: LUNA, first_pass: SOL }],
  ], `${repository} lane routes changed`);
  // Go serves GPT-6 Luna only over Responses (Chat Completions returns 400 ModelProtocolUnsupported)
  // and MiniMax M3.1 Flash only over Chat Completions; every route reuses the model's protocol.
  assert.deepEqual(fromSource.lanes.map((lane) => lane.model.protocol ?? lane.protocol),
    ['openai-responses', 'anthropic-messages', onAnthropic ? 'openai-responses' : 'openai-chat-completions'], `${repository} lane protocols changed`);
  // MiniMax thought for up to 56,177 tokens and wrote up to 57,913 on ci-central #86 (2026-11-18), close
  // to the 65,536 GPT-6 Luna keeps; it accepts up to 512K, so it gets 131,072.
  assert.equal(fromSource.lanes[2].model.max_output_tokens, onAnthropic ? 65536 : 131072);
  assert.deepEqual(fromSource.lanes.map((lane) => lane.first_pass?.id ?? null), [null, onAnthropic ? 'claude-sonnet-5-5' : null, onAnthropic ? 'gpt-6.2-sol' : null],
    `${repository} only NebulaLab's Lanes B/C have first passes`);
  // Haiku at max effort spent all 65,536 output tokens thinking on three large NebulaLab PRs; high finished them.
  assert.equal(fromSource.lanes[1].model.effort, 'high', `${repository} Haiku must stay at high effort`);
  // Muse runs at xhigh everywhere (NebulaLab since 2026-11-18).
  assert.equal(fromSource.lanes[0].model.reasoning_effort, 'xhigh', `${repository} Muse effort must follow its review policy`);
  // MiniMax thinks deepest with no effort sent: explicit high and xhigh thought less and found
  // fewer seeded defects (2/5, 3/5 against 4/5), and max matched the default (2026-11-18).
  assert.equal(fromSource.lanes[2].model.reasoning_effort, onAnthropic ? 'high' : undefined,
    `${repository} Lane C effort must follow its review policy`);
  // Calibration took Muse and Hy3 from near-silent to 1-5 findings on large NebulaLab PRs with no
  // high-confidence clean-change noise; on Haiku it only added noise. GPT-6 Luna took over Lane C
  // with Hy3's setting and was measured with it on 2026-10-19.
  assert.deepEqual(fromSource.lanes.map((lane) => lane.model).filter((model) => model.reporting_calibration).map((model) => model.id),
    ['muse-spark-1.3-contributor', cModel], `${repository} calibration must stay limited to Muse and Lane C`);
  assert.ok(fromSource.lanes.every((lane) => modelsOf(lane).every((model) => model.thinking_level === undefined)),
    `${repository} no active lane uses Google thinking`);
  // Every active model must send an explicit output ceiling.
  assert.ok(fromSource.lanes.every((lane) => modelsOf(lane).every((model) => model.omit_max_tokens === undefined)),
    `${repository} no active lane may silently omit the output ceiling`);
}

const ciCentral = source.loadConfig('ptjworks/ci-central', actionPath);
// ci-central left TshyGO on 2026-10-27; a repository recreated at the old name gets no policy.
assert.throws(() => source.loadConfig('TshyGO/ci-central', actionPath), /No central PR review config exists for TshyGO\/ci-central/);
// AI-Thesis-Polisher left TshyGO on 2026-10-28; a repository recreated at the old name gets no policy.
assert.throws(() => source.loadConfig('TshyGO/AI-Thesis-Polisher', actionPath), /No central PR review config exists for TshyGO\/AI-Thesis-Polisher/);
for (const name of ['resume-form-assistant-plugin', 'NebulaLab-Docs', 'NebulaLab-Plugins']) {
  assert.deepEqual(
    source.loadConfig(`ptjworks/${name}`, actionPath),
    { ...source.loadConfig(`TshyGO/${name}`, actionPath), repository: `ptjworks/${name}` },
    `${name} ownership migration must preserve every review policy and lane setting`,
  );
}
assert.equal(ciCentral.review_policy.request_timeout_ms, 600000);
assert.equal(ciCentral.lanes[2].advisory, true, 'ci-central Lane C shares a provider quota and must not gate its own PRs');
assert.equal(ciCentral.review_policy.model_budget_ms, 720000);
assert.equal(ciCentral.lanes[1].model.max_output_tokens, 120000, 'ci-central Lane B must preserve the Haiku output ceiling');

for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  // Lane C rides a shared quota that can return 429 once exhausted. Every repository keeps it
  // advisory so an empty quota never turns a PR red on its own, and keeps Lanes A and B
  // gating so the review still enforces something.
  assert.equal(config.lanes[2].advisory, true, `${repository} Lane C must stay advisory`);
  assert.ok(config.lanes.slice(0, 2).every((lane) => lane.advisory === undefined), `${repository} Lane A/B must keep gating the job`);
  // Haiku at high effort used up to 47,348 output tokens on a 226K-token PR; 120,000 keeps
  // room for larger changes under its 128K ceiling.
  assert.equal(config.lanes[1].model.max_output_tokens, 120000, `${repository} Lane B must preserve the Haiku output ceiling`);
  assert.equal(config.lanes[1].request_timeout_ms, 1800000, `${repository} Lane B preserves reasoning with a thirty-minute request ceiling`);
  assert.equal(config.lanes[1].model_budget_ms, 1800000, `${repository} Lane B model budget matches its request ceiling`);
  // Measured 2026-10-19: GPT-6 Luna finished three large NebulaLab PRs on Go in 68-107 s. On
  // 2026-11-18 MiniMax M3.1 Flash took 166-609 s on four ci-central PRs. Lane C keeps fifteen
  // minutes on each provider.
  assert.equal(config.lanes[2].request_timeout_ms, 900000, `${repository} Lane C request budget changed without a measurement behind it`);
  assert.equal(config.lanes[2].model_budget_ms, 900000, `${repository} Lane C model cap is fifteen minutes`);
  assert.equal(config.lanes[2].model.request_timeout_ms, undefined, `${repository} Lane C's model inherits the lane's fifteen-minute window`);
  // Measured 2026-10-14: Haiku finished 71-226K-token NebulaLab PRs in 146-211 s.
  assert.equal(config.lanes[1].model.request_timeout_ms, 900000, `${repository} Lane B Haiku uses a fifteen-minute window`);
  if (anthropicLaneB.has(repository)) {
    // Measured 2026-10-15 through the TW egress: Sonnet 5.5 finished 71-226K-token NebulaLab PRs
    // in 54-174 s. Its fifteen minutes and Haiku's fit the lane's thirty together.
    assert.equal(config.lanes[1].first_pass.request_timeout_ms, 900000, `${repository} the Sonnet first pass uses a fifteen-minute window`);
  }
}

// The quorum keeps the bar where it was. NebulaLab required Lane A and Lane B, so two
// reviews had to land before a pull request could go green, and two still have to. What
// changed is that the gate no longer insists on which two, which is the only way three
// lanes are redundant rather than three chances to be blocked: a provider quota is
// exhausted for days, and under the old rule either one of the two named lanes running
// dry turned every pull request red while the other two published full reviews.
//
// Two is also the floor that keeps a heavyweight lane in every passing run: with three
// lanes, no quorum of two can be reached by Lane C alone.
for (const repository of repositories) {
  const { review_policy: policy, lanes } = source.loadConfig(repository, actionPath);
  assert.equal(policy.min_valid_lanes, 2, `${repository} quorum must stay at the two reviews the required lanes already demanded`);
  assert.ok(policy.min_valid_lanes < lanes.length,
    `${repository} quorum equal to the lane count is the all-lanes rule again, with none of the redundancy`);
  assert.equal(lanes.filter((lane) => !lane.advisory).length, 2,
    `${repository} quorum of 2 assumes two non-advisory lanes; changing that changes what the number means`);
}

// Context budgets are sized per model window. The worst prompt measured on NebulaLab
// (Chinese-heavy diffs) was 2.05 characters per input token; 40,000 characters cover
// the system prompt, coverage manifest and headers. An unlisted model fails here until its
// window is recorded.
const WORST_CHARS_PER_TOKEN = 2;
const inputTokenRoom = {
  'muse-spark-1.3-contributor': 1048576,
  'claude-haiku-5-5': 1000000,
  'claude-sonnet-5-5': 1000000,
  // Command Code's ids, from its /models context_length.
  'meta/muse-spark-1.3-contributor': 1048576,
  // GPT-6 Luna: a 1M-token window (recorded 2026-10-19). Command Code and Go use the same id, so this
  // one entry bounds both routes; it is counted together with its output, the conservative reading.
  'gpt-6-luna': 1000000,
  'gpt-6.1-sol': 1000000,
  'gpt-6.1-terra': 1050000,
  'gpt-6.2-sol': 1050000,
  // MiniMax M3.1 Flash: a 1M-token context on Go and on Command Code (recorded 2026-11-18).
  'minimax-m3.1-flash': 1000000,
  'minimax/minimax-m3.1-flash': 1000000,
};
const sharesWindowWithOutput = new Set(['claude-haiku-5-5', 'claude-sonnet-5-5', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-sol',
  'minimax-m3.1-flash', 'minimax/minimax-m3.1-flash']);
for (const repository of repositories) {
  const config = source.loadConfig(repository, actionPath);
  const policy = config.review_policy;
  assert.equal(policy.diff_char_budget, 260000, `${repository} default diff budget must fit the 256K-window models`);
  assert.deepEqual([policy.issue_char_budget, policy.issue_excerpt_chars, policy.description_char_limit], [60000, 20000, 20000],
    `${repository} issue and description context must not fall back to the old 20K/6K/4K cuts`);
  assert.equal(config.lanes[0].model.max_output_tokens, 65536, `${repository} Muse must not truncate its report at the old 16K ceiling`);
  for (const model of [config.lanes[0].model, config.lanes[1].model]) {
    assert.equal(model.diff_char_budget, 1200000, `${repository} ${model.id} must use its 1M-token window for large changes`);
  }
  assert.deepEqual([config.lanes[0].request_timeout_ms, config.lanes[0].model_budget_ms], [600000, 600000],
    `${repository} Lane A needs a longer window for 1M-token inputs`);
  const promptChars = policy.issue_char_budget + policy.description_char_limit + 40000;
  for (const lane of config.lanes) {
    for (const model of modelsOf(lane)) {
      const diffChars = model.diff_char_budget ?? policy.diff_char_budget;
      const inputTokens = (diffChars + promptChars) / WORST_CHARS_PER_TOKEN;
      const sharedOutput = sharesWindowWithOutput.has(model.id) ? model.max_output_tokens : 0;
      assert.ok(inputTokens + sharedOutput <= inputTokenRoom[model.id],
        `${repository} Lane ${lane.id} ${model.id} context budget can exceed its model window`);
      if (model.id === 'gpt-6.2-sol') {
        assert.ok(inputTokens <= 922000 && model.max_output_tokens <= 128000,
          `${repository} Lane ${lane.id} ${model.id} exceeds its separate input or output limit`);
      }
    }
    // A later route resends the lane's prompt under its own id, so it must fit that model's window too.
    for (const route of lane.routes.slice(1).filter((route) => !route.when && route.id)) {
      const diffChars = lane.model.diff_char_budget ?? policy.diff_char_budget;
      const output = sharesWindowWithOutput.has(route.id) ? lane.model.max_output_tokens : 0;
      assert.ok((diffChars + promptChars) / WORST_CHARS_PER_TOKEN + output <= inputTokenRoom[route.id],
        `${repository} Lane ${lane.id} route ${route.provider} ${route.id} context budget can exceed its model window`);
    }
  }
}

const nebula = source.loadConfig('TshyGO/NebulaLab', actionPath);
assert.equal(nebula.lanes[2].first_pass.id, 'gpt-6.2-sol');
assert.equal(nebula.lanes[2].first_pass.label, 'GPT-6.2 Sol');
assert.equal(nebula.lanes[2].first_pass.reasoning_effort, 'high');
assert.equal(nebula.lanes[2].model.reasoning_effort, 'high');
assert.equal(nebula.lanes[0].model.context_profile, 'full');
// Sonnet 5.5 found real defects Haiku missed and none of Haiku's false P1s on NebulaLab
// #1133/#1237/#1241 (2026-10-15), at 0.4x Haiku's output. A first review sees a median 97% of
// the final diff, so it runs once per PR and Haiku reviews the later commits.
// On six replayed first commits where production Sonnet at high had reported nothing (2026-11-19,
// inputs matching production to 20 tokens), high stayed silent on 10 of 12 runs; xhigh alone found
// 3 real issues, calibration alone 1 real among 12 findings, and xhigh with calibration 11 real
// (10 fixed later) among 21, in at most 386 s.
assert.deepEqual(nebula.lanes[1].first_pass, {
  id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', request_timeout_ms: 900000, context_profile: 'full',
  max_output_tokens: 120000, effort: 'xhigh', reporting_calibration: true, diff_char_budget: 1200000,
}, 'NebulaLab Lane B first pass changed without a measurement behind it');
assert.equal(nebula.lanes[1].model.reporting_calibration, undefined, 'Haiku stays uncalibrated');

for (const loader of [source, bundled]) {
  // Several keys in one slot are separate accounts used in order; the weighted split and the
  // explicit order setting are gone, and a stale config naming them fails instead of losing them.
  for (const [field, value] of [['key_weights', [2, 1]], ['key_order', 'sequential'], ['resend_unserved', true],
    ['fallbacks', []], ['provider', 'openai'], ['credential_providers', ['openai', 'command-code']], ['primary', nebula.lanes[2].model],
    ['last_resort', { provider: 'openai', primary: nebula.lanes[2].model }]]) {
    const config = structuredClone(nebula);
    config.lanes[2][field] = value;
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), new RegExp(`lanes\\[2\\]\\.${field} was (replaced by .*|removed) in schema 2`), field);
  }
  const unknownField = structuredClone(nebula);
  unknownField.lanes[0].routing = 'any';
  assert.throws(() => loader.validateConfig(unknownField, 'TshyGO/NebulaLab'), /lanes\[0\]\.routing is not a lane field/);
  const schemaOne = structuredClone(nebula);
  schemaOne.schema_version = 1;
  assert.throws(() => loader.validateConfig(schemaOne, 'TshyGO/NebulaLab'), /Unsupported repository config schema_version/);
}

// A first pass is validated like any lane model, goes to the first route only, and cannot share
// an id with the model that follows it.
for (const loader of [source, bundled]) {
  for (const [mutate, message] of [
    [(config) => { config.lanes[1].first_pass.cross_provider = { credential_lane: 'C', id: 'claude-sonnet-5-5' }; }, /first_pass\.cross_provider was replaced by the lane's routes/],
    [(config) => { config.lanes[1].first_pass.id = config.lanes[1].model.id; }, /duplicate first-pass\/model id/],
    [(config) => { config.lanes[1].first_pass.effort = 'extreme'; }, /first_pass\.effort is not supported/],
    [(config) => { config.lanes[1].first_pass.temperature = 0.2; }, /first_pass\.temperature is not supported by anthropic-messages/],
    [(config) => { config.lanes[1].first_pass.max_output_tokens = 0; }, /first_pass\.max_output_tokens must be a positive integer/],
    [(config) => { config.lanes[1].first_pass = 'claude-sonnet-5-5'; }, /first_pass must be an object/],
  ]) {
    const config = structuredClone(nebula);
    mutate(config);
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), message);
  }
}

for (const loader of [source, bundled]) {
  const badAttempts = structuredClone(nebula);
  badAttempts.review_policy.max_attempts = 3;
  assert.throws(() => loader.validateConfig(badAttempts, 'TshyGO/NebulaLab'), /max_attempts must be 1/);
  for (const invalid of [0, -1, 1.5, '300000', null]) {
    const config = structuredClone(nebula);
    config.lanes[2].model.request_timeout_ms = invalid;
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), /request_timeout_ms must be a positive integer/);
  }
}
const duplicateAcrossLanes = structuredClone(nebula);
duplicateAcrossLanes.lanes[1].model.id = duplicateAcrossLanes.lanes[0].model.id;
assert.doesNotThrow(() => source.validateConfig(duplicateAcrossLanes, 'TshyGO/NebulaLab'), 'routing must be lane-scoped, not keyed globally by model id');

// A one-route lane on the Gemini protocol: thinking_level is checked, and later routes are refused.
const geminiLane = (config) => {
  config.lanes[2].protocol = 'google-generate-content';
  delete config.lanes[2].first_pass;
  delete config.lanes[2].model.reasoning_effort;
  config.lanes[2].routes = [{ provider: 'openai' }];
  return config;
};
const invalidThinkingLevel = geminiLane(structuredClone(nebula));
invalidThinkingLevel.lanes[2].model.thinking_level = 'maximum';
assert.throws(() => source.validateConfig(invalidThinkingLevel, 'TshyGO/NebulaLab'), /thinking_level is not supported/);
const crossProtocolThinking = structuredClone(nebula);
crossProtocolThinking.lanes[0].model.thinking_level = 'high';
assert.throws(() => source.validateConfig(crossProtocolThinking, 'TshyGO/NebulaLab'), /only supported by google-generate-content/);
const googleLaterRoute = geminiLane(structuredClone(nebula));
googleLaterRoute.lanes[2].routes.push({ provider: 'command-code' });
assert.throws(() => source.validateConfig(googleLaterRoute, 'TshyGO/NebulaLab'), /routes\[1\] is not supported by google-generate-content/);

const invalidOmitMaxTokens = structuredClone(nebula);
invalidOmitMaxTokens.lanes[2].model.omit_max_tokens = 'yes';
assert.throws(() => source.validateConfig(invalidOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens must be a boolean/);
const googleOmitMaxTokens = geminiLane(structuredClone(nebula));
googleOmitMaxTokens.lanes[2].model.omit_max_tokens = true;
assert.throws(() => source.validateConfig(googleOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);
// Lane C's Responses request always carries its output ceiling; the flag cannot drop it there either.
const responsesOmitMaxTokens = structuredClone(nebula);
responsesOmitMaxTokens.lanes[2].model.omit_max_tokens = true;
assert.throws(() => source.validateConfig(responsesOmitMaxTokens, 'TshyGO/NebulaLab'), /omit_max_tokens is only supported by openai-chat-completions/);

const invalidLaneBudget = structuredClone(nebula);
invalidLaneBudget.lanes[2].model_budget_ms = invalidLaneBudget.lanes[2].request_timeout_ms - 1;
assert.throws(() => source.validateConfig(invalidLaneBudget, 'TshyGO/NebulaLab'), /greater than or equal to request_timeout_ms/);

// Lane C is a best-effort slot. It must publish a review when it can, but an exhausted quota
// must never turn the job red - a permanently failing check is one that reviewers learn to ignore.
assert.equal(nebula.lanes[2].advisory, true, 'NebulaLab Lane C must stay advisory');
assert.ok(nebula.lanes.slice(0, 2).every((lane) => lane.advisory === undefined), 'NebulaLab Lane A/B must keep gating the job');
const invalidAdvisory = structuredClone(nebula);
invalidAdvisory.lanes[2].advisory = 'yes';
assert.throws(() => source.validateConfig(invalidAdvisory, 'TshyGO/NebulaLab'), /advisory must be a boolean/);
const everyLaneAdvisory = structuredClone(nebula);
for (const lane of everyLaneAdvisory.lanes) lane.advisory = true;
assert.throws(() => source.validateConfig(everyLaneAdvisory, 'TshyGO/NebulaLab'), /At least one lane must be required/);

// Key slots name exactly the lanes, one provider or a two-provider bundle; routes name providers
// some slot holds, each once, and only a later route may name another model id.
for (const loader of [source, bundled]) {
  for (const [mutate, message] of [
    [(config) => { delete config.key_slots; }, /key_slots must map each lane id/],
    [(config) => { delete config.key_slots.B; }, /key_slots must name exactly the configured lanes/],
    [(config) => { config.key_slots.D = ['openai']; }, /key_slots must name exactly the configured lanes/],
    [(config) => { config.key_slots.B = []; }, /key_slots\.B must list one provider, or two/],
    [(config) => { config.key_slots.C = ['openai', 'command-code', 'anthropic']; }, /key_slots\.C must list one provider, or two/],
    [(config) => { config.key_slots.C = ['openai', 'openai']; }, /key_slots\.C must list one provider, or two/],
    [(config) => { config.key_slots.C = ['openai', 'grok']; }, /key_slots\.C must list one provider, or two/],
    [(config) => { config.lanes[0].routes = []; }, /routes must list one to three providers/],
    [(config) => { config.lanes[0].routes.push({ provider: 'anthropic' }, { provider: 'openai' }); }, /routes must list one to three providers/],
    [(config) => { config.lanes[0].routes[1].provider = 'grok'; }, /routes\[1\]\.provider grok is not in any key slot/],
    [(config) => { config.lanes[0].routes[1].provider = 'opencode-go'; }, /routes must list distinct providers/],
    [(config) => { config.lanes[0].routes[0].id = 'muse-spark-1.3-contributor'; }, /routes\[0\] may only set provider/],
    [(config) => { config.lanes[0].routes[1].credential_lane = 'C'; }, /routes\[1\] may only set provider, id, label/],
    [(config) => { config.lanes[0].routes[1].id = ' '; }, /routes\[1\]\.id must be a non-empty string/],
    [(config) => { config.lanes[0].routes[1] = 'command-code'; }, /routes\[1\] must be an object/],
    // The quota-only overflow and the per-model cross route it became must not be ignored silently.
    [(config) => { config.lanes[0].model.quota_overflow = { credential_lane: 'C', id: 'meta/muse-spark-1.3-contributor' }; }, /model\.quota_overflow was replaced by the lane's routes/],
    [(config) => { config.lanes[0].model.cross_provider = { credential_lane: 'C', id: 'meta/muse-spark-1.3-contributor' }; }, /model\.cross_provider was replaced by the lane's routes/],
  ]) {
    const config = structuredClone(nebula);
    mutate(config);
    assert.throws(() => loader.validateConfig(config, 'TshyGO/NebulaLab'), message);
  }
  // Lanes may draw on each other's slots, in either direction.
  const towardAnthropic = structuredClone(nebula);
  towardAnthropic.lanes[0].routes[1] = { provider: 'anthropic', id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' };
  assert.doesNotThrow(() => loader.validateConfig(towardAnthropic, 'TshyGO/NebulaLab'));
}
// A request to a provider uses the lane's own slot when it holds that provider, otherwise the first that does.
const resume = source.loadConfig('ptjworks/resume-form-assistant-plugin', actionPath);
assert.deepEqual(['opencode-go', 'command-code', 'anthropic', 'openai'].map((provider) => source.keySlotFor(resume, 'B', provider)), ['B', 'C', 'B', 'C']);
assert.deepEqual(['opencode-go', 'command-code', 'anthropic', 'openai'].map((provider) => source.keySlotFor(resume, 'C', provider)), ['A', 'C', 'B', 'C']);
assert.deepEqual(['opencode-go', 'command-code', 'anthropic', 'openai'].map((provider) => source.keySlotFor(nebula, 'B', provider)), ['A', 'C', 'B', 'C']);

// A paid route sits behind the two plans and is asked only when both are spent, so its shape is strict.
for (const loader of [source, bundled]) {
  assert.doesNotThrow(() => loader.validateConfig(structuredClone(resume), 'ptjworks/resume-form-assistant-plugin'));
  // An explicit protocol makes a model speak its paid API's protocol inside a lane of another.
  const explicitProtocol = structuredClone(resume);
  explicitProtocol.lanes[1].routes[2] = { provider: 'openai', when: 'plans_spent', model: { id: 'gpt-6-luna', label: 'GPT-6 Luna', protocol: 'openai-responses', max_output_tokens: 65536 } };
  assert.doesNotThrow(() => loader.validateConfig(explicitProtocol, 'ptjworks/resume-form-assistant-plugin'));
  for (const [mutate, message] of [
    [(config) => { config.lanes[1].routes[2].when = 'always'; }, /routes\[2\]\.when must be "plans_spent"/],
    [(config) => { config.lanes[1].routes[2].provider = 'command-code'; config.lanes[1].routes[1].provider = 'anthropic'; }, /must be the last route and a paid API/],
    [(config) => { config.lanes[1].routes.splice(1, 0, config.lanes[1].routes.pop()); }, /must be the last route and a paid API/],
    [(config) => { config.lanes[1].routes.splice(1, 1); }, /serves only behind opencode-go and command-code/],
    [(config) => { config.lanes[2].routes[1] = { provider: 'anthropic', id: 'gpt-6-luna' }; }, /serves only behind opencode-go and command-code/],
    [(config) => { config.lanes[1].first_pass = { ...config.lanes[1].model, id: 'claude-sonnet-5-5' }; }, /needs a lane without first_pass/],
    [(config) => { config.lanes[1].routes[2].id = 'claude-haiku-5-5'; }, /routes\[2\] may only set provider, when, model, first_pass/],
    [(config) => { config.lanes[2].routes[2].first_pass.id = 'gpt-6-luna'; }, /first_pass must name a model other than the model it leads/],
    [(config) => { config.lanes[2].routes[2].first_pass.effort = 'high'; }, /routes\[2\]\.first_pass\.effort is only supported by anthropic-messages/],
    [(config) => { config.lanes[1].routes[2].model = { ...config.lanes[1].model, reasoning_effort: 'high' }; }, /routes\[2\]\.model\.reasoning_effort requires openai-responses/],
    [(config) => { config.lanes[2].routes[2].model.max_output_tokens = 0; }, /routes\[2\]\.model\.max_output_tokens must be a positive integer/],
    // ci-central#86 review: a paid model must speak its paid API's protocol, not the plan lane's.
    [(config) => { config.key_slots.B = ['opencode-go', 'openai']; config.lanes[1].routes[2].provider = 'openai'; }, /must use a protocol openai serves/],
    [(config) => { config.key_slots.C = ['command-code', 'anthropic']; config.lanes[2].routes[2].provider = 'anthropic'; }, /must use a protocol anthropic serves/],
  ]) {
    const config = structuredClone(resume);
    mutate(config);
    assert.throws(() => loader.validateConfig(config, 'ptjworks/resume-form-assistant-plugin'), message);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'review-config-'));
const output = path.join(tmp, 'output.txt');
source.run({ INPUT_REPOSITORY: 'TshyGO/NebulaLab', GITHUB_ACTION_PATH: actionPath, GITHUB_OUTPUT: output });
const emitted = fs.readFileSync(output, 'utf8').trim();
assert.ok(emitted.startsWith('config={'));
assert.deepEqual(JSON.parse(emitted.slice('config='.length)), nebula);

assert.throws(() => source.loadConfig('TshyGO/Unknown', actionPath), /No central PR review config/);
assert.throws(() => source.configFileName('../invalid'), /Invalid repository identifier/);

console.log('ok   central repository config resolver');
