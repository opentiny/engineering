import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import {
  createTrustPlan,
  generateTrustScript,
  normalizeTrust,
  parseTrustListOutput,
} from '../scripts/npm/generate-trust-script.mjs'

const desired = {
  provider: 'github',
  repository: 'opentiny/foo',
  workflow: 'npm-publish.yml',
  allowPublish: true,
}

test('parses npm list JSON including npm multi-document output', () => {
  const output = '{"id":"one","type":"github"}\n\n{"id":"two","type":"gitlab"}\n'
  assert.deepEqual(parseTrustListOutput(output).map((item) => item.id), ['one', 'two'])
  assert.deepEqual(parseTrustListOutput('[]'), [])
})

test('rejects malformed or partially parsed npm trust output with the original parse error', () => {
  for (const output of [
    '{"id":"one"} trailing-data',
    '{"id":"one"}\n{"id":',
    '{"id":"one"}\nnot-json\n{"id":"two"}',
  ]) {
    assert.throws(
      () => parseTrustListOutput(output),
      /npm trust list returned invalid JSON: .*Initial JSON\.parse error:/,
    )
  }
})

test('normalizes flattened CLI and registry trust shapes', () => {
  assert.deepEqual(normalizeTrust({
    id: 'one', type: 'github', repository: 'opentiny/foo', file: 'npm-publish.yml', permissions: ['createPackage'],
  }), { id: 'one', provider: 'github', repository: 'opentiny/foo', workflow: 'npm-publish.yml', environment: '', allowPublish: true })
  assert.equal(normalizeTrust({
    id: 'two', type: 'github', claims: { repository: 'opentiny/foo', workflow_ref: { file: 'release.yml' } }, permissions: [],
  }).workflow, 'release.yml')
})

test('creates, skips, and replaces incrementally', () => {
  assert.equal(createTrustPlan([], desired).action, 'create')
  assert.equal(createTrustPlan([{
    id: 'one', type: 'github', repository: 'opentiny/foo', file: 'npm-publish.yml', permissions: ['createPackage'],
  }], desired).action, 'skip')
  assert.equal(createTrustPlan([{
    id: 'no-publish', type: 'github', repository: 'opentiny/foo', file: 'npm-publish.yml', permissions: [],
  }], desired).action, 'replace')
  const replacement = createTrustPlan([{
    id: 'one', type: 'github', repository: 'opentiny/foo', file: 'release.yml', permissions: ['createPackage'],
  }], desired)
  assert.equal(replacement.action, 'replace')
  assert.deepEqual(replacement.revokeIds, ['one'])
  assert.throws(() => createTrustPlan([{ type: 'github' }], desired), /revocable id/)
})

test('replaces environment-restricted trusts for a target without an environment', () => {
  for (const trust of [
    { id: 'old', type: 'github', repository: 'opentiny/foo', file: 'npm-publish.yml', environment: 'production', permissions: ['createPackage'] },
    { id: 'old', type: 'github', claims: { repository: 'opentiny/foo', workflow_ref: { file: 'npm-publish.yml' }, environment: 'production' }, permissions: ['createPackage'] },
  ]) {
    assert.equal(normalizeTrust(trust).environment, 'production')
    assert.equal(createTrustPlan([trust], desired).action, 'replace')
    assert.equal(createTrustPlan([trust], { ...desired, environment: 'production' }).action, 'skip')
  }
})

test('generates a standalone script with one confirmation and exact revoke syntax', () => {
  const script = generateTrustScript({
    repository: 'opentiny/foo',
    workflow: 'npm-publish.yml',
    packages: [{ name: '@opentiny/foo' }, { name: '@opentiny/foo-kit' }],
  })
  assert.match(script, /Apply these changes\? \[y\/N\]/)
  assert.match(script, /npm trust revoke "\$package" --id="\$trust_id"/)
  assert.match(script, /npm trust github "\$package" --repo "\$REPOSITORY" --file "\$WORKFLOW" --allow-publish --yes/)
  assert.equal((script.match(/Apply these changes/g) ?? []).length, 1)
  assert.doesNotMatch(script, /done < <\(/)
  assert.match(script, /if ! node .* revokeIds > "\$revoke_ids_file"/)
})

test('generated script aborts before create when revoke id extraction fails', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-trust-field-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npm.log')
  const scriptFile = path.join(root, 'apply.sh')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'npm'), String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1 $2" == "trust --help" ]]; then exit 0; fi
if [[ "$1 $2" == "trust list" ]]; then
  printf '%s\n' '{"id":"old","type":"github","repository":"opentiny/foo","file":"release.yml","permissions":["createPackage"]}'
fi
`)
  await fs.writeFile(path.join(bin, 'node'), `#!/usr/bin/env bash
if [[ "\${2:-}" == "field" && "\${4:-}" == "revokeIds" ]]; then exit 23; fi
exec ${JSON.stringify(process.execPath)} "$@"
`)
  await fs.writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  await Promise.all(['npm', 'node', 'sleep'].map((name) => fs.chmod(path.join(bin, name), 0o755)))
  await fs.writeFile(scriptFile, generateTrustScript({
    repository: 'opentiny/foo', workflow: 'npm-publish.yml', packages: [{ name: '@opentiny/foo' }],
  }))
  const execution = spawnSync('bash', [scriptFile, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log },
  })
  assert.notEqual(execution.status, 0)
  assert.match(execution.stderr, /Failed to read revoke ids/)
  assert.match(execution.stderr, /No npm trust mutations were started/)
  const calls = await fs.readFile(log, 'utf8')
  assert.doesNotMatch(calls, /trust (?:revoke|github)/)
})

test('generated script stops without mutations for invalid trust state or failed queries', async (t) => {
  for (const scenario of [
    { output: '{"id":"old"} trailing-data', status: 0, error: /invalid JSON/ },
    { output: '{"type":"github","file":"release.yml"}', status: 0, error: /no revocable id/ },
    { output: '', status: 17, error: /update failed for @opentiny\/foo/ },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-trust-invalid-state-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const bin = path.join(root, 'bin')
    const log = path.join(root, 'npm.log')
    const scriptFile = path.join(root, 'apply.sh')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, 'npm'), String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1 $2" == "trust list" ]]; then
  printf '%s\n' "$FAKE_NPM_OUTPUT"
  exit "$FAKE_NPM_STATUS"
fi
`)
    await fs.chmod(path.join(bin, 'npm'), 0o755)
    await fs.writeFile(scriptFile, generateTrustScript({
      repository: 'opentiny/foo', workflow: 'npm-publish.yml', packages: [{ name: '@opentiny/foo' }],
    }))
    const execution = spawnSync('bash', [scriptFile, '--yes'], {
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log,
        FAKE_NPM_OUTPUT: scenario.output, FAKE_NPM_STATUS: String(scenario.status),
      },
    })
    assert.notEqual(execution.status, 0)
    assert.match(execution.stderr, scenario.error)
    assert.match(execution.stderr, /No npm trust mutations were started/)
    assert.doesNotMatch(await fs.readFile(log, 'utf8'), /trust (?:revoke|github)/)
  }
})

