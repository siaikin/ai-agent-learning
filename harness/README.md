# my-harness

用 TypeScript 从零实现的个人 AI agent harness，按 [Learn Claude Code](https://learn.shareai.run/zh/s01/) 的章节逐步搭建。
模型接口使用 **Claude（Anthropic Messages API）格式**，和教程的 Python 代码一致。Anthropic 官方、Anthropic 兼容的服务、自己的中转都可以接入。

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
npm run s06     # 运行 s06：task 工具，把子任务交给上下文隔离的子 agent
npm run s07     # 运行 s07：技能按需加载（skills/ 内置 + 项目的 .harness/skills/）
npm test        # 运行单元测试
```

配置保存在 `harness/.env`（已被 git 忽略）。也可以复制 `.env.example` 手动填写：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_BASE_URL` | API 地址。留空表示 Anthropic 官方；填兼容服务时不要带 `/v1/messages` | （空） |
| `LLM_API_KEY` | API Key | （必填） |
| `LLM_MODEL` | 模型名 | `claude-opus-5-5` |
| `LLM_MAX_TOKENS` | 单次回复的 token 上限，兼容服务的上限可能更低 | `16000` |

> ⚠️ s01 / s02 会直接执行模型生成的 shell 命令，请在临时目录中试用。s03 起有权限检查，但正则匹配命令不是可靠的安全边界，仍建议在临时目录或容器里试。

## 可观测性（Langfuse，可选）

从 s05 起，配置 Langfuse 后会自动上报每一轮对话：

```
Session（一次运行）
└─ Trace "agent-turn"（你的一次输入）
   ├─ Generation "anthropic.messages.create"：每次调用模型（完整输入输出、token、耗时）
   ├─ Tool "tool:xxx"：每次工具调用（参数、输出；被拦截标 WARNING，出错标 ERROR）
   └─ Event "stop-hook"：Stop 钩子要求继续时
```

1. 在 [Langfuse Cloud](https://cloud.langfuse.com) 注册并创建项目，在 Settings → API Keys 创建 key
2. 运行 `npm run setup -- langfuse`，选择数据区域、填写 key，表单会自动测试连接
3. 正常运行 `npm run s05`，退出时会把剩余数据发送完

没配置时完全不联网，不影响使用。实现见 [src/lib/telemetry.ts](src/lib/telemetry.ts)。

## 目录结构

- `src/sNN-*.ts`：每章一个可独立运行的文件，保留为那一章的快照
- `skills/`：内置技能，每个技能一个目录，里面是 `SKILL.md`（可带附件）。项目自己的技能放在 `<工作目录>/.harness/skills/`，同名会覆盖内置的
- `src/lib/`：章节之间共用的模块，后面的章节在这里逐步累积
  - `agent.ts` 循环 · `tools.ts` 工具集 · `hooks.ts` 钩子 · `plugins.ts` 共用插件 · `permission.ts` 权限 · `todo.ts` 清单 · `subagent.ts` 子 agent · `skills.ts` 技能 · `ask.ts` 问用户 · `telemetry.ts` 可观测性

## 进度

| 章节 | 文件 | 状态 |
| --- | --- | --- |
| s01 Agent Loop | [src/s01-agent-loop.ts](src/s01-agent-loop.ts) | ✅ |
| s02 Tool Use | [src/s02-tool-use.ts](src/s02-tool-use.ts) | ✅ |
| s03 Permission | [src/s03-permission.ts](src/s03-permission.ts)、[src/lib/permission.ts](src/lib/permission.ts) | ✅ |
| s04 Hooks | [src/s04-hooks.ts](src/s04-hooks.ts)、[src/lib/hooks.ts](src/lib/hooks.ts) | ✅ |
| s05 TodoWrite | [src/s05-todo.ts](src/s05-todo.ts)、[src/lib/todo.ts](src/lib/todo.ts) | ✅ |
| s06 Subagent | [src/s06-subagent.ts](src/s06-subagent.ts)、[src/lib/subagent.ts](src/lib/subagent.ts) | ✅ |
| s07 Skills | [src/s07-skills.ts](src/s07-skills.ts)、[src/lib/skills.ts](src/lib/skills.ts)、[skills/](skills/) | ✅ |
| s08 Context Compact | | ⬜ |
