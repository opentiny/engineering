import assert from 'node:assert/strict'
import test from 'node:test'
import {
  parseArguments,
  shellQuote,
  validatePackageName,
  validateRepository,
  validateWorkflow,
} from '../scripts/npm/validation.mjs'

test('accepts the organization identity contract', () => {
  assert.equal(validatePackageName('@opentiny/tiny-robot.vue'), '@opentiny/tiny-robot.vue')
  for (const name of ['foo-', 'foo_', 'foo.', 'foo..bar', '-foo', '_foo']) {
    assert.equal(validatePackageName(`@opentiny/${name}`), `@opentiny/${name}`)
  }
  assert.equal(validateRepository('opentiny/tiny-robot'), 'opentiny/tiny-robot')
  assert.equal(validateWorkflow('npm-publish.yml'), 'npm-publish.yml')
  assert.equal(validateWorkflow(''), 'npm-publish.yml')
})

test('rejects malicious and out-of-scope inputs', () => {
  for (const value of ['react', 'foo', '@other/foo', '@opentiny/Foo', '@opentiny/foo;id', '@opentiny/.foo', '@opentiny/foo/bar', '@opentiny/foo!', '@opentiny/' + 'a'.repeat(205)]) {
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

test('parses CLI flags and rejects ambiguous argument lists', () => {
  assert.deepEqual(parseArguments(['--repository', 'opentiny/foo', '--workflow', '']), {
    repository: 'opentiny/foo',
    workflow: '',
  })
  assert.throws(() => parseArguments(['repository']), /Unexpected argument/)
  assert.throws(() => parseArguments(['--repository']), /Missing value/)
  assert.throws(() => parseArguments(['--repository', '--workflow']), /Missing value/)
  assert.throws(() => parseArguments(['--repository', 'one', '--repository', 'two']), /Duplicate argument/)
})