test('generated script reports recovery instructions after a partial replacement', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-trust-partial-failure-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npm.log')
  const scriptFile = path.join(root, 'apply.sh')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'npm'), String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1 $2" == "trust --help" ]]; then exit 0; fi
if [[ "$1 $2" == "trust list" ]]; then
  printf '%s\n' '{"id":"old","type":"github","repository":"opentiny/foo","file":"release.yml","permissions":["createPackage"]}'
fi
if [[ "$1 $2" == "trust github" ]]; then exit 17; fi
`)
  await fs.writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  await Promise.all(['npm', 'sleep'].map((name) => fs.chmod(path.join(bin, name), 0o755)))
  await fs.writeFile(scriptFile, generateTrustScript({
    repository: 'opentiny/foo', workflow: 'npm-publish.yml', packages: [{ name: '@opentiny/foo' }],
  }))
  const execution = spawnSync('bash', [scriptFile, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log },
  })
  assert.notEqual(execution.status, 0)
  assert.match(execution.stderr, /Some npm changes may already have been applied/)
  assert.match(execution.stderr, /generate a fresh plan, and rerun it/)
  const calls = await fs.readFile(log, 'utf8')
  assert.match(calls, /trust revoke @opentiny\/foo --id=old/)
  assert.match(calls, /trust github @opentiny\/foo/)
})

test('generated script reads every state before applying create, skip, and replace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-trust-script-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const bin = path.join(root, 'bin')
  const log = path.join(root, 'npm.log')
  const scriptFile = path.join(root, 'apply.sh')
  await fs.mkdir(bin)
  await fs.writeFile(path.join(bin, 'npm'), String.raw`#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$FAKE_NPM_LOG"
if [[ "$1 $2" == "trust --help" ]]; then exit 0; fi
if [[ "$1 $2" == "trust list" ]]; then
  case "$3" in
    @opentiny/a) printf '%s\n' '[]' ;;
    @opentiny/b) printf '%s\n' '{"id":"keep","type":"github","repository":"opentiny/foo","file":"npm-publish.yml","permissions":["createPackage"]}' ;;
    @opentiny/c) printf '%s\n' '{"id":"old","type":"github","repository":"opentiny/foo","file":"release.yml","permissions":["createPackage"]}' ;;
    @opentiny/d) printf '%s\n' '{"id":"environment-old","type":"github","repository":"opentiny/foo","file":"npm-publish.yml","environment":"production","permissions":["createPackage"]}' ;;
  esac
fi
`)
  await fs.writeFile(path.join(bin, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  await fs.chmod(path.join(bin, 'npm'), 0o755)
  await fs.chmod(path.join(bin, 'sleep'), 0o755)
  await fs.writeFile(scriptFile, generateTrustScript({
    repository: 'opentiny/foo',
    workflow: 'npm-publish.yml',
    packages: [{ name: '@opentiny/a' }, { name: '@opentiny/b' }, { name: '@opentiny/c' }, { name: '@opentiny/d' }],
  }))
  const execution = spawnSync('bash', [scriptFile, '--yes'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_NPM_LOG: log },
  })
  assert.equal(execution.status, 0, execution.stderr)
  assert.match(execution.stdout, /unchanged: 1[\s\S]*create:    1[\s\S]*replace:   2/)
  assert.match(execution.stdout, /environment=production/)
  assert.match(execution.stdout, /environment=\(none\)/)
  const calls = await fs.readFile(log, 'utf8')
  const callLines = calls.trim().split('\n')
  const lastList = callLines.findLastIndex((line) => line.startsWith('trust list'))
  const firstMutation = callLines.findIndex((line) => /^trust (?:github|revoke)/.test(line))
  assert.ok(lastList < firstMutation, 'all list calls should happen before mutations')
  assert.match(calls, /trust revoke @opentiny\/c --id=old/)
  assert.match(calls, /trust revoke @opentiny\/d --id=environment-old/)
  assert.match(calls, /trust github @opentiny\/d/)
  assert.match(calls, /trust github @opentiny\/a --repo opentiny\/foo --file npm-publish.yml --allow-publish --yes/)
  assert.doesNotMatch(calls, /trust github @opentiny\/b/)
})
