# my-harness

用 TypeScript 从零实现的个人 AI agent harness，按 [Learn Claude Code](https://learn.shareai.run/zh/s01/) 的章节逐步搭建。
模型接口使用 OpenAI 兼容格式，DeepSeek 官方、自建 API / 中转、vLLM 都可以接入。

## 快速开始

需要 Node.js 22+。

```bash
cd harness
npm install
npm run setup   # 配置表单：API 地址、API Key、模型名，会自动测试连接并保存到 .env
npm run s01     # 运行 s01：最小 agent 循环
npm run s02     # 运行 s02：5 个工具 + 分发表
npm run s03     # 运行 s03：执行前权限检查（拒绝 / 询问 / 放行）
npm run s04     # 运行 s04：hook 插件（上下文、审计日志、权限、截断、测试守卫）
npm run s05     # 运行 s05：todo 清单 + 提醒 / 收工检查插件
npm test        # 运行单元测试
```

配置保存在 `harness/.env`（已被 git 忽略）。也可以复制 `.env.example` 手动填写：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_BASE_URL` | API 地址（不要带 `/chat/completions`；很多服务需要以 `/v1` 结尾） | `https://api.deepseek.com` |
| `LLM_API_KEY` | API Key | （必填） |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |

> ⚠️ s01 / s02 会直接执行模型生成的 shell 命令，请在临时目录中试用。s03 起有权限检查，但正则匹配命令不是可靠的安全边界，仍建议在临时目录或容器里试。

## 目录结构

- `src/sNN-*.ts`：每章一个可独立运行的文件，保留为那一章的快照
- `src/lib/`：章节之间共用的模块，后面的章节在这里逐步累积
  - `agent.ts` 循环 · `tools.ts` 工具集 · `hooks.ts` 钩子 · `plugins.ts` 共用插件 · `permission.ts` 权限 · `todo.ts` 清单 · `ask.ts` 问用户

## 进度

| 章节 | 文件 | 状态 |
| --- | --- | --- |
| s01 Agent Loop | [src/s01-agent-loop.ts](src/s01-agent-loop.ts) | ✅ |
| s02 Tool Use | [src/s02-tool-use.ts](src/s02-tool-use.ts) | ✅ |
| s03 Permission | [src/s03-permission.ts](src/s03-permission.ts)、[src/lib/permission.ts](src/lib/permission.ts) | ✅ |
| s04 Hooks | [src/s04-hooks.ts](src/s04-hooks.ts)、[src/lib/hooks.ts](src/lib/hooks.ts) | ✅ |
| s05 TodoWrite | [src/s05-todo.ts](src/s05-todo.ts)、[src/lib/todo.ts](src/lib/todo.ts) | ✅ |
| s06 Subagent | | ⬜ |
