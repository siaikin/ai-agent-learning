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
```

配置保存在 `harness/.env`（已被 git 忽略）。也可以复制 `.env.example` 手动填写：

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_BASE_URL` | API 地址（不要带 `/chat/completions`；很多服务需要以 `/v1` 结尾） | `https://api.deepseek.com` |
| `LLM_API_KEY` | API Key | （必填） |
| `LLM_MODEL` | 模型名 | `deepseek-chat` |

> ⚠️ s01 会直接执行模型生成的 shell 命令，请在临时目录中试用。权限系统在 s03 实现。

## 进度

| 章节 | 文件 | 状态 |
| --- | --- | --- |
| s01 Agent Loop | [src/s01-agent-loop.ts](src/s01-agent-loop.ts) | ✅ |
| s02 Tool Use | | ⬜ |
| s03 Permission | | ⬜ |
