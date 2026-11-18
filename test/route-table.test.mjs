// Route-order regression: every repository config, run through the same provider failures, must try
// the same providers, models and keys in the same order and publish the same lane comment text.
// `node test/route-table.test.mjs --write` records the fixture; the default run compares against it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { runReview } = require('../review-action/src/review-runner.js');
const configDir = path.join(here, '..', 'review-action', 'config', 'repositories');
const fixture = path.join(here, 'fixtures', 'route-table.json');

// Production slot layouts (2026-11-18). Every provider has its own base host, so a request names its provider.
const base = { 'opencode-go': 'https://go.example.test/v1', 'command-code': 'https://cc.example.test/v1',
  anthropic: 'https://anthropic.example.test/v1', openai: 'https://openai.example.test/v1' };
const providerOf = (url) => Object.keys(base).find((provider) => url.startsWith(base[provider])) ?? '?';
const bundle = (entries) => JSON.stringify({ schema_version: 1, providers: entries });
function slotsFor(repository) {
  if (repository === 'TshyGO/NebulaLab') {
    return {
      LANE_A_KEY: 'go-key', LANE_A_API_BASE: base['opencode-go'],
      LANE_B_KEY: 'anth-key', LANE_B_API_BASE: base.anthropic,
      LANE_C_KEY: bundle({ openai: 'oai-key-1\noai-key-2', 'command-code': 'cc-key' }),
      LANE_C_API_BASE: bundle({ openai: base.openai, 'command-code': base['command-code'] }),
    };
  }
  return {
    LANE_A_KEY: 'go-key', LANE_A_API_BASE: base['opencode-go'],
    LANE_B_KEY: bundle({ 'opencode-go': 'go-key', anthropic: 'anth-key' }),
    LANE_B_API_BASE: bundle({ 'opencode-go': base['opencode-go'], anthropic: base.anthropic }),
    LANE_C_KEY: bundle({ 'command-code': 'cc-key', openai: 'oai-key-1' }),
    LANE_C_API_BASE: bundle({ 'command-code': base['command-code'], openai: base.openai }),
  };
}

const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
const report = { summary: 'ok', reviewed_files: ['src/a.ts'], findings: [], limitations: [] };
const outcomes = {
  ok: (model) => reply(200, { model, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(report), reasoning_content: 'thinking' } }], usage: { prompt_tokens: 1 } }),
  quota: (model, provider) => ({
    'opencode-go': reply(429, { error: { type: 'GoUsageLimitError', message: 'weekly usage limit reached' } }),
    'command-code': reply(400, { error: { type: 'invalid_request_error', message: 'You have insufficient credits to make this request.' } }),
    anthropic: reply(402, { error: { type: 'billing_error', message: 'credit balance is too low' } }),
    openai: reply(429, { error: { code: 'insufficient_quota', message: 'You exceeded your current quota' } }),
  })[provider],
  down: () => reply(503, { error: { message: 'upstream overloaded' } }),
  auth: () => reply(401, { error: { type: 'authentication_error', message: 'invalid api key' } }),
};
// Each scenario names the outcome per provider; `keys` and `models` override it for one key or model.
const scenarios = {
  'all-ok': {},
  'go-quota': { 'opencode-go': 'quota' },
  'go-down': { 'opencode-go': 'down' },
  'cc-credit': { 'command-code': 'quota' },
  'go-quota+cc-credit': { 'opencode-go': 'quota', 'command-code': 'quota' },
  'go-quota+cc-down': { 'opencode-go': 'quota', 'command-code': 'down' },
  'go-down+cc-credit': { 'opencode-go': 'down', 'command-code': 'quota' },
  'go-auth': { 'opencode-go': 'auth' },
  'anthropic-credit': { anthropic: 'quota' },
  'openai-key1-quota': { keys: { 'oai-key-1': 'quota' } },
  'openai-quota': { openai: 'quota' },
  'plans-spent+openai-key1-quota': { 'opencode-go': 'quota', 'command-code': 'quota', keys: { 'oai-key-1': 'quota' } },
  'all-down': { 'opencode-go': 'down', 'command-code': 'down', anthropic: 'down', openai: 'down' },
  'all-spent': { 'opencode-go': 'quota', 'command-code': 'quota', anthropic: 'quota', openai: 'quota' },
  'first-pass-down': { models: { 'claude-sonnet-5-5': 'down', 'gpt-6.2-sol': 'down', 'gpt-6.1-sol': 'down' } },
};
const focus = { A: 'Additional focus: state changes', B: 'Additional focus: authorization', C: 'Additional focus: cross-file contracts' };
const systemOf = (payload) => typeof payload.system === 'string' ? payload.system : (payload.input || payload.messages)?.[0]?.content || '';

