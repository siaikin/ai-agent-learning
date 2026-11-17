/**
 * s05 · TodoWrite —— "先列计划，再动手"
 *
 * 对应教程：https://learn.shareai.run/zh/s05/
 *
 * 相对 s04 的变化：
 *   - 新增 todo_write 工具（lib/todo.ts）：模型提交整张任务清单，harness 校验后保存并显示给你
 *   - 新增 todo 插件（下方 todoPlugin），全部用 s04 的 hook 实现，循环一行没改：
 *       PostToolUse  连续多次工具调用都没更新清单 → 在工具输出末尾追加提醒
 *       Stop         清单里还有没做完的项就想收工 → 让模型继续，做完或更新清单
 *   - 循环本身抽到了 lib/agent.ts，从这一章起共用
 *
 * 规划本身完全由模型完成，harness 只提供“记下来、显示出来、提醒它”的机制。
 */
import { createInterface } from "node:readline/promises";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import { createClient, loadConfig } from "./config.js";
import { runAgentLoop } from "./lib/agent.js";
import { terminalAsk } from "./lib/ask.js";
import { HookRegistry, type HookPlugin } from "./lib/hooks.js";
import type { SessionAllow } from "./lib/permission.js";
import { TodoList, todoTool } from "./lib/todo.js";
import { auditPlugin, permissionPlugin } from "./lib/plugins.js";
import { initTelemetry } from "./lib/telemetry.js";
import { WORKDIR, buildToolset } from "./lib/tools.js";

const SYSTEM = `You are a coding agent running in ${WORKDIR} on ${process.platform}.
For any task with 3 or more steps, first call todo_write with a short plan, then work through it:
keep exactly one item in_progress, and call todo_write again to mark it completed before starting the next.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
If a tool call is denied, do not retry the same action.
When the task is done, reply with a short summary and do not call tools.`;

/** 在终端里把清单画出来：你随时能看到 agent 的计划和进度 */
export function printTodos(list: TodoList) {
  const color = { pending: "\x1b[90m", in_progress: "\x1b[36m", completed: "\x1b[32m" } as const;
  console.log("\x1b[1m📋 Todo\x1b[0m");
  for (const t of list.items) {
    const mark = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "○";
    console.log(`   ${color[t.status]}${mark} ${t.content}\x1b[0m`);
  }
}

/**
 * 用 hook 实现的两个“督促”机制（都只看清单状态，不读模型的回复内容）
 *   remindAfter：连续这么多次工具调用都没碰 todo_write，就在工具输出后面追加提醒
 */
export function todoPlugin(list: TodoList, remindAfter = 5): HookPlugin {
  let callsSinceUpdate = 0;
  return {
    name: "todo",
    UserPromptSubmit: () => {
      callsSinceUpdate = 0;
    },
    PostToolUse: ({ tool, output }) => {
      if (tool === "todo_write") {
        callsSinceUpdate = 0;
        return;
      }
      callsSinceUpdate++;
      if (list.unfinished.length > 0 && callsSinceUpdate >= remindAfter) {
        callsSinceUpdate = 0; // 提醒过一次就重新计数，避免每次都提醒
        return {
          output:
            `${output}\n\n<reminder>You have made ${remindAfter} tool calls without updating your todo list. ` +
            `Current list:\n${list.render()}\nUpdate it with todo_write if your progress changed.</reminder>`,
        };
      }
    },
    Stop: () => {
      if (list.unfinished.length > 0) {
        return {
          continueWith:
            `[todo hook] Your todo list still has unfinished items:\n${list.render()}\n` +
            "Finish them, or call todo_write to mark them completed or remove the ones that are no longer needed.",
        };
      }
    },
  };
}

async function main() {
  const config = loadConfig(); // 同时把 .env 加载进环境变量，Langfuse SDK 从这里读 key
  const telemetry = initTelemetry({ tags: ["s05"] });
  const client = telemetry.wrapClient(createClient(config));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }];
  const sessionAllow: SessionAllow = new Set();
  const todos = new TodoList();

  const toolset = buildToolset([todoTool(todos, printTodos)]);
  const hooks = new HookRegistry()
    .use(auditPlugin())
    .use(permissionPlugin(terminalAsk(rl), sessionAllow))
    .use(todoPlugin(todos));

  console.log(`s05 todo · ${config.baseURL} · model=${config.model}`);
  console.log(`工具：${toolset.defs.map((t) => t.name).join(", ")}`);
  console.log(
    telemetry.enabled
      ? `\x1b[90mLangfuse 已启用 · ${process.env.LANGFUSE_BASE_URL} · session ${telemetry.sessionId}\x1b[0m`
      : "\x1b[90mLangfuse 未启用（运行 npm run setup -- langfuse 配置）\x1b[0m",
  );
  console.log("输入 q 退出");
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms05 >> \x1b[0m")).trim();
    } catch {
      break;
    }
    if (!query || query === "q" || query === "exit") break;
    const { block } = await hooks.runUserPromptSubmit({ prompt: query });
    if (block) continue;
    history.push({ role: "user", content: query });
    // 一轮对话 = Langfuse 里的一条 trace（没配置 Langfuse 时 traceTurn 直接执行，什么都不记录）
    const answer = await telemetry.traceTurn(query, () =>
      runAgentLoop(history, { client, model: config.model, toolset, hooks }),
    );
    console.log(`\n${answer}\n`);
  }
  rl.close();
  if (telemetry.enabled) console.log("\x1b[90m正在把剩余数据发送到 Langfuse…\x1b[0m");
  await telemetry.shutdown(); // 退出前一定要 flush，否则最后几条数据会丢
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
