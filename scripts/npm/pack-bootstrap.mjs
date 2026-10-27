#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const result = JSON.parse(await fs.readFile(process.env.BOOTSTRAP_RESULT, 'utf8'))
const artifactDirectory = process.env.BOOTSTRAP_ARTIFACT
await fs.mkdir(artifactDirectory, { recursive: true })
const packed = JSON.parse(execFileSync('npm', [
  'pack', result.directory, '--json', '--ignore-scripts', '--pack-destination', artifactDirectory,
], { encoding: 'utf8' }))
await fs.rename(path.join(artifactDirectory, packed[0].filename), path.join(artifactDirectory, 'placeholder.tgz'))

const instructions = [
  '## npm bootstrap package prepared',
  '',
  `Prepared ${result.package}@${result.version}. **This preparation step has not published to npm.**`,
  process.env.PUBLISH_REQUESTED === 'true'
    ? 'Automatic publication was requested. Check the separate protected publish job for its result before publishing locally.'
    : 'Automatic publication is disabled. No npm token is required in GitHub.',
  '',
  'Download the npm-bootstrap-package artifact from this workflow run (retained for 7 days), unzip it, and open a terminal in the extracted directory containing placeholder.tgz.',
  'To publish locally, use an npm account with permission to create packages in @opentiny and complete any npm 2FA prompts:',
  '',
  '```bash',
  'npm login --registry https://registry.npmjs.org',
  'npm publish ./placeholder.tgz --access public --registry https://registry.npmjs.org',
  '```',
  '',
  'Only after successful publication, an npm maintainer must configure Trusted Publisher locally.',
  'Use npm >= 11.15.0, enable account 2FA, and run npm login. Do not use a Bypass 2FA token for npm trust.',
  '',
  '```bash',
  `npm trust github ${result.package} \\`,
  `  --repo ${result.repository} \\`,
  `  --file ${result.workflow} \\`,
  '  --allow-publish \\',
  '  --yes',
  '```',
  '',
  'Subsequent releases are published by the owning repository using OIDC. See docs/npm-publishing.md in opentiny/engineering for publication prerequisites.',
  '',
].join('\n')
await fs.writeFile(path.join(artifactDirectory, 'README.md'), instructions)
await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, instructions)
