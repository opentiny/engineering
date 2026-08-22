# npm publishing with Trusted Publishers

OpenTiny standardizes the identity used for npm OIDC publishing, not each project's release pipeline.

Every participating business repository uses this stable Trusted Publisher workflow filename:

```text
.github/workflows/npm-publish.yml
```

Projects continue to own the contents of that workflow, including Node.js and package-manager versions, installation, builds, tests, versioning, Changesets, Turbo/Nx/Lerna, monorepo strategy, and the final `npm publish` commands. Keeping the repository name and workflow filename stable allows the pipeline internals to evolve without reconfiguring npm trust.

## New packages

An npm Trusted Publisher cannot be configured until a package exists. To create the registry object without distributing a bootstrap credential:

1. In `opentiny/engineering`, run the **npm package bootstrap** workflow.
2. Enter the new `@opentiny/*` package and its `opentiny/*` repository. Normally, leave the workflow as `npm-publish.yml`.
3. The protected job publishes only a minimal `0.0.0` placeholder.
4. An npm maintainer signs in locally and runs the `npm trust github` command shown in the job summary.
5. All later real releases come from the business repository through OIDC.

The bootstrap job never checks out or builds business code. If the package already exists, it fails instead of publishing another version.

## Migrating existing packages

1. Add and validate `.github/workflows/npm-publish.yml` in the business repository.
2. In `opentiny/engineering`, run **npm Trusted Publisher plan** with the repository name.
3. Review the readiness warnings and Bash script in the job summary.
4. Run `npm login` locally, save or paste the script, and execute it.
5. Review the complete CREATE / SKIP / REPLACE plan and confirm once.

CI only discovers packages and generates the script. It does not call `npm trust list`, `npm trust revoke`, or `npm trust github`, and it has no npm maintainer token or TOTP secret. The local script uses npm's official login and 2FA flow, and pauses briefly between changes to reduce rate-limit pressure. Passing `--yes` to the generated script skips its one aggregate confirmation; npm authentication and 2FA still apply.

The script was designed against npm 11's current interfaces:

```text
npm trust list <package> --json
npm trust revoke <package> --id=<trust-id>
npm trust github <package> --repo <owner/repo> --file <workflow> --allow-publish --yes
```

It reads all actual trust state before applying any change. Missing configuration is created, an exact match is skipped, and mismatched configuration is revoked by its returned id before the desired GitHub configuration is created.

## Monorepositories

The planning workflow reads root packages, npm/yarn workspace arrays and object forms, and patterns from `pnpm-workspace.yaml`. It filters private, unnamed, non-`@opentiny/*`, and non-npm-registry packages, then generates one incremental plan for every publishable package. The business repository plus npm's current state remain the source of truth; there is no central package inventory.

Repository metadata in each `package.json` is compared with the requested repository. Mismatches are warnings only and are never edited automatically. A missing requested publish workflow is reported as an error in the summary and makes the planning job fail after the report is written.

## Changing release workflows

Keep the `npm-publish.yml` filename indefinitely whenever possible and change only its internal implementation. The filename is part of the OIDC trust contract.

If a rename is unavoidable, run **npm Trusted Publisher plan** with the new filename. The generated local script detects every package whose current workflow differs and plans a replace operation; already-correct packages remain untouched.

## Bootstrap token operations

`NPM_BOOTSTRAP_TOKEN` exists only in `opentiny/engineering` and is used only to create the minimal first `0.0.0` package version. It must never be copied to business repositories or used for routine releases.

Store it as a secret in a protected GitHub Environment named `npm-bootstrap`, with required reviewers and deployment restrictions. Give it only the minimum npm permission needed to publish `@opentiny/*`. npm account policy should retain 2FA and the token should be a narrowly scoped automation/granular token supported for this bootstrap use.

To rotate it:

1. Create a replacement token with the same or narrower scope and an explicit expiry.
2. Replace the `NPM_BOOTSTRAP_TOKEN` environment secret in `opentiny/engineering`.
3. Revoke the old token in npm immediately.
4. Record the rotation in the organization's credential inventory and schedule the next rotation.

Never print the token, store it in source, use it for `npm trust`, store a maintainer session in CI, or automate TOTP generation.
