#!/usr/bin/env node

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import fastGlob from 'fast-glob'
import YAML from 'yaml'
import {
  parseArguments,
  validatePackageName,
  validateRepository,
  validateWorkflow,
} from './validation.mjs'

const IGNORED_DIRECTORIES = ['**/node_modules/**', '**/.git/**']

async function readJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch (error) {
    throw new Error(`Failed to read JSON from ${file}: ${error.message}`, { cause: error })
  }
}

export async function pathExists(file, access = fs.access) {
  try {
    await access(file)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return false
    }
    throw new Error(`Unable to access ${file}: ${error.message}`, { cause: error })
  }
}

function npmWorkspacePatterns(packageJson) {
  if (Array.isArray(packageJson.workspaces)) {
    return packageJson.workspaces
  }
  if (packageJson.workspaces && Array.isArray(packageJson.workspaces.packages)) {
    return packageJson.workspaces.packages
  }
  return []
}

async function pnpmWorkspacePatterns(root) {
  const workspaceFile = path.join(root, 'pnpm-workspace.yaml')
  if (!(await pathExists(workspaceFile))) {
    return []
  }
  const document = YAML.parse(await fs.readFile(workspaceFile, 'utf8'))
  if (document == null || document.packages === undefined) {
    return []
  }
  if (!Array.isArray(document.packages)) {
    throw new Error('pnpm-workspace.yaml packages must be an array')
  }
  return document.packages
}

export function normalizeWorkspacePattern(pattern) {
  if (typeof pattern !== 'string' || pattern.trim() === '') {
    throw new Error('Workspace patterns must be non-empty strings')
  }
  const normalized = pattern.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
  const patternBody = normalized.startsWith('!') ? normalized.slice(1) : normalized
  if (!patternBody || path.posix.isAbsolute(patternBody) || path.win32.isAbsolute(patternBody) || patternBody.split('/').includes('..')) {
    throw new Error(`Unsafe workspace pattern: ${pattern}`)
  }
  return normalized.endsWith('package.json') ? normalized : `${normalized}/package.json`
}

export function repositoryFromPackageJson(repository) {
  const value = typeof repository === 'string' ? repository : repository?.url
  if (typeof value !== 'string') {
    return null
  }

  const match = value.match(/(?:github\.com[/:]|^github:)([^/\s]+)\/([^/#\s]+?)(?:\.git)?(?:#.*)?$/i)
    ?? value.match(/^([^/:\s]+)\/([^/#\s]+?)(?:\.git)?(?:#.*)?$/)
  if (!match) {
    return null
  }
  return `${match[1]}/${match[2]}`
}

function packageRepositoryWarning(packageJson, expectedRepository, location) {
  if (!packageJson.repository) {
    return null
  }
  const actual = repositoryFromPackageJson(packageJson.repository)
  if (!actual) {
    return `${location}: repository metadata could not be recognized as a GitHub repository`
  }
  if (actual.toLowerCase() !== expectedRepository.toLowerCase()) {
    return `${location}: repository metadata points to ${actual}, expected ${expectedRepository}`
  }
  return null
}

function usesNpmRegistry(registry) {
  if (!registry) {
    return true
  }
  try {
    return new URL(registry).hostname === 'registry.npmjs.org'
  } catch {
    return false
  }
}

export async function discoverPackages({ root, repository, workflow = 'npm-publish.yml' }) {
  const absoluteRoot = path.resolve(root)
  const desiredRepository = validateRepository(repository)
  const desiredWorkflow = validateWorkflow(workflow)
  const rootPackageFile = path.join(absoluteRoot, 'package.json')
  if (!(await pathExists(rootPackageFile))) {
    throw new Error(`No package.json found at repository root: ${absoluteRoot}`)
  }

  const rootPackage = await readJson(rootPackageFile)
  const patterns = [
    ...npmWorkspacePatterns(rootPackage),
    ...await pnpmWorkspacePatterns(absoluteRoot),
  ].map(normalizeWorkspacePattern)

  const workspaceFiles = patterns.length === 0
    ? []
    : await fastGlob(patterns, {
      cwd: absoluteRoot,
      onlyFiles: true,
      followSymbolicLinks: false,
      ignore: IGNORED_DIRECTORIES,
      unique: true,
    })
  const packageFiles = [...new Set(['package.json', ...workspaceFiles])].sort()
  const packages = []
  const warnings = []
  const names = new Set()

  for (const relativeFile of packageFiles) {
    const packageJson = await readJson(path.join(absoluteRoot, relativeFile))
    const location = path.posix.dirname(relativeFile) === '.' ? '.' : path.posix.dirname(relativeFile)
    if (packageJson.private === true || !packageJson.name) {
      continue
    }
    if (!usesNpmRegistry(packageJson.publishConfig?.registry)) {
      warnings.push(`${location}: ${packageJson.name} targets a non-npm registry and was ignored`)
      continue
    }
    try {
      validatePackageName(packageJson.name)
    } catch (error) {
      warnings.push(`${location}: ${packageJson.name} was ignored: ${error.message}`)
      continue
    }
    if (names.has(packageJson.name)) {
      throw new Error(`Duplicate package name discovered: ${packageJson.name}`)
    }
    names.add(packageJson.name)
    const repositoryWarning = packageRepositoryWarning(packageJson, desiredRepository, location)
    if (repositoryWarning) {
      warnings.push(repositoryWarning)
    }
    packages.push({ name: packageJson.name, path: location })
  }

  packages.sort((left, right) => left.name.localeCompare(right.name))
  const workflowPath = path.join(absoluteRoot, '.github', 'workflows', desiredWorkflow)
  const workflowExists = await pathExists(workflowPath)
  if (!workflowExists) {
    warnings.push(`Required workflow is missing: .github/workflows/${desiredWorkflow}`)
  }
  if (packages.length === 0) {
    warnings.push('No publishable @opentiny/* packages were discovered')
  }

  return {
    repository: desiredRepository,
    workflow: desiredWorkflow,
    workflowExists,
    packages,
    warnings,
    desired: {
      provider: 'github',
      repository: desiredRepository,
      workflow: desiredWorkflow,
      allowPublish: true,
    },
  }
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const result = await discoverPackages({
    root: args.root ?? '.',
    repository: args.repository,
    workflow: args.workflow,
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
