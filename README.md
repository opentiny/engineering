# OpenTiny Engineering

[简体中文](README.zh-CN.md)

Shared engineering infrastructure for OpenTiny projects: automation, workflows, skills, review practices, and tooling.

Current capabilities:

- npm package bootstrap for packages that do not yet exist in the registry
- npm Trusted Publisher discovery and incremental planning

Future capabilities may include additional shared Actions and reusable workflows, Agent Skills, development and security review practices, and cross-repository tooling. New directories are added when those capabilities have real implementations; this repository intentionally avoids empty framework scaffolding.

See [npm publishing](docs/npm-publishing.md) for the organization-wide OIDC identity contract, onboarding flows, and token operations.

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm test
npm run lint
```
