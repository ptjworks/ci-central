import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/set-lane-secret.ps1', import.meta.url));
// Outside CI a machine without pwsh skips these tests; in CI a missing pwsh fails them.
const skip = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0']).status === 0 || process.env.CI
  ? false : 'pwsh is not installed';
// Since the 2026-11-03 last resort their Lane B and C slots are bundles; NebulaLab's are C only.
const otherCallers = ['ptjworks/ci-central', 'ptjworks/NebulaLab-Docs', 'ptjworks/NebulaLab-Plugins',
  'ptjworks/resume-form-assistant-plugin', 'ptjworks/AI-Thesis-Polisher', 'TshyGO/NebulaGraph-License-Service'];

// -NonInteractive makes the key prompt fail at once, so a run that stops in Read-Host has passed
// every repository check. Errors print as "<command>|<message>" to avoid the wrapped error view.
// A stub gh records any attempt to write a secret.
function run(args) {
  const bin = mkdtempSync(join(tmpdir(), 'set-lane-secret-'));
  const marker = join(bin, 'gh-called');
  writeFileSync(join(bin, 'gh'), `#!/bin/sh\necho called > "${marker}"\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'gh.cmd'), `@echo called > "${marker}"\r\n@exit /b 1\r\n`);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') || 'PATH';
  const command = `try { & '${script}' ${args} } catch { [Console]::Error.WriteLine("$($_.InvocationInfo.MyCommand.Name)|$($_.Exception.Message)"); exit 1 }`;
  try {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', command],
      { encoding: 'utf8', env: { ...process.env, [pathKey]: `${bin}${delimiter}${process.env[pathKey]}` } });
    return { status: result.status, output: `${result.stdout}${result.stderr}`, ghCalled: existsSync(marker) };
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
}

test('Lane B and C rotations refuse the default list and name every bundle repository', { skip }, () => {
  for (const [lane, bundled] of [['C', ['TshyGO/NebulaLab', ...otherCallers]], ['B', otherCallers]]) {
    const result = run(`-Lane ${lane} -ApiBase https://lane.invalid/v1`);
    assert.notEqual(result.status, 0, lane);
    assert.match(result.output, /provider credential bundle/, lane);
    for (const name of bundled) assert.ok(result.output.includes(name), `${lane}: ${name}`);
    assert.doesNotMatch(result.output, /^Read-Host\|/m, lane);
    assert.equal(result.ghCalled, false, lane);
  }
});

test('NebulaLab\'s two-account Lane B is refused alone and next to a bundle repository', { skip }, () => {
  for (const [args, reason] of [
    [`-Lane B -ApiBase https://anthropic.invalid/v1 -Repositories 'TshyGO/NebulaLab'`, /one key per account in TshyGO\/NebulaLab/],
    [`-Lane B -ApiBase https://anthropic.invalid/v1 -Repositories 'TshyGO/NebulaLab','ptjworks/NebulaLab-Docs'`, /provider credential bundle in ptjworks\/NebulaLab-Docs\./],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args);
    assert.match(result.output, reason, args);
    assert.doesNotMatch(result.output, /^Read-Host\|/m, args);
    assert.equal(result.ghCalled, false, args);
  }
});

test('a differently cased name still finds the bundle, and a target without a config is refused', { skip }, () => {
  for (const [args, reason] of [
    [`-Lane C -ApiBase https://cc.invalid/v1 -Repositories 'tshygo/nebulalab'`, /provider credential bundle/],
    [`-Lane C -ApiBase https://cc.invalid/v1 -Repositories 'ptjworks/no-such-caller'`, /No central config .*ptjworks\/no-such-caller/],
  ]) {
    const result = run(args);
    assert.notEqual(result.status, 0, args);
    assert.match(result.output, reason, args);
    assert.doesNotMatch(result.output, /^Read-Host\|/m, args);
    assert.equal(result.ghCalled, false, args);
  }
});

test('plain Lane A slots still reach the key prompt', { skip }, () => {
  for (const args of [
    '-Lane A -ApiBase https://go.invalid/v1',
    `-Lane A -ApiBase https://go.invalid/v1 -Repositories 'TSHYGO/NebulaLab','ptjworks/nebulalab-docs'`,
  ]) {
    const result = run(args);
    assert.doesNotMatch(result.output, /provider credential bundle|one key per account/, args);
    assert.match(result.output, /^Read-Host\|/m, args);
    assert.equal(result.ghCalled, false, args);
  }
});
