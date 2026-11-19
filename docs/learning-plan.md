# 学习计划：从前端到 Agent / Harness 开发

> 目标：做一个**自用的 AI agent / harness**，并以它作为核心作品，找到一份 Agent 开发工作。
> 背景：5 年前端经验，以 Vue / TypeScript 为主，熟悉构建工具（unplugin、Rollup），写过一些 Rust / Python / Go。

## 1. 先想清楚：harness 是什么

**Agent = 模型 + harness。** 模型负责决策（要不要调用工具、调用哪个），harness 负责其余所有事：

- 运行循环：调用模型 → 执行工具 → 把结果喂回去
- 工具与权限：模型能做什么、不能做什么，哪些操作要先经过人确认
- 上下文管理：压缩、记忆、跨会话交接
- 任务规划与拆解：todo、子 agent、多 agent 协作
- 验证与评估：怎么判断它真的做对了

Claude Code、Codex CLI、Cursor Agent 本质上都是 harness。你要做的就是自己的一个版本。

## 2. 你的优势，以及要补的短板

| 优势 | 在 Agent 开发里的用处 |
| --- | --- |
| TypeScript 很熟 | Claude Code 本身用 TypeScript 编写；Claude Agent SDK、MCP SDK、Vercel AI SDK 都有一流的 TS 支持 |
| 写过构建工具和插件（unplugin / Rollup） | harness 本质上是一个插件化的运行时：工具注册、hook、生命周期，和插件系统的设计思路一样 |
| UI 与交互能力 | 大多数 agent 开发者不擅长做界面。agent 的 Web UI、可视化 trace 查看器、TUI 都是你能拉开差距的地方 |
| 有测试和工程化经验 | 评估（evals）和端到端验证正是 harness 最难的部分 |

| 短板 | 补法 |
| --- | --- |
| Python | 主流教程和国内很多岗位要求都用 Python。至少要做到能流畅阅读，能写小脚本 |
| LLM 基础概念 | token、上下文窗口、tool use 协议、流式输出、prompt caching，边做边学 |
| 模型部署 / 开源模型 | vLLM 与 ModelScope 放在后期，了解即可，不必深入 |
| 评估方法论 | 第 4 阶段专门练 |

**关键决定：用 TypeScript 写你自己的 harness，同时读懂教程里的 Python 代码。** 把 Python 教程改写成 TS，本身就是最好的学习方式，产出的仓库也就是你的作品。

## 3. 你的 6 份资料怎么用

