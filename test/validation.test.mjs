import assert from 'node:assert/strict'
import test from 'node:test'
import {
  shellQuote,
  validatePackageName,
  validateRepository,
  validateWorkflow,
} from '../scripts/npm/validation.mjs'

test('accepts the organization identity contract', () => {
  assert.equal(validatePackageName('@opentiny/tiny-robot.vue'), '@opentiny/tiny-robot.vue')
  assert.equal(validateRepository('opentiny/tiny-robot'), 'opentiny/tiny-robot')
  assert.equal(validateWorkflow('npm-publish.yml'), 'npm-publish.yml')
  assert.equal(validateWorkflow(''), 'npm-publish.yml')
})

test('rejects malicious and out-of-scope inputs', () => {
  for (const value of ['react', 'foo', '@other/foo', '@opentiny/Foo', '@opentiny/foo;id', '@opentiny/.foo', '@opentiny/foo-']) {
    assert.throws(() => validatePackageName(value))
  }
  for (const value of ['other/foo', 'opentiny/foo/bar', 'opentiny/foo;id', 'opentiny/../foo']) {
    assert.throws(() => validateRepository(value))
  }
  for (const value of ['../release.yml', 'workflows/release.yml', 'release.sh', 'x.yml;id']) {
    assert.throws(() => validateWorkflow(value))
  }
})

test('quotes arbitrary values for POSIX shells', () => {
  assert.equal(shellQuote("one'two"), `'one'"'"'two'`)
  assert.equal(shellQuote('$(touch nope)'), "'$(touch nope)'")
})
