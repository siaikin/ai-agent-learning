/**
 * s06 · Subagent —— "大任务拆小，每个小任务一个干净的上下文"
 *
 * 对应教程：https://learn.shareai.run/zh/s06/
 *
 * 相对 s05 的变化：
 *   - 新增 task 工具（lib/subagent.ts）：主 agent 把子任务交给一个拥有全新 messages[] 的子 agent，
 *     子 agent 跑完只交回结论，中间读过的文件、跑过的命令不进入主 agent 的上下文
 *   - 子 agent 复用同一个 runAgentLoop，只是换了：工具（没有 task 和 todo_write）、
 *     system prompt、插件（只有审计和权限）、最多 30 轮
 *   - 为此 lib/ 做了两处小改动：工具 handler 可以是异步的；runAgentLoop 支持 maxTurns
 *
 * 权限：子 agent 和主 agent 共用同一个 sessionAllow，在主 agent 里选过“本会话都允许”的操作，
 * 子 agent 也不会再问；需要询问时，提示照样出现在你的终端里。
 */
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";

import { createClient, loadConfig } from "./config.js";
import { runAgentLoop } from "./lib/agent.js";
import { terminalAsk } from "./lib/ask.js";
import { HookRegistry } from "./lib/hooks.js";
import type { SessionAllow } from "./lib/permission.js";
import { auditPlugin, permissionPlugin } from "./lib/plugins.js";
import { taskTool } from "./lib/subagent.js";
import { initTelemetry } from "./lib/telemetry.js";
import { TodoList, todoTool } from "./lib/todo.js";
import { WORKDIR, buildToolset } from "./lib/tools.js";
import { printTodos, todoPlugin } from "./s05-todo.js";

const SYSTEM = `You are a coding agent running in ${WORKDIR} on ${process.platform}.
For any task with 3 or more steps, first call todo_write with a short plan, then work through it:
keep exactly one item in_progress, and call todo_write again to mark it completed before starting the next.
Use the task tool to delegate a self-contained subtask that needs a lot of reading or exploration
(e.g. "find which test framework this project uses"), so the details stay out of this conversation.
The subagent starts with no context: put everything it needs into the description.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
If a tool call is denied, do not retry the same action.
When the task is done, reply with a short summary and do not call tools.`;

async function main() {
  const config = loadConfig();
  const telemetry = initTelemetry({ tags: ["s06"] });
  const client = createClient(config);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];
  const sessionAllow: SessionAllow = new Set();
  const askUser = terminalAsk(rl);
  const todos = new TodoList();

  // 子 agent：基础工具（没有 task → 不能递归；没有 todo_write → 子任务不需要计划清单），只挂审计和权限
  const subTools = buildToolset();
  const subHooks = new HookRegistry().use(auditPlugin()).use(permissionPlugin(askUser, sessionAllow));
  const task = taskTool({ client, model: config.model, maxTokens: config.maxTokens, toolset: subTools, hooks: subHooks });

  // 主 agent：基础工具 + todo_write + task
  const toolset = buildToolset([todoTool(todos, printTodos), task]);
  const hooks = new HookRegistry()
    .use(auditPlugin())
    .use(permissionPlugin(askUser, sessionAllow))
    .use(todoPlugin(todos));

  console.log(`s06 subagent · ${config.baseURL || "Anthropic 官方"} · model=${config.model}`);
  console.log(`主 agent 工具：${toolset.defs.map((t) => t.name).join(", ")}`);
  console.log(`子 agent 工具：${subTools.defs.map((t) => t.name).join(", ")}`);
  console.log(
    telemetry.enabled
      ? `\x1b[90mLangfuse 已启用 · session ${telemetry.sessionId}\x1b[0m`
      : "\x1b[90mLangfuse 未启用（运行 npm run setup -- langfuse 配置）\x1b[0m",
  );
  console.log("输入 q 退出");
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms06 >> \x1b[0m")).trim();
    } catch {
      break;
    }
    if (!query || query === "q" || query === "exit") break;
    const { block } = await hooks.runUserPromptSubmit({ prompt: query });
    if (block) continue;
    history.push({ role: "user", content: query });
    const answer = await telemetry.traceTurn(query, () =>
      runAgentLoop(history, { client, model: config.model, system: SYSTEM, maxTokens: config.maxTokens, toolset, hooks }),
    );
    console.log(`\n${answer}\n`);
    console.log(`\x1b[90m（主 agent 的对话历史现在有 ${history.length} 条消息）\x1b[0m`);
  }
  rl.close();
  if (telemetry.enabled) console.log("\x1b[90m正在把剩余数据发送到 Langfuse…\x1b[0m");
  await telemetry.shutdown();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
