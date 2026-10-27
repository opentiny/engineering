import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createBootstrapPackage, packageExists } from '../scripts/npm/bootstrap-package.mjs'

test('distinguishes missing, existing, and registry failures', async () => {
  assert.equal(await packageExists('@opentiny/foo', async () => ({ status: 404, ok: false })), false)
  assert.equal(await packageExists('@opentiny/foo', async () => ({ status: 200, ok: true })), true)
  await assert.rejects(packageExists('@opentiny/foo', async () => ({ status: 503, ok: false })), /HTTP 503/)
})

test('checks only the official registry and authenticates without logging the token', async () => {
  let request
  await packageExists('@opentiny/foo', async (url, options) => {
    request = { url, options }
    return { status: 404, ok: false }
  }, 'secret-token')
  assert.equal(request.url, 'https://registry.npmjs.org/@opentiny%2ffoo')
  assert.equal(request.options.headers.authorization, 'Bearer secret-token')
})

test('creates only the minimal isolated placeholder package', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-bootstrap-test-'))
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }))
  const result = await createBootstrapPackage({
    packageName: '@opentiny/foo',
    repository: 'opentiny/foo',
    temporaryRoot,
    fetchImpl: async () => ({ status: 404, ok: false }),
  })
  assert.equal(path.dirname(result.directory), temporaryRoot)
  assert.deepEqual((await fs.readdir(result.directory)).sort(), ['index.js', 'package.json'])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(result.directory, 'package.json'))), {
    name: '@opentiny/foo', version: '0.0.0', main: 'index.js',
  })
  assert.equal(await fs.readFile(path.join(result.directory, 'index.js'), 'utf8'), 'module.exports = {}\n')
})

test('does not create a directory when the package already exists', async (t) => {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-bootstrap-existing-'))
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }))
  await assert.rejects(createBootstrapPackage({
    packageName: '@opentiny/foo',
    repository: 'opentiny/foo',
    temporaryRoot,
    fetchImpl: async () => ({ status: 200, ok: true }),
  }), /already exists/)
  assert.deepEqual(await fs.readdir(temporaryRoot), [])
})