async function run(config, scenarioName, runnerEnv = { RUNNER_ENVIRONMENT: 'github-hosted' }) {
  const scenario = scenarios[scenarioName];
  const [owner, repo] = config.repository.split('/');
  const attempts = { A: [], B: [], C: [] };
  const requests = [];
  const comments = [];
  const headSha = 'deadbeef'.repeat(5);
  const pull = { number: 42, title: 'Test', state: 'open', user: { login: 'octocat' }, base: { ref: 'main' },
    head: { ref: 'feature', sha: headSha }, body: '' };
  const files = [{ filename: 'src/a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@ -1,1 +1,2 @@\n-a\n+b\n+c' }];
  const github = {
    rest: {
      pulls: { get: async () => ({ data: pull }), listFiles: 'files', listCommits: 'commits' },
      repos: { getContent: async () => { throw new Error('not found'); }, compareCommitsWithBasehead: async () => { throw new Error('none'); } },
      issues: {
        get: async () => { throw new Error('not found'); }, listComments: 'comments',
        createComment: async ({ body }) => { const comment = { id: comments.length + 1, user: { login: 'github-actions[bot]' }, body }; comments.push(comment); return { data: comment }; },
        updateComment: async ({ comment_id, body }) => { const comment = comments.find(({ id }) => id === comment_id); comment.body = body; return { data: comment }; },
        deleteComment: async () => {},
      },
    },
    paginate: async (which) => which === 'files' ? files : which === 'comments' ? comments : which === 'commits' ? [{ sha: headSha, commit: { message: 'test' } }] : [],
  };
  const requestChatCompletion = async ({ apiKey, baseURL, payload, protocol, proxyUrl, sessionId }) => {
    const provider = providerOf(baseURL);
    const lane = Object.keys(focus).find((id) => systemOf(payload).includes(focus[id])) ?? '?';
    requests.push({ lane, provider, protocol, proxyUrl, sessionId, payload });
    attempts[lane].push(`${provider} ${payload.model} ${apiKey}`);
    const outcome = scenario.models?.[payload.model] ?? scenario.keys?.[apiKey] ?? scenario[provider] ?? 'ok';
    return outcomes[outcome](payload.model, provider);
  };
  const env = { ...slotsFor(config.repository), ...runnerEnv, PR_REVIEW_CONFIG: JSON.stringify(config),
    PR_REVIEW_WORKFLOW_SHA: 'feedface'.repeat(5) };
  let error = null;
  try {
    await runReview({ github, env, context: { eventName: 'pull_request', payload: { pull_request: { number: 42, head: { sha: headSha } } },
      repo: { owner, repo }, serverUrl: 'https://github.com', runId: 1 },
    fetch: async () => { throw new Error('no network'); }, logger: { log: () => {} }, sdk: { requestChatCompletion }, maskSecret: () => {} });
  } catch (caught) {
    error = String(caught.message).replace(/deadbeef+/g, '<head>');
  }
  const lanes = {};
  for (const id of ['A', 'B', 'C']) {
    const body = comments.find((comment) => comment.body.startsWith(`<!-- ai-pr-review-bot:lane-${id} -->\n`))?.body;
    if (!body && !attempts[id].length) continue;
    const lines = (body || '').split('\n');
    lanes[id] = {
      attempts: attempts[id],
      status: /status=(\w+) -->/.exec(body || '')?.[1] ?? null,
      title: lines.find((line) => line.startsWith('## ')) ?? null,
      banners: lines.filter((line) => line.startsWith('> ℹ️') || line.startsWith('> ⛔')),
      footer: /<sub>(.*?) · Thinking/.exec(body || '')?.[1] ?? null,
      tried: /Tried: (.*)\.$/m.exec(body || '')?.[1] ?? null,
      action: lines.find((line) => line.startsWith('Action needed:')) ?? null,
    };
  }
  return { error, lanes, requests };
}

