# OpenTiny Engineering

[English](README.md)

为 OpenTiny 项目提供共享工程基础设施，涵盖自动化、工作流、技能、评审实践和工具。

当前能力：

- 为尚未在 npm 注册表中创建的包发布初始占位版本
- 发现 npm 包并生成 Trusted Publisher 增量配置计划

未来可能扩展更多共享 Actions 和可复用工作流、Agent Skills、开发与安全评审实践，以及跨仓库工具。相关目录会随实际功能落地而创建，仓库不预先放置空的框架目录。

组织统一的 OIDC 身份约定、接入流程和令牌管理方式，请参阅 [npm 发布指南](docs/npm-publishing.md)。

## 本地开发

需要 Node.js 22 或更新版本。

```bash
npm install
npm test
npm run lint
```
