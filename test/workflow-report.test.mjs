import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import YAML from 'yaml'

test('workflow reports require manual publication checks and preserve readiness gates', async (t) => {
  const workflow = YAML.parse(await fs.readFile(new URL('../.github/workflows/npm-trust-plan.yml', import.meta.url), 'utf8'))
  const steps = workflow.jobs.plan.steps
  const report = steps.find((step) => step.name === 'Write readiness report and script').run
  const enforce = steps.find((step) => step.name === 'Enforce readiness').run
  for (const scenario of [
    { name: 'metadata requires manual verification', workflowExists: true, warnings: [], hasPackages: true, status: 0 },
    { name: 'mismatched metadata remains a warning', workflowExists: true, warnings: ['repository metadata points to opentiny/other, expected opentiny/foo'], hasPackages: true, status: 0 },
    { name: 'missing workflow', workflowExists: false, warnings: [], hasPackages: true, status: 1 },
    { name: 'zero packages', workflowExists: true, warnings: [], hasPackages: false, status: 1 },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engineering-workflow-report-'))
    t.after(() => fs.rm(root, { recursive: true, force: true }))
    const summaryFile = path.join(root, 'summary.md')
    await fs.writeFile(path.join(root, 'npm-discovery.json'), JSON.stringify({
      repository: 'opentiny/foo', workflow: 'npm-publish.yml',
      workflowExists: scenario.workflowExists, warnings: scenario.warnings,
      packages: scenario.hasPackages ? [{ name: '@opentiny/foo', path: '.' }] : [],
    }))
    await fs.writeFile(path.join(root, 'npm-trust-apply.sh'), '# local maintainer script\n')
    const options = { encoding: 'utf8', env: { ...process.env, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summaryFile } }
    const reported = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', report], options)
    assert.equal(reported.status, 0, `${scenario.name}: ${reported.stderr}`)
    const summary = await fs.readFile(summaryFile, 'utf8')
    assert.match(summary, /Publication readiness: \*\*MANUAL CHECK REQUIRED\*\*/)
    assert.match(summary, /correct missing or mismatched package repository\.url/)
    assert.match(summary, /id-token: write/)
    assert.match(summary, scenario.workflowExists ? /Workflow file: \*\*FOUND\*\*/ : /Workflow file: \*\*MISSING\*\*/)
    assert.doesNotMatch(summary, /\bREADY\b/)
    for (const warning of scenario.warnings) assert.ok(summary.includes(warning))
    const enforced = spawnSync('bash', ['-e', '-o', 'pipefail', '-c', enforce], options)
    assert.equal(enforced.status, scenario.status, `${scenario.name}: ${enforced.stderr}`)
  }
})
