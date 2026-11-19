/**
 * s03 · Permission —— "工具执行前先做权限判断"
 *
 * 对应教程：https://learn.shareai.run/zh/s03/
 *
 * 相对 s02 的变化：
 *   - 工具执行前插入 checkPermission()：deny（拒绝列表）→ ask（询问规则）→ allow
 *   - ask 时暂停循环，在终端里问你：允许一次 / 本会话同类都允许 / 拒绝（可附上理由）
 *   - 被拒绝的调用不执行，而是告诉模型“被拒绝了、为什么”，让它换个做法
 *   - 循环结构不变；工具和权限规则分别来自 lib/tools.ts、lib/permission.ts
 *
 * 设计选择：agentLoop 不直接读终端，而是接收一个 askUser 回调（依赖注入）。
 * 这样同一个循环可以接终端、Web UI，测试时也能传入一个自动回答的假函数。
 */
import { createInterface, type Interface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";

import { createClient, loadConfig } from "./config.js";
import { checkPermission, type SessionAllow } from "./lib/permission.js";
import { TOOLS, WORKDIR, executeTool, validateInput, tools } from "./lib/tools.js";

const config = loadConfig();
const MODEL = config.model;
const client = createClient(config);

const SYSTEM = `You are a coding agent running in ${WORKDIR} on ${process.platform}.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
Some tool calls need the user's approval. If a call is denied, do not retry the same action;
choose a different approach or ask the user.
When the task is done, reply with a short summary and do not call tools.`;

// ---- 闸门 3：用户审批 ----
export interface AskRequest {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}
export type AskAnswer = { allow: true; always: boolean } | { allow: false; feedback?: string };
export type AskUser = (req: AskRequest) => Promise<AskAnswer>;

function terminalAsk(rl: Interface): AskUser {
  return async ({ tool, args, reason }) => {
    console.log(`\n\x1b[33m⚠  需要你确认：${reason}\x1b[0m`);
    console.log(`   ${tool} ${JSON.stringify(args).slice(0, 300)}`);
    const choice = (await rl.question("   [y] 允许一次  [a] 本会话同类操作都允许  [n] 拒绝（默认）> "))
      .trim()
      .toLowerCase();
    if (choice === "y" || choice === "yes") return { allow: true, always: false };
    if (choice === "a") return { allow: true, always: true };
    const feedback = (await rl.question("   （可选）告诉模型为什么拒绝、或者该怎么做，回车跳过 > ")).trim();
    return { allow: false, feedback: feedback || undefined };
  };
}

// ---- 核心：agent 循环（s02 的循环 + 执行前的权限检查） ----
export async function agentLoop(
  messages: Anthropic.MessageParam[],
  askUser: AskUser,
  sessionAllow: SessionAllow,
) {
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

    if (toolUses.length === 0) return text;

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

      // ↓↓↓ s03 新增：执行前的权限检查 ↓↓↓
      const decision = checkPermission(name, parsed.args, sessionAllow);
      if (decision.behavior === "deny") {
        console.log(`\x1b[31m⛔ 已拦截：${decision.reason}\x1b[0m`);
        reply(`Permission denied by policy: ${decision.reason}. This action is never allowed; do not retry it.`, true);
        continue;
      }
      if (decision.behavior === "ask") {
        const answer = await askUser({ tool: name, args: parsed.args, reason: decision.reason });
        if (!answer.allow) {
          console.log("\x1b[31m✕ 你拒绝了这次调用\x1b[0m");
          reply(
            "Permission denied by the user." +
              (answer.feedback ? ` User says: ${answer.feedback}` : "") +
              " Do not retry the same action; choose another approach or ask the user.",
            true,
          );
          continue;
        }
        if (answer.always) sessionAllow.add(decision.ruleId);
      }
      // ↑↑↑ s03 新增 ↑↑↑

      const output = executeTool(name, parsed.args);
      console.log(output.slice(0, 500));
      reply(output, output.startsWith("Error"));
    }
    messages.push({ role: "user", content: results });
  }
}

// ---- REPL ----
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = []; // Claude 格式：system prompt 单独传，不在 messages 里
  const sessionAllow: SessionAllow = new Set();
  const askUser = terminalAsk(rl);
  console.log(`s03 permission · ${config.baseURL || "Anthropic 官方"} · model=${MODEL} · 工具：${tools.map((t) => t.name).join(", ")}`);
  console.log("输入 q 退出");
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms03 >> \x1b[0m")).trim();
    } catch {
      break;
    }
    if (!query || query === "q" || query === "exit") break;
    history.push({ role: "user", content: query });
    const answer = await agentLoop(history, askUser, sessionAllow);
    console.log(`\n${answer}\n`);
  }
  rl.close();
}

// 被测试或其他模块 import 时不启动 REPL
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