const results = {};
for (const file of fs.readdirSync(configDir).filter((name) => name.endsWith('.json')).sort()) {
  const config = JSON.parse(fs.readFileSync(path.join(configDir, file), 'utf8'));
  for (const name of Object.keys(scenarios)) {
    const { error, lanes } = await run(config, name);
    results[`${file.replace('.json', '')} :: ${name}`] = { error, lanes };
  }
}
if (process.argv.includes('--write')) {
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, JSON.stringify(results, null, 1) + '\n');
  console.log(`wrote ${Object.keys(results).length} route-table cases to ${path.relative(process.cwd(), fixture)}`);
} else {
  const expected = JSON.parse(fs.readFileSync(fixture, 'utf8'));
  let failures = 0;
  for (const key of new Set([...Object.keys(expected), ...Object.keys(results)])) {
    const want = JSON.stringify(expected[key]);
    const got = JSON.stringify(results[key]);
    if (want !== got) {
      failures++;
      if (failures <= 5) console.log(`FAIL ${key}\n  expected ${want}\n  actual   ${got}`);
    }
  }
  console.log(`${failures ? 'FAIL' : 'ok  '} route table: ${Object.keys(results).length - failures}/${Object.keys(results).length} cases unchanged`);
  if (failures) process.exitCode = 1;

  // Lane C outside NebulaLab on a self-hosted runner (License-Service): MiniMax M3.1 Flash goes to Go
  // first, directly (it is in the direct Go list, verified from szlab on 2026-11-18), as Chat
  // Completions with its 131,072-token ceiling, no effort field (it thinks deepest without one) and
  // the lane's Go session; then the same request goes to Command Code under its own id.
  const license = JSON.parse(fs.readFileSync(path.join(configDir, 'TshyGO__NebulaGraph-License-Service.json'), 'utf8'));
  const { requests } = await run(license, 'go-down', { RUNNER_ENVIRONMENT: 'self-hosted', NEBULA_REVIEW_PROXY_URL: 'http://192.168.122.1:17890' });
  const laneC = requests.filter((request) => request.lane === 'C');
  const ok = laneC.length === 2
    && laneC[0].provider === 'opencode-go' && laneC[0].protocol === 'openai-chat-completions' && laneC[0].proxyUrl === undefined
    && laneC[0].payload.model === 'minimax-m3.1-flash' && laneC[0].payload.max_tokens === 131072
    && !('reasoning_effort' in laneC[0].payload) && !('reasoning' in laneC[0].payload)
    && laneC[0].sessionId === 'TshyGO-NebulaGraph-License-Service-pr-42-lane-C'
    && laneC[1].provider === 'command-code' && laneC[1].payload.model === 'minimax/minimax-m3.1-flash'
    && laneC[1].payload.max_tokens === 131072 && laneC[1].sessionId === undefined;
  console.log(`${ok ? 'ok  ' : 'FAIL'} self-hosted Lane C sends MiniMax M3.1 Flash to Go directly, then to Command Code`);
  if (!ok) { console.log(JSON.stringify(laneC.map(({ payload, ...rest }) => ({ ...rest, model: payload.model, max_tokens: payload.max_tokens })))); process.exitCode = 1; }
}
