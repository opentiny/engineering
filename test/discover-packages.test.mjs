import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  discoverPackages,
  normalizeWorkspacePattern,
  pathExists,
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

test('discovers the root package when pnpm config has no packages field', async (t) => {
  for (const configuration of ['onlyBuiltDependencies:\n  - esbuild\n', '']) {
    const root = await makeRepository({
      'package.json': { name: '@opentiny/foo' },
      'pnpm-workspace.yaml': configuration,
      '.github/workflows/npm-publish.yml': 'name: publish\n',
    })
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const result = await discoverPackages({ root, repository: 'opentiny/foo' })
    assert.deepEqual(result.packages, [{ name: '@opentiny/foo', path: '.' }])
    assert.deepEqual(result.warnings, [])
  }
})

test('discovers npm-valid names with punctuation without filtering them out', async (t) => {
  const names = ['foo-', 'foo_', 'foo.', 'foo..bar', '-foo', '_foo'].map((name) => `@opentiny/${name}`)
  const root = await makeRepository({
    'package.json': { private: true, workspaces: ['packages/*'] },
    ...Object.fromEntries(names.map((name, index) => [`packages/${index}/package.json`, { name }])),
    '.github/workflows/npm-publish.yml': 'name: publish\n',
  })
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const result = await discoverPackages({ root, repository: 'opentiny/foo' })
  assert.deepEqual(new Set(result.packages.map((item) => item.name)), new Set(names))
  assert.deepEqual(result.warnings, [])
})

test('rejects an explicit non-array pnpm packages field', async (t) => {
  for (const configuration of ['packages: modules/*\n', 'packages: null\n']) {
    const root = await makeRepository({
      'package.json': { name: '@opentiny/foo' },
      'pnpm-workspace.yaml': configuration,
    })
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    await assert.rejects(discoverPackages({ root, repository: 'opentiny/foo' }), /packages must be an array/)
  }
})

test('supports common GitHub repository metadata forms', () => {
  assert.equal(repositoryFromPackageJson('git@github.com:opentiny/foo.git'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson({ url: 'git+https://github.com/opentiny/foo.git' }), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('github:opentiny/foo'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('opentiny/foo'), 'opentiny/foo')
  assert.equal(repositoryFromPackageJson('https://example.com/opentiny/foo'), null)
})

test('rejects workspace patterns that can escape the repository', () => {
  assert.equal(normalizeWorkspacePattern('./packages/*/'), 'packages/*/package.json')
  for (const pattern of ['../outside', '!../outside', '/tmp/packages', '!/tmp/packages', 'C:\\outside', '!C:\\outside']) {
    assert.throws(() => normalizeWorkspacePattern(pattern), /Unsafe workspace pattern/)
  }
})

test('treats only ENOENT as a missing path', async () => {
  assert.equal(await pathExists('/missing', async () => {
    throw Object.assign(new Error('missing'), { code: 'ENOENT' })
  }), false)
  await assert.rejects(pathExists('/unreadable', async () => {
    throw Object.assign(new Error('denied'), { code: 'EACCES' })
  }), /Unable to access \/unreadable: denied/)
})
