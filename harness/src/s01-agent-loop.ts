/**
 * s01 · Agent Loop —— "One loop & Bash is all you need"
 *
 * 对应教程：https://learn.shareai.run/zh/s01/
 *
 * 最小可用的 agent：一个循环 + 一个 bash 工具。
 *   1. 把用户问题放进 messages
 *   2. 带上工具定义调用模型
 *   3. 模型要调用工具 → 执行 → 把结果追加进 messages → 回到 2
 *   4. 模型不再调用工具 → 结束
 *
 * 使用 Claude（Anthropic Messages API）格式，和教程的 Python 代码一一对应：
 *   - system prompt 是单独的 system 参数
 *   - 模型的回复是内容块数组，工具调用是其中的 tool_use 块，input 已经是对象
 *   - 工具结果放在下一条 role: "user" 消息里，每个结果是一个 tool_result 块
 *   - 停止信号：教程看 stop_reason === "tool_use"；这里和 Claude Code 一样直接看有没有 tool_use 块
 *
 * ⚠️ 教学 demo：会执行模型生成的 shell 命令，请在临时目录中运行。权限系统在 s03 实现。
 */
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type Anthropic from "@anthropic-ai/sdk";

import { createClient, loadConfig } from "./config.js";

const config = loadConfig();
const MODEL = config.model;
const client = createClient(config);

const SYSTEM = `You are a coding agent running in ${process.cwd()} on ${process.platform}.
Use the bash tool to inspect and change files. Act, don't just explain.
When the task is done, reply with a short summary and do not call tools.`;

// ---- 工具：只有一个 bash ----
const TOOLS: Anthropic.Tool[] = [
  {
    name: "bash",
    description: "Run a shell command and return its stdout and stderr.",
    input_schema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The shell command to run" },
      },
      required: ["command"],
    },
  },
];

const MAX_OUTPUT = 50_000; // 防止超长输出撑爆上下文

function runBash(command: string): string {
  try {
    const out = execSync(command, {
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return out.slice(0, MAX_OUTPUT) || "(no output)";
  } catch (err) {
    // 命令失败时也把错误信息还给模型，让它自己决定下一步
    const e = err as { stdout?: string; stderr?: string; message: string };
    return `Error: ${(e.stderr || e.stdout || e.message).slice(0, MAX_OUTPUT)}`;
  }
}

// ---- 核心：agent 循环 ----
export async function agentLoop(messages: Anthropic.MessageParam[]) {
  while (true) {
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: config.maxTokens,
      system: SYSTEM,
      messages,
      tools: TOOLS,
    });

    // 把模型的回答（完整的内容块数组，包括 tool_use）追加进历史
    messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (toolUses.length === 0) {
      // 不再调用工具 → 结束，返回文字部分
      return response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      const { command } = block.input as { command: string };
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const output = runBash(command);
      console.log(output.slice(0, 500));
      results.push({ type: "tool_result", tool_use_id: block.id, content: output });
    }
    // 同一轮的所有工具结果放进同一条 user 消息
    messages.push({ role: "user", content: results });
  }
}

// ---- REPL：多轮对话，messages 在轮次之间保留 ----
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: Anthropic.MessageParam[] = [];
  console.log(`s01 agent loop · ${config.baseURL || "Anthropic 官方"} · model=${MODEL} · 输入 q 退出`);
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms01 >> \x1b[0m")).trim();
    } catch {
      break; // 输入流结束（Ctrl+D / 管道输入读完）
    }
    if (!query || query === "q" || query === "exit") break;
    history.push({ role: "user", content: query });
    const answer = await agentLoop(history);
    console.log(`\n${answer}\n`);
  }
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
