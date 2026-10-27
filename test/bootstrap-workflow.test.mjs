import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import YAML from 'yaml'
import { createBootstrapPackage } from '../scripts/npm/bootstrap-package.mjs'

const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/npm-bootstrap.yml', import.meta.url), 'utf8'))
const steps = workflow.jobs.bootstrap.steps

function run(command, args, env) {
  const result = spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } })
  assert.equal(result.status, 0, `${command}: ${result.stderr}\n${result.stdout}`)
  return result.stdout
}

test('defaults to token-free preparation and gates only publication behind the protected environment', () => {
  assert.deepEqual(workflow.on.workflow_dispatch.inputs.publish, {
    description: 'Publish to npm (requires NPM_BOOTSTRAP_TOKEN in the npm-bootstrap environment)',
    required: false, default: false, type: 'boolean',
  })
  assert.equal(workflow.jobs.bootstrap.environment, undefined)
  assert.doesNotMatch(JSON.stringify(workflow.jobs.bootstrap), /secrets\.|NODE_AUTH_TOKEN|registry-url|npm publish/)
  assert.equal(workflow.jobs.publish.if, '${{ inputs.publish == true }}')
  assert.equal(workflow.jobs.publish.needs, 'bootstrap')
  assert.equal(workflow.jobs.publish.environment, 'npm-bootstrap')
  const upload = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))
  const download = workflow.jobs.publish.steps.find((step) => step.uses?.startsWith('actions/download-artifact@'))
  assert.equal(upload.with.name, download.with.name)
  assert.equal(upload.with['if-no-files-found'], 'error')
  assert.equal(upload.with['retention-days'], 7)
  const publish = workflow.jobs.publish.steps.find((step) => step.name === 'Publish @opentiny placeholder')
  assert.match(publish.run, /npm publish "\$RUNNER_TEMP\/npm-bootstrap-artifact\/placeholder.tgz"/)
})

for (const requested of ['false', 'true']) {
  test(`real packing, artifact instructions, publish dry-run and cleanup (publish=${requested})`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-bootstrap-workflow-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const result = await createBootstrapPackage({
      packageName: '@opentiny/bootstrap-workflow-test', repository: 'opentiny/foo',
      workflow: 'custom-publish.yml', temporaryRoot: root,
      fetchImpl: async () => ({ status: 404, ok: false }),
    })
    const resultFile = path.join(root, 'npm-bootstrap-result.json')
    const artifact = path.join(root, 'npm-bootstrap-artifact')
    const summaryFile = path.join(root, 'summary.md')
    await fs.writeFile(resultFile, JSON.stringify(result))
    const env = {
      BOOTSTRAP_RESULT: resultFile, BOOTSTRAP_ARTIFACT: artifact,
      PUBLISH_REQUESTED: requested, GITHUB_STEP_SUMMARY: summaryFile, RUNNER_TEMP: root,
      NODE_AUTH_TOKEN: '', npm_config_cache: path.join(root, 'cache'),
      // Keep local user credentials and npm settings out of this test.
      NPM_CONFIG_USERCONFIG: path.join(root, 'empty.npmrc'),
    }
    await fs.writeFile(env.NPM_CONFIG_USERCONFIG, '')
    run('bash', ['-e', '-o', 'pipefail', '-c', steps.find((step) => step.name === 'Pack placeholder and write instructions').run], env)
    assert.deepEqual((await fs.readdir(artifact)).sort(), ['README.md', 'placeholder.tgz'])
    const instructions = await fs.readFile(path.join(artifact, 'README.md'), 'utf8')
    assert.equal(await fs.readFile(summaryFile, 'utf8'), instructions)
    assert.match(instructions, /has not published to npm/)
    assert.match(instructions, requested === 'true' ? /Check the separate protected publish job/ : /No npm token is required in GitHub/)
    assert.match(instructions, /npm login --registry https:\/\/registry.npmjs.org/)
    assert.match(instructions, /npm publish .\/placeholder.tgz --access public/)
    assert.match(instructions, /Only after successful publication/)
    assert.match(instructions, /npm trust github @opentiny\/bootstrap-workflow-test \\\n  --repo opentiny\/foo \\\n  --file custom-publish.yml/)
    const archive = path.join(artifact, 'placeholder.tgz')
    const entries = run('tar', ['-tzf', archive], env).trim().split('\n').sort()
    assert.deepEqual(entries, ['package/index.js', 'package/package.json'])
    const extracted = path.join(root, 'unpacked')
    await fs.mkdir(extracted)
    run('tar', ['-xzf', archive, '-C', extracted], env)
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(extracted, 'package/package.json'))), {
      name: result.package, version: '0.0.0', main: 'index.js',
    })
    assert.equal(run('node', ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(extracted, 'package')], env).trim(), '{}')
    const dryRun = JSON.parse(run('npm', ['publish', archive, '--dry-run', '--json', '--access', 'public', '--registry', 'https://registry.npmjs.org'], env))
    const published = Array.isArray(dryRun) ? dryRun[0] : (dryRun[result.package] ?? dryRun)
    assert.equal(published.name, result.package, JSON.stringify(dryRun))
    assert.equal(published.version, '0.0.0')
    const cleanup = steps.find((step) => step.name === 'Remove temporary placeholder')
    assert.equal(cleanup.if, '${{ always() }}')
    run('bash', ['-e', '-o', 'pipefail', '-c', cleanup.run], env)
    await assert.rejects(fs.stat(result.directory), { code: 'ENOENT' })
    assert.ok((await fs.stat(archive)).size > 0)
  })
}

test('explicit publication fails clearly without a token before invoking npm', () => {
  const publish = workflow.jobs.publish.steps.find((step) => step.name === 'Publish @opentiny placeholder')
  const result = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', publish.run], {
    encoding: 'utf8', env: { ...process.env, NODE_AUTH_TOKEN: '' },
  })
  assert.equal(result.status, 1)
  assert.match(result.stdout, /Set NPM_BOOTSTRAP_TOKEN/)
  assert.doesNotMatch(result.stderr, /npm/)
})
