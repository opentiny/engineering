import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  discoverPackages,
  repositoryFromPackageJson,
} from '../scripts/npm/discover-packages.mjs'

async function makeRepository(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-discovery-'))
  await Promise.all(Object.entries(files).map(async ([name, contents]) => {
    const file = path.join(root, name)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents))
  }))
  return root
}

test('discovers a publishable single package', async (t) => {
  const root = await makeRepository({
    'package.json': { name: '@opentiny/foo', repository: 'https://github.com/opentiny/foo.git' },
    '.github/workflows/npm-publish.yml': 'name: publish\n',
  })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await discoverPackages({ root, repository: 'opentiny/foo' })
  assert.deepEqual(result.packages, [{ name: '@opentiny/foo', path: '.' }])
  assert.equal(result.workflowExists, true)
  assert.deepEqual(result.warnings, [])
})

test('merges npm object workspaces and pnpm patterns and filters packages', async (t) => {
  const root = await makeRepository({
    'package.json': { private: true, workspaces: { packages: ['modules/*'] } },
    'pnpm-workspace.yaml': "packages:\n  - 'plugins/**'\n  - '!plugins/examples/**'\n",
    'modules/a/package.json': { name: '@opentiny/a' },
    'modules/private/package.json': { name: '@opentiny/private', private: true },
    'plugins/nested/b/package.json': { name: '@opentiny/b', repository: { type: 'git', url: 'git+https://github.com/opentiny/wrong.git' } },
    'plugins/examples/demo/package.json': { name: '@opentiny/demo' },
    'plugins/external/package.json': { name: '@other/external' },
    'plugins/evil/package.json': { name: '@opentiny/evil', publishConfig: { registry: 'https://registry.npmjs.org.evil.example' } },
  })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await discoverPackages({ root, repository: 'opentiny/project' })
  assert.deepEqual(result.packages.map((item) => item.name), ['@opentiny/a', '@opentiny/b'])
  assert.equal(result.workflowExists, false)
  assert.ok(result.warnings.some((warning) => warning.includes('@other/external')))
  assert.ok(result.warnings.some((warning) => warning.includes('@opentiny/evil')))
  assert.ok(result.warnings.some((warning) => warning.includes('opentiny/wrong')))
  assert.ok(result.warnings.some((warning) => warning.includes('Required workflow is missing')))
})

test('supports common GitHub repository metadata forms', () => {
  assert.equal(repositoryFromPackageJson('git@github.com:opentiny/foo.git'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson({ url: 'git+https://github.com/opentiny/foo.git' }), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('github:opentiny/foo'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('opentiny/foo'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('https://example.com/opentiny/foo'), null)
})
