import path from 'node:path'

const PACKAGE_PATTERN = /^@opentiny\/[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/
const REPOSITORY_PATTERN = /^opentiny\/[A-Za-z0-9._-]+$/
const WORKFLOW_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/

export function validatePackageName(value) {
  if (typeof value !== 'string' || !PACKAGE_PATTERN.test(value)) {
    throw new Error('Package must be a lowercase, URL-safe name in the @opentiny scope')
  }
  if (value.length > 214 || value.includes('..')) {
    throw new Error('Package name is not a valid npm package name')
  }
  return value
}

export function validateRepository(value) {
  if (typeof value !== 'string' || !REPOSITORY_PATTERN.test(value)) {
    throw new Error('Repository must use the format opentiny/<repo>')
  }
  if (value.includes('..')) {
    throw new Error('Repository name must not contain consecutive dots')
  }
  return value
}

export function validateWorkflow(value = 'npm-publish.yml') {
  const workflow = value || 'npm-publish.yml'
  if (!WORKFLOW_PATTERN.test(workflow) || path.basename(workflow) !== workflow) {
    throw new Error('Workflow must be a .yml or .yaml filename without a path')
  }
  return workflow
}

export function parseArguments(argv) {
  const args = {}
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`)
    }
    const key = argument.slice(2)
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${key}`)
    }
    if (Object.hasOwn(args, key)) {
      throw new Error(`Duplicate argument: --${key}`)
    }
    args[key] = value
    index += 1
  }
  return args
}

export function shellQuote(value) {
  if (typeof value !== 'string') {
    throw new TypeError('shellQuote expects a string')
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`
}
