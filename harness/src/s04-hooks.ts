/**
 * s04 · Hooks —— "挂在循环上，不写进循环里"
 *
 * 对应教程：https://learn.shareai.run/zh/s04/
 *
 * 相对 s03 的变化：
 *   - 循环里不再直接调用 checkPermission()，改为在 4 个时机触发 hook：
 *       UserPromptSubmit → PreToolUse → (执行) → PostToolUse → … → Stop
 *   - s03 的权限检查变成了一个插件，和其他插件一样注册进来
 *   - 新增几个示例插件，演示每种 hook 能做什么（见下方 PLUGINS）
 *
 * 想加新行为（记日志、通知、自动格式化……），写一个插件 use() 进来即可，循环一行不用改。
 */
import { execSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";

import { createClient, loadConfig } from "./config.js";
import { terminalAsk, type AskUser } from "./lib/ask.js";
import { HookRegistry, type HookPlugin } from "./lib/hooks.js";
import { checkPermission, type SessionAllow } from "./lib/permission.js";
import { TOOLS, WORKDIR, executeTool, validateInput } from "./lib/tools.js";

const config = loadConfig();
const MODEL = config.model;
const client = createClient(config);

const SYSTEM = `You are a coding agent running in ${WORKDIR} on ${process.platform}.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
Some tool calls need the user's approval. If a call is denied, do not retry the same action;
choose a different approach or ask the user.
When the task is done, reply with a short summary and do not call tools.`;

const dim = (s: string) => console.log(`\x1b[90m${s}\x1b[0m`);

// ======================= 示例插件 =======================

/** UserPromptSubmit：给每次输入补充当前时间和 git 分支 */
export const contextPlugin: HookPlugin = {
  name: "context",
  UserPromptSubmit: () => {
    let branch = "(not a git repo)";
    try {
      branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: WORKDIR, encoding: "utf8", stdio: "pipe" }).trim();
    } catch {}
    dim(`[hook] UserPromptSubmit · 补充上下文：git 分支 ${branch}`);
    return { addContext: `Current time: ${new Date().toISOString()}\nGit branch: ${branch}` };
  },
};

/** PreToolUse：把每次工具调用（包括后面被拒绝的）写进审计日志 */
export function auditPlugin(file = path.join(WORKDIR, ".harness", "audit.jsonl")): HookPlugin {
  return {
    name: "audit",
    PreToolUse: ({ tool, args }) => {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), tool, args }) + "\n");
      dim(`[hook] PreToolUse · 审计日志 ← ${tool}`);
    },
  };
}

/** PreToolUse：s03 的权限检查，原样搬进 hook */
export function permissionPlugin(askUser: AskUser, sessionAllow: SessionAllow): HookPlugin {
  return {
    name: "permission",
    PreToolUse: async ({ tool, args }) => {
      const decision = checkPermission(tool, args, sessionAllow);
      if (decision.behavior === "deny") {
        console.log(`\x1b[31m⛔ 已拦截：${decision.reason}\x1b[0m`);
        return { block: `Permission denied by policy: ${decision.reason}. This action is never allowed; do not retry it.` };
      }
      if (decision.behavior === "ask") {
        const answer = await askUser({ tool, args, reason: decision.reason });
        if (!answer.allow) {
          console.log("\x1b[31m✕ 你拒绝了这次调用\x1b[0m");
          return {
            block:
              "Permission denied by the user." +
              (answer.feedback ? ` User says: ${answer.feedback}` : "") +
              " Do not retry the same action; choose another approach or ask the user.",
          };
        }
        if (answer.always) sessionAllow.add(decision.ruleId);
      }
    },
  };
}

/** PostToolUse：输出太长时只保留头尾，省 token */
export function largeOutputPlugin(limit = 20_000): HookPlugin {
  return {
    name: "large-output",
    PostToolUse: ({ tool, output }) => {
      if (output.length <= limit) return;
      dim(`[hook] PostToolUse · ${tool} 输出 ${output.length} 字符，已截断`);
      const head = output.slice(0, limit * 0.8);
      const tail = output.slice(-limit * 0.1);
      return { output: `${head}\n\n... [${output.length - head.length - tail.length} chars omitted by hook] ...\n\n${tail}` };
    },
  };
}

/**
 * 一个插件挂三个钩子，通过闭包共享状态：
 *   UserPromptSubmit 清零 → PostToolUse 记录“改过文件 / 跑过测试” → Stop 检查
 * 改了文件却没跑测试就想收工？让它继续，先跑测试。
 */
