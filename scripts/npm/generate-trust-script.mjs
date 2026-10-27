#!/usr/bin/env node

import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  parseArguments,
  shellQuote,
  validatePackageName,
  validateRepository,
  validateWorkflow,
} from './validation.mjs'

export function parseTrustListOutput(output) {
  const source = output.trim()
  if (!source) {
    return []
  }
  try {
    const parsed = JSON.parse(source)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch (primaryError) {
    const values = []
    let start = -1
    let depth = 0
    let quoted = false
    let escaped = false

    const invalidJson = (detail, cause = primaryError) => new Error(
      `npm trust list returned invalid JSON: ${detail}. Initial JSON.parse error: ${primaryError.message}`,
      { cause },
    )

    for (let index = 0; index < source.length; index += 1) {
      const character = source[index]
      if (depth === 0) {
        if (/\s/.test(character)) {
          continue
        }
        if (character !== '{' && character !== '[') {
          throw invalidJson(`unexpected character at offset ${index}`)
        }
        start = index
        depth = 1
        continue
      }
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') {
        quoted = true
      } else if (character === '{' || character === '[') {
        depth += 1
      } else if (character === '}' || character === ']') {
        depth -= 1
        if (depth === 0) {
          try {
            values.push(JSON.parse(source.slice(start, index + 1)))
          } catch (documentError) {
            throw invalidJson(`invalid document beginning at offset ${start}: ${documentError.message}`, documentError)
          }
          start = -1
        }
      }
    }
    if (quoted) {
      throw invalidJson('unterminated string')
    }
    if (depth !== 0 || start !== -1) {
      throw invalidJson('unterminated document')
    }
    if (values.length === 0) {
      throw invalidJson('no JSON documents found')
    }
    return values.flatMap((value) => Array.isArray(value) ? value : [value])
  }
}

export function normalizeTrust(trust) {
  return {
    id: trust.id ?? null,
    provider: trust.type ?? trust.provider ?? null,
    repository: trust.repository ?? trust.claims?.repository ?? null,
    workflow: trust.file ?? trust.workflow ?? trust.claims?.workflow_ref?.file ?? null,
    allowPublish: trust.allowPublish === true || trust.permissions?.includes('createPackage') === true,
  }
}

export function createTrustPlan(currentTrusts, desired) {
  const current = currentTrusts.map(normalizeTrust)
  if (current.length === 0) {
    return { action: 'create', current: [], revokeIds: [] }
  }
  const matches = current.length === 1
    && current[0].provider === desired.provider
    && current[0].repository === desired.repository
    && current[0].workflow === desired.workflow
    && current[0].allowPublish === desired.allowPublish
  if (matches) {
    return { action: 'skip', current, revokeIds: [] }
  }
  const revokeIds = current.map((trust) => trust.id)
  if (revokeIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error('A mismatched trust configuration has no revocable id')
  }
  return { action: 'replace', current, revokeIds }
}

function embeddedAnalyzer() {
  return String.raw`import fs from 'node:fs'

${parseTrustListOutput.toString()}

function normalize(value) {
  return {
    id: value.id ?? null,
    provider: value.type ?? value.provider ?? null,
    repository: value.repository ?? value.claims?.repository ?? null,
    workflow: value.file ?? value.workflow ?? value.claims?.workflow_ref?.file ?? null,
    allowPublish: value.allowPublish === true || value.permissions?.includes('createPackage') === true,
  }
}

const [mode, ...args] = process.argv.slice(2)
if (mode === 'analyze') {
  const [input, output, repository, workflow] = args
  const current = parseTrustListOutput(fs.readFileSync(input, 'utf8')).map(normalize)
  const exact = current.length === 1 && current[0].provider === 'github' &&
    current[0].repository === repository && current[0].workflow === workflow && current[0].allowPublish
  const action = current.length === 0 ? 'create' : exact ? 'skip' : 'replace'
  const revokeIds = action === 'replace' ? current.map((item) => item.id) : []
  if (revokeIds.some((id) => typeof id !== 'string' || !id)) throw new Error('Mismatched trust has no revocable id')
  fs.writeFileSync(output, JSON.stringify({ action, current, revokeIds }))
} else if (mode === 'field') {
  const [input, field] = args
  const plan = JSON.parse(fs.readFileSync(input, 'utf8'))
  if (field === 'revokeIds') process.stdout.write(plan.revokeIds.length ? plan.revokeIds.join('\n') + '\n' : '')
  else process.stdout.write(String(plan[field] ?? ''))
} else if (mode === 'report') {
  const [repository, workflow, packagesFile, ...planFiles] = args
  const packages = JSON.parse(fs.readFileSync(packagesFile, 'utf8'))
  const plans = planFiles.map((file) => JSON.parse(fs.readFileSync(file, 'utf8')))
  console.log('Repository: ' + repository + '\nWorkflow: ' + workflow + '\n\nPackages: ' + packages.length + '\n')
  const counts = { skip: 0, create: 0, replace: 0 }
  plans.forEach((plan, index) => {
    counts[plan.action] += 1
    const name = packages[index]
    if (plan.action === 'skip') console.log('✓ ' + name + '\n  already configured\n')
    if (plan.action === 'create') console.log('+ ' + name + '\n  trusted publisher missing\n')
    if (plan.action === 'replace') {
      console.log('~ ' + name + '\n  current:')
      for (const trust of plan.current) {
        console.log('    ' + (trust.provider ?? '(unknown)') + ' ' + (trust.repository ?? '(unknown)') + ' ' + (trust.workflow ?? '(unknown)') + ' allowPublish=' + trust.allowPublish)
      }
      console.log('  desired:\n    github ' + repository + ' ' + workflow + ' allowPublish=true\n')
    }
  })
  console.log('Plan:\n  unchanged: ' + counts.skip + '\n  create:    ' + counts.create + '\n  replace:   ' + counts.replace)
} else {
  throw new Error('Unknown analyzer mode')
}
`
}

