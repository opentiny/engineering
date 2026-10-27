#!/usr/bin/env node

import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArguments,
  validatePackageName,
  validateRepository,
  validateWorkflow,
} from './validation.mjs'

export async function packageExists(packageName, fetchImpl = fetch, token = process.env.NODE_AUTH_TOKEN) {
  validatePackageName(packageName)
  const escapedName = packageName.replace('/', '%2f')
  const response = await fetchImpl(`https://registry.npmjs.org/${escapedName}`, {
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  })
  if (response.status === 404) {
    return false
  }
  if (!response.ok) {
    throw new Error(`npm registry check failed with HTTP ${response.status}`)
  }
  return true
}

export async function createBootstrapPackage({
  packageName,
  repository,
  workflow = 'npm-publish.yml',
  temporaryRoot = os.tmpdir(),
  fetchImpl = fetch,
}) {
  const name = validatePackageName(packageName)
  const validatedRepository = validateRepository(repository)
  const validatedWorkflow = validateWorkflow(workflow)
  if (await packageExists(name, fetchImpl)) {
    throw new Error(`Package already exists on npm: ${name}`)
  }

  const directory = await fs.mkdtemp(path.join(path.resolve(temporaryRoot), 'opentiny-npm-bootstrap-'))
  try {
    await fs.writeFile(path.join(directory, 'package.json'), `${JSON.stringify({
      name,
      version: '0.0.0',
      main: 'index.js',
    }, null, 2)}\n`, { flag: 'wx' })
    await fs.writeFile(path.join(directory, 'index.js'), 'module.exports = {}\n', { flag: 'wx' })
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw new Error(`Failed to create isolated bootstrap package: ${error.message}`, { cause: error })
  }

  return {
    directory,
    package: name,
    repository: validatedRepository,
    workflow: validatedWorkflow,
    version: '0.0.0',
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const result = await createBootstrapPackage({
    packageName: args.package,
    repository: args.repository,
    workflow: args.workflow,
    temporaryRoot: args['temporary-root'],
  })
  process.stdout.write(`${JSON.stringify(result)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
