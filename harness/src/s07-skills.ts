/**
 * s07 · Skills —— "用到时再加载，别全塞 prompt 里"
 *
 * 对应教程：https://learn.shareai.run/zh/s07/
 *
 * 相对 s06 的变化：
 *   - 启动时扫描技能目录（lib/skills.ts），把每个技能的名字和一句话描述放进 system prompt
 *   - 新增 load_skill 工具：模型需要时再加载完整的 SKILL.md，内容作为工具结果进入对话
 *   - 技能有两个来源：harness/skills/（内置）和 <工作目录>/.harness/skills/（项目自己的，同名覆盖内置）
 *
 * 子 agent 这一章没有给 load_skill：主 agent 可以先加载技能，再把需要的规范写进 task 的描述里。
 */
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";

import { createClient, loadConfig } from "./config.js";
import { runAgentLoop } from "./lib/agent.js";
import { terminalAsk } from "./lib/ask.js";
import { HookRegistry } from "./lib/hooks.js";
import type { SessionAllow } from "./lib/permission.js";
import { auditPlugin, permissionPlugin } from "./lib/plugins.js";
import { loadSkillTool, scanSkills, skillCatalog } from "./lib/skills.js";
import { taskTool } from "./lib/subagent.js";
import { initTelemetry } from "./lib/telemetry.js";
import { TodoList, todoTool } from "./lib/todo.js";
import { WORKDIR, buildToolset } from "./lib/tools.js";
import { printTodos, todoPlugin } from "./s05-todo.js";

/** 第一层：技能目录在启动时拼进 system prompt，之后整个会话不变（也有利于 prompt 缓存） */
export function buildSystem(catalog: string) {
  return `You are a coding agent running in ${WORKDIR} on ${process.platform}.
For any task with 3 or more steps, first call todo_write with a short plan, then work through it:
keep exactly one item in_progress, and call todo_write again to mark it completed before starting the next.
Use the task tool to delegate a self-contained subtask that needs a lot of reading or exploration.
The subagent starts with no context: put everything it needs into the description.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
If a tool call is denied, do not retry the same action.

Skills available (call load_skill to get the full instructions before doing a task a skill covers):
${catalog}

When the task is done, reply with a short summary and do not call tools.`;
}

async function main() {
  const config = loadConfig();
  const telemetry = initTelemetry({ tags: ["s07"] });
  const client = createClient(config);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];
  const sessionAllow: SessionAllow = new Set();
  const askUser = terminalAsk(rl);
  const todos = new TodoList();

  const skills = scanSkills();
  const SYSTEM = buildSystem(skillCatalog(skills));

  const subTools = buildToolset();
  const subHooks = new HookRegistry().use(auditPlugin()).use(permissionPlugin(askUser, sessionAllow));
  const task = taskTool({ client, model: config.model, maxTokens: config.maxTokens, toolset: subTools, hooks: subHooks });

  const toolset = buildToolset([todoTool(todos, printTodos), task, loadSkillTool(skills)]);
  const hooks = new HookRegistry()
    .use(auditPlugin())
    .use(permissionPlugin(askUser, sessionAllow))
    .use(todoPlugin(todos));

  console.log(`s07 skills · ${config.baseURL || "Anthropic 官方"} · model=${config.model}`);
  console.log(`工具：${toolset.defs.map((t) => t.name).join(", ")}`);
  console.log(`技能（${skills.size} 个）：`);
  for (const s of skills.values()) console.log(`  \x1b[36m${s.name}\x1b[0m \x1b[90m[${s.source}] ${s.description.slice(0, 70)}…\x1b[0m`);
  console.log(
    telemetry.enabled
      ? `\x1b[90mLangfuse 已启用 · session ${telemetry.sessionId}\x1b[0m`
      : "\x1b[90mLangfuse 未启用（运行 npm run setup -- langfuse 配置）\x1b[0m",
  );
  console.log("输入 q 退出");
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms07 >> \x1b[0m")).trim();
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