export function generateTrustScript(discovery) {
  const repository = validateRepository(discovery.repository)
  const workflow = validateWorkflow(discovery.workflow)
  const packageNames = discovery.packages.map((entry) => validatePackageName(entry.name))
  if (packageNames.length === 0) {
    throw new Error('Cannot generate a trust script without packages')
  }
  if (new Set(packageNames).size !== packageNames.length) {
    throw new Error('Cannot generate a trust script with duplicate packages')
  }
  const packageLines = packageNames.map((name) => `  ${shellQuote(name)}`).join('\n')
  const packagesJson = JSON.stringify(packageNames)

  return `#!/usr/bin/env bash

set -euo pipefail

REPOSITORY=${shellQuote(repository)}
WORKFLOW=${shellQuote(workflow)}
PACKAGES=(
${packageLines}
)

ASSUME_YES=false
if [[ \${1:-} == "--yes" ]]; then
  ASSUME_YES=true
elif [[ \${1:-} != "" ]]; then
  echo "Usage: \$0 [--yes]" >&2
  exit 2
fi

command -v node >/dev/null || { echo "Node.js is required." >&2; exit 1; }
command -v npm >/dev/null || { echo "npm is required." >&2; exit 1; }
npm trust --help >/dev/null || { echo "This npm version does not support npm trust." >&2; exit 1; }

TRUST_PLAN_DIR="\$(mktemp -d)"
CURRENT_PACKAGE=""
MUTATIONS_STARTED=false
cleanup() {
  status=\$?
  trap - EXIT
  rm -rf "\$TRUST_PLAN_DIR"
  if [[ \$status -ne 0 ]]; then
    echo "Trusted Publisher update failed for \${CURRENT_PACKAGE:-an unknown package}." >&2
    if [[ "\$MUTATIONS_STARTED" == true ]]; then
      echo "Some npm changes may already have been applied; npm trust updates are not transactional." >&2
      echo "Fix the reported error, generate a fresh plan, and rerun it to converge on the desired state." >&2
    else
      echo "No npm trust mutations were started." >&2
    fi
  fi
  exit "\$status"
}
trap cleanup EXIT
printf '%s' ${shellQuote(packagesJson)} > "\$TRUST_PLAN_DIR/packages.json"

cat > "\$TRUST_PLAN_DIR/analyze.mjs" <<'OPENTINY_TRUST_ANALYZER'
${embeddedAnalyzer()}OPENTINY_TRUST_ANALYZER

PLAN_FILES=()
for index in "\${!PACKAGES[@]}"; do
  package="\${PACKAGES[\$index]}"
  CURRENT_PACKAGE="\$package"
  raw_file="\$TRUST_PLAN_DIR/trust-\$index.json"
  plan_file="\$TRUST_PLAN_DIR/plan-\$index.json"
  echo "Reading trusted publishers for \$package..." >&2
  npm trust list "\$package" --json > "\$raw_file"
  node "\$TRUST_PLAN_DIR/analyze.mjs" analyze "\$raw_file" "\$plan_file" "\$REPOSITORY" "\$WORKFLOW"
  PLAN_FILES+=("\$plan_file")
done

echo
node "\$TRUST_PLAN_DIR/analyze.mjs" report "\$REPOSITORY" "\$WORKFLOW" "\$TRUST_PLAN_DIR/packages.json" "\${PLAN_FILES[@]}"
echo

if [[ "\$ASSUME_YES" != true ]]; then
  read -r -p "Apply these changes? [y/N] " answer
  case "\$answer" in
    y|Y|yes|YES) ;;
    *) echo "No changes applied."; exit 0 ;;
  esac
fi

for index in "\${!PACKAGES[@]}"; do
  package="\${PACKAGES[\$index]}"
  CURRENT_PACKAGE="\$package"
  plan_file="\${PLAN_FILES[\$index]}"
  action="\$(node "\$TRUST_PLAN_DIR/analyze.mjs" field "\$plan_file" action)"
  case "\$action" in
    skip)
      echo "SKIP \$package"
      continue
      ;;
    create)
      echo "CREATE \$package"
      ;;
    replace)
      echo "REPLACE \$package"
      revoke_ids_file="\$TRUST_PLAN_DIR/revoke-ids-\$index.txt"
      if ! node "\$TRUST_PLAN_DIR/analyze.mjs" field "\$plan_file" revokeIds > "\$revoke_ids_file"; then
        echo "Failed to read revoke ids for \$package; refusing to create a replacement trust." >&2
        exit 1
      fi
      if [[ ! -s "\$revoke_ids_file" ]]; then
        echo "No revoke ids found for replacement of \$package; refusing to continue." >&2
        exit 1
      fi
      ;;
    *)
      echo "Unknown plan action for \$package: \$action" >&2
      exit 1
      ;;
  esac
  if [[ "\$action" == "replace" ]]; then
    MUTATIONS_STARTED=true
    while IFS= read -r trust_id; do
      [[ -z "\$trust_id" ]] && continue
      npm trust revoke "\$package" --id="\$trust_id"
      sleep 2
    done < "\$revoke_ids_file"
  fi
  MUTATIONS_STARTED=true
  npm trust github "\$package" --repo "\$REPOSITORY" --file "\$WORKFLOW" --allow-publish --yes
  sleep 2
done

echo "Trusted Publisher updates complete."
`
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  if (!args.input) {
    throw new Error('--input is required')
  }
  const discovery = JSON.parse(await fs.readFile(args.input, 'utf8'))
  process.stdout.write(generateTrustScript(discovery))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exitCode = 1
  })
}