export function testGuardPlugin(): HookPlugin {
  let modified = false;
  let ranTests = false;
  return {
    name: "test-guard",
    UserPromptSubmit: () => {
      modified = false;
      ranTests = false;
    },
    PostToolUse: ({ tool, args }) => {
      if (tool === "write_file" || tool === "edit_file") modified = true;
      const cmd = typeof args.command === "string" ? args.command : "";
      if (tool === "bash" && /\b(test|tests|vitest|jest|pytest|tsc)\b/.test(cmd)) ranTests = true;
    },
    Stop: () => {
      if (modified && !ranTests) {
        dim("[hook] Stop · 改了文件但没跑测试，让模型继续");
        return {
          continueWith:
            "[test-guard hook] You modified files but did not run any tests or type checks. " +
            "Run the relevant tests now, or explain briefly why they are not needed.",
        };
      }
    },
  };
}

// ======================= 核心：agent 循环 =======================

export async function agentLoop(messages: Anthropic.MessageParam[], hooks: HookRegistry) {
  let stopHookActive = false; // 本轮是否已经被 Stop 钩子强制续跑过
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: config.maxTokens,
      system: SYSTEM,
      messages,
      tools: TOOLS,
    });
    messages.push({ role: "assistant", content: response.content });
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

    if (toolUses.length === 0) {
      // ↓ Stop：模型想收工，问问 hook 同不同意。每轮最多续跑一次，防止死循环
      if (!stopHookActive) {
        const continueWith = await hooks.runStop({ messages });
        if (continueWith) {
          stopHookActive = true;
          messages.push({ role: "user", content: continueWith });
          continue;
        }
      }
      return text;
    }

    // 同一轮的所有工具结果收集起来，最后放进同一条 user 消息
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const name = block.name;
      const reply = (content: string, isError = false) =>
        results.push({ type: "tool_result", tool_use_id: block.id, content, ...(isError ? { is_error: true } : {}) });
      console.log(`\x1b[33m▶ ${name}\x1b[0m \x1b[2m${JSON.stringify(block.input).slice(0, 200)}\x1b[0m`);

      const parsed = validateInput(block.input);
      if (!parsed.ok) {
        reply(parsed.error, true);
        continue;
      }

      // ↓ PreToolUse：s03 这里是 checkPermission(...)，现在交给 hook
      const blocked = await hooks.runPreToolUse({ tool: name, args: parsed.args });
      if (blocked) {
        reply(blocked, true);
        continue;
      }

      const raw = executeTool(name, parsed.args);
      // ↓ PostToolUse：hook 可以改写输出
      const output = await hooks.runPostToolUse({ tool: name, args: parsed.args, output: raw });
      console.log(output.slice(0, 500));
      reply(output, output.startsWith("Error"));
    }
    messages.push({ role: "user", content: results });
  }
}

// ======================= REPL =======================

async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = []; // Claude 格式：system prompt 单独传，不在 messages 里
  const sessionAllow: SessionAllow = new Set();

  // 注册顺序就是执行顺序：audit 在 permission 前面，所以被拒绝的调用也会被记录
  const hooks = new HookRegistry()
    .use(contextPlugin)
    .use(auditPlugin())
    .use(permissionPlugin(terminalAsk(rl), sessionAllow))
    .use(largeOutputPlugin())
    .use(testGuardPlugin());

  console.log(`s04 hooks · ${config.baseURL || "Anthropic 官方"} · model=${MODEL}`);
  for (const [event, names] of Object.entries(hooks.list())) dim(`  ${event.padEnd(16)} ${names.join(", ")}`);
  console.log("输入 q 退出");

  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms04 >> \x1b[0m")).trim();
    } catch {
      break;
    }
    if (!query || query === "q" || query === "exit") break;

    // ↓ UserPromptSubmit：可以拦下输入，或补充上下文
    const { block, contexts } = await hooks.runUserPromptSubmit({ prompt: query });
    if (block) {
      console.log(`\x1b[31m输入被 hook 拦下：${block}\x1b[0m`);
      continue;
    }
    const content = contexts.length ? `${query}\n\n<context>\n${contexts.join("\n")}\n</context>` : query;
    history.push({ role: "user", content });

    const answer = await agentLoop(history, hooks);
    console.log(`\n${answer}\n`);
  }
  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