| # | 资料 | 内容 | 定位 | 什么时候用 |
| --- | --- | --- | --- | --- |
| 1 | [Learn Claude Code](https://learn.shareai.run/zh/s01/)（[shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)） | 20 章，Python，从约 100 行的 agent 循环一路搭到多 agent 平台；每章附 Claude Code 源码对照（如 `query.ts`） | **主线**，整个计划的骨架 | 第 1–3 阶段 |
| 4 | [Effective harnesses for long-running agents](https://www.anthropic.com/research/effective-harnesses-for-long-running-agents)（Anthropic，2025-11） | initializer agent + coding agent；`feature_list.json`（只允许改 `passes` 字段）、`claude-progress.txt`、`init.sh`；一次只做一个功能；用浏览器做端到端测试 | 长时间运行任务的**交接机制** | 第 3 阶段 |
| 6 | [Harness design for long-running apps](https://www.anthropic.com/research/harness-design-long-running-apps)（Anthropic，2026-03） | planner / generator / evaluator 三个角色；sprint 合同；评分标准；**生成和评估分开**（agent 自评偏宽松）；随模型升级逐个移除 harness 组件，验证哪些仍然必要 | **多 agent 与评估**设计 | 第 3–4 阶段 |
| 5 | [Harness engineering](https://openai.com/zh-Hans-CN/index/harness-engineering/)（OpenAI） | 用 coding agent 开发真实产品的工程实践：AGENTS.md、把文档当作唯一可信来源、用 lint 和测试约束 agent | 怎么让**仓库对 agent 友好** | 第 3 阶段（⚠️ 这篇本环境没抓到，见文末） |
| 2 | [vLLM 文档](https://docs.vllm.ai/) | 开源模型的高性能推理引擎，提供兼容 OpenAI 的服务端，支持 tool calling、reasoning、structured outputs | **自托管开源模型**；需要 GPU。做 harness 本身用不到 | 第 5 阶段（可选） |
| 3 | [ModelScope ms-cookbook](https://www.modelscope.cn/studios/ms-cookbook-team/ms-cookbook) | 开源模型应用实战指南：模型选型、运行、微调评测、AIGC 与 Agent 应用 | 了解**国内开源模型生态**（Qwen 等），对国内求职有帮助 | 第 5 阶段（可选） |

### 建议补充的资料

- Anthropic《Building Effective Agents》：workflow 和 agent 的区别，几种常见模式，最适合入门
- [Model Context Protocol](https://modelcontextprotocol.io) 规范与 TypeScript SDK（对应教程 s19）
- Anthropic 官方 API 文档里的 Tool use、Prompt caching、Streaming 章节
- `anthropics/claude-quickstarts` 仓库里的 `autonomous-coding` 示例：资料 4 的配套代码

## 4. 分阶段路线

按每周 10–15 小时估算，总共约 14–16 周。每个阶段都会产出你 harness 的一个可运行版本。

### 阶段 0：准备（第 1 周）
- [ ] 拿到一个模型 API Key。建议 harness 从一开始就抽象出 provider 层，同时支持 Anthropic API 和兼容 OpenAI 的接口（国内模型、vLLM 都能接）
- [ ] 读《Building Effective Agents》
- [ ] 把教程 s01 跑起来（Python 版），确认 API 能通

### 阶段 1：核心循环与工具（第 2–4 周）· 教程 s01–s04
- s01 Agent Loop：`while` 循环 + `stop_reason`
- s02 Tool Use：read / write / edit / grep / bash 五个工具，并行调用
- s03 Permission：权限系统
- s04 Hooks：在工具调用前后插入逻辑
- **产出**：用 TS 写出 `my-harness` v0.1，一个能在终端读写文件、执行命令的 CLI agent，带权限确认

### 阶段 2：规划、上下文与记忆（第 5–8 周）· 教程 s05–s11
- s05 TodoWrite、s06 Subagent、s07 Skills
- s08 Context Compact、s09 Memory
- s10 System Prompt、s11 Error Recovery
- **产出**：v0.2，能自己列计划、派子 agent、长对话时自动压缩、跨会话记住偏好

### 阶段 3：长任务、多 agent 与 MCP（第 9–12 周）· 教程 s12–s20 + 资料 4、5、6
- s12 Task System、s13 Background Tasks、s14 Cron
- s15–s17 Agent Teams / 协议 / 自主 agent、s18 Worktree 隔离
- s19 MCP Tools、s20 完整的一轮 agent 执行
- 照资料 4 实现：`feature_list.json` + 进度文件 + `init.sh` 的交接机制
- 照资料 6 实现：planner / generator / evaluator 三个角色，用 Playwright 做 evaluator 的端到端验证（这正是前端的强项）
- **产出**：v0.3，能接 MCP server，能跑几个小时的长任务并在会话之间交接

### 阶段 4：评估与可观测性（第 13–14 周）
- 建一个小型评测集（例如 20 个编码任务），对比：单 agent vs 完整 harness、有 evaluator vs 没有
- 记录每次运行的 trace（耗时、token、成本、工具调用），**用你的前端能力做一个 trace 查看器**
- 照资料 6 的方法做消融：一次移除一个组件，看效果变化
- **产出**：评测报告 + trace 可视化，面试时最有说服力的材料

### 阶段 5：开源模型与部署（第 15–16 周，可选）
- 用 vLLM 起一个兼容 OpenAI 的服务（需要 GPU，可以租云 GPU），让你的 harness 接上去
- 浏览 ModelScope cookbook，了解 Qwen 等开源模型的选型和 tool calling 表现
- 在你的评测集上对比闭源模型和开源模型
- **产出**：一篇对比文章

### 专题：提示词学习（贯穿各阶段）
harness 里到处是提示词：system prompt、工具描述、子 agent 指令、压缩摘要、evaluator 评分标准。和教程并行学，重点配合 s10 System Prompt。
- [ ] 模板变量：`{{var}}` 只是给程序的占位符，模型不会替换。在 harness 里实现一个提示词模板层（字符串替换或 Jinja 风格）
- [ ] 结构化：用 XML 标签区分指令、上下文和用户输入；角色设定、输出格式约束
- [ ] few-shot 示例与思维链：什么时候有用，怎么挑例子
- [ ] 工具描述怎么写：模型选不选、怎么用一个工具，很大程度取决于描述
- [ ] 安全：提示词注入（工具结果、网页内容里夹带指令）与越狱的常见手法，以及 harness 侧怎么防
- **产出**：`notes/` 里的提示词笔记 + harness 里的模板层与几个 system prompt 版本对比

## 5. 求职产出清单

- [ ] **作品仓库 `my-harness`**（建议单独建仓库）：清晰的 README、架构图、demo 视频或 GIF
- [ ] **本仓库 `ai-agent-learning`**：20 章学习笔记，体现学习过程
- [ ] **3–5 篇技术博客**（发在 siaikin.me），参考题目：
  - 《从前端视角读 Claude Code 源码：agent 循环与插件化 harness》
  - 《用 Playwright 给 agent 做 evaluator》
  - 《我的 harness 消融实验：哪些组件真的有用》
- [ ] **评测报告**：数据比结论更有说服力
- [ ] 简历重新定位：「前端 + Agent 工程」。突出 TypeScript、工具链与插件系统设计、端到端测试、可视化

岗位方向（国内常见名称）：AI Agent 开发工程师、大模型应用开发工程师、AI 产品工程师（全栈偏前端）。其中 AI 产品工程师和你的背景最贴合。

## 6. 每章的学习方法

1. 读教程正文，跑 Python 版代码
2. 在 `notes/` 写笔记（一句话总结、核心概念、和 Claude Code 源码的差异、疑问）
3. 在你的 TS harness 里实现同一个机制
4. 写一个小测试或 demo 证明它能用
5. 提交，在 README 的学习日志里记一行

---

⚠️ **说明**：OpenAI《Harness engineering》一文在本环境访问时被网站拦截（HTTP 403），上表对它的描述来自我已有的了解，尚未核对原文。你方便的话可以把正文贴给我，我再补充修正。
