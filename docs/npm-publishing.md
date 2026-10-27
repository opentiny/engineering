# 使用 Trusted Publishers 发布 npm 包

OpenTiny 统一约定 npm OIDC 发布所使用的身份。各项目继续维护自己的发布流水线。

所有接入的业务仓库统一使用以下 Trusted Publisher 工作流文件名，并保持稳定：

```text
.github/workflows/npm-publish.yml
```

业务仓库的 OIDC 发布工作流须满足以下前提，详见 [npm Trusted Publishing 官方文档](https://docs.npmjs.com/trusted-publishers/)：

- 使用 Node.js `>= 22.14.0` 和 npm `>= 11.5.1`，需分别检查实际版本，不能仅依赖 Node.js 捆绑的 npm 版本。
- 使用 GitHub 托管的 runner，并为发布任务授予 `id-token: write` 权限；若调用可复用工作流，调用方和被调用方都需授予该权限。
- 每个待发布包的 `package.json` 中须配置 `repository.url`，并与实际执行发布的 GitHub 仓库一致。缺失或不匹配时，须先在业务仓库修正，再执行正式发布。

各项目自行维护该工作流的内容，包括 Node.js 和包管理器版本、依赖安装、构建、测试、版本管理、Changesets、Turbo/Nx/Lerna、Monorepo 策略，以及最终的 `npm publish` 命令。保持仓库名和工作流文件名稳定后，流水线内部实现可以持续演进，无需重新配置 npm 信任关系。

## 新包接入

npm 包创建后才能配置 Trusted Publisher。按以下步骤创建包，即可避免向业务仓库分发初始化发布凭据：

1. 在 `opentiny/engineering` 中运行 **npm package bootstrap** 工作流。
2. 输入新的 `@opentiny/*` 包名及其所属的 `opentiny/*` 仓库。工作流文件名通常保持默认值 `npm-publish.yml`。
3. `publish` 复选框默认不勾选。默认流程无需向 GitHub 保存 npm token，也不进入 `npm-bootstrap` 受保护环境，只生成最小化的 `0.0.0` 占位包。
4. 在运行页面下载 `npm-bootstrap-package` artifact（保留 7 天），解压后进入包含 `placeholder.tgz` 的目录。按任务摘要或随包 `README.md` 的步骤，在本地执行以下命令，完成 npm 登录和 2FA：

   ```bash
   npm login --registry https://registry.npmjs.org
   npm publish ./placeholder.tgz --access public --registry https://registry.npmjs.org
   ```

   本地账号须有创建 `@opentiny` 包的权限。发布成功后，由 npm 维护者执行摘要或 README 中的 `npm trust github` 命令（本地 npm 和 2FA 要求见“已有包迁移”）。

   如需由 CI 直接发布，显式勾选 `publish`，并按“初始化发布令牌管理”配置环境密钥。准备任务仍先上传同一份压缩包，再由单独的受保护任务发布；准备成功不代表发布成功，须核对发布任务结果。缺少 token 时发布任务会明确报错，已生成的 artifact 仍可下载。
5. 后续正式版本均由业务仓库通过 OIDC 发布。

初始化任务不会检出或构建业务代码。如果包已存在，任务会失败，不会发布其他版本。

## 已有包迁移

1. 在业务仓库中添加并验证 `.github/workflows/npm-publish.yml`。
2. 在 `opentiny/engineering` 中运行 **npm Trusted Publisher plan**，输入业务仓库名。
3. 查看任务摘要中的就绪检查警告和 Bash 脚本。
4. 在本地执行 `npm login`，保存或粘贴脚本并运行。
5. 检查完整的 CREATE / SKIP / REPLACE 计划，统一确认一次。

CI 仅发现包并生成脚本，不执行 `npm trust list`、`npm trust revoke` 或 `npm trust github`，也不持有 npm 维护者令牌或 TOTP 密钥。本地脚本使用 npm 官方登录和双因素认证（2FA）流程，并在变更之间短暂等待，以降低触发限流的概率。为生成的脚本传入 `--yes` 可跳过统一确认；npm 身份认证和 2FA 仍然生效。

维护者运行本地脚本前，须使用支持 `npm trust` 的 npm `>= 11.15.0`，对待配置包拥有写权限，在账户级启用 2FA，并完成 `npm login`。不能使用启用 Bypass 2FA 的细粒度令牌执行 trust 操作。这与业务 OIDC 发布所需的最低 npm 版本不同，详见 [npm trust 官方文档](https://docs.npmjs.com/cli/v11/commands/npm-trust/)。脚本使用以下接口：

```text
npm trust list <package> --json
npm trust revoke <package> --id=<trust-id>
npm trust github <package> --repo <owner/repo> --file <workflow> --allow-publish --yes
```

脚本会在执行任何变更前读取所有包的实际信任配置。缺少配置时创建，完全匹配时跳过，不匹配时先按返回的 ID 撤销旧配置，再创建目标 GitHub 配置。

当前目标配置不限定 GitHub Environment。已有配置如果限定了环境，也会被列为替换操作；计划会展示当前与目标的环境限制，请在确认前检查该变更是否符合业务仓库的发布要求。

npm trust 变更不具备事务性。如果执行过程中已有一个或多个变更生效后发生失败，脚本会停止，提示可能存在部分已生效的变更，并要求维护者修复错误后重新生成计划。新计划会读取 npm 最新的实际状态，并在此基础上完成剩余配置。

## Monorepo 支持

规划工作流会读取根包、npm/yarn 的数组或对象形式 workspace 配置，以及 `pnpm-workspace.yaml` 中的匹配规则。它会过滤私有包、未命名包、非 `@opentiny/*` 包，以及发布目标不是 npm 注册表的包，并为每个可发布包生成增量计划。包信息以业务仓库为准，信任配置以 npm 当前状态为准，不维护中央包清单。

每个 `package.json` 中的仓库元数据都会与输入的仓库名比较。不一致时仅发出警告，不会自动修改；维护者必须在业务仓库中修正缺失或不匹配的 `repository.url`，确认满足上述发布前提后才能正式发布。警告不阻止生成信任配置计划，也不代表该包已经可以发布。

摘要中的工作流文件状态只检查指定文件是否存在，发布就绪状态始终提示需要人工检查。任务成功或信任配置已应用，都不能证明业务工作流、包元数据、运行时和 OIDC 权限已经满足发布条件。如果指定的发布工作流不存在，任务会在写入报告后失败。

如果未发现任何可发布包，也会在摘要中报告，并将规划任务标记为失败。

## 调整发布工作流

应尽量长期保留 `npm-publish.yml` 文件名，仅调整内部实现。该文件名是 OIDC 信任约定的一部分。

如果必须重命名，使用新的文件名运行 **npm Trusted Publisher plan**。生成的本地脚本会检测当前工作流与目标不一致的包，并规划替换操作；配置已正确的包会被跳过。

## 初始化发布令牌管理

默认不发布的流程不需要配置此令牌或 GitHub Environment。只有勾选 `publish` 让 CI 发布时，才需要以下配置。

`NPM_BOOTSTRAP_TOKEN` 仅保存在 `opentiny/engineering` 中，仅用于创建最小化的首个 `0.0.0` 包版本。不得将其复制到业务仓库或用于日常发布。

将令牌作为密钥存储在名为 `npm-bootstrap` 的受保护 GitHub Environment 中，并配置必需的审批人和部署限制。npm 目前仅支持细粒度访问令牌（granular access token），不再支持旧式 automation token，详见 [npm 访问令牌说明](https://docs.npmjs.com/about-access-tokens/)。

初始化任务使用非交互式 `npm publish`，应按 [创建细粒度令牌指南](https://docs.npmjs.com/creating-and-viewing-access-tokens/) 配置：

- 在 **Packages and scopes** 中仅选择 `@opentiny` scope，并授予 **Read and write (publish and stage)**，确保允许直接发布首个新包；**stage only** 不适用于当前任务。
- 启用 **Bypass two-factor authentication**，使该受保护 CI 任务能非交互式发布；账户本身仍保留 2FA，维护者本地 `npm trust` 的认证和 2FA 要求仍然有效。
- 明确设置有效期。无需额外授予组织管理权限；仅在 **Organizations** 中授予读写也不能获得包发布权限。

令牌轮换步骤：

1. 创建权限范围相同或更小的新令牌，并明确设置有效期。
2. 替换 `opentiny/engineering` 中的 `NPM_BOOTSTRAP_TOKEN` 环境密钥。
3. 立即在 npm 中撤销旧令牌。
4. 在组织凭据清单中记录本次轮换，并安排下一次轮换。

禁止打印令牌、将令牌写入源码、将其用于 `npm trust`、在 CI 中保存维护者登录会话，或自动生成 TOTP。
