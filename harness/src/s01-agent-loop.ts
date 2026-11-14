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
 * 与教程（Anthropic 格式）的差异：这里使用 OpenAI 兼容格式（DeepSeek / 自建 API 等）。
 *   - 停止信号：教程看 stop_reason === "tool_use"，这里看 message.tool_calls 是否非空
 *     （和 Claude Code 一样直接检查内容，而不是只依赖 finish_reason）
 *   - 工具结果：教程放在 role:"user" 的 tool_result 块里，这里是独立的 role:"tool" 消息
 *   - system prompt：教程是单独的 system 参数，这里是 messages 里的第一条 role:"system"
 *
 * ⚠️ 教学 demo：会执行模型生成的 shell 命令，请在临时目录中运行。权限系统在 s03 实现。
 */
import { execSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { createClient, loadConfig } from "./config.js";

const config = loadConfig();
const MODEL = config.model;
const client = createClient(config);

const SYSTEM = `You are a coding agent running in ${process.cwd()} on ${process.platform}.
Use the bash tool to inspect and change files. Act, don't just explain.
When the task is done, reply with a short summary and do not call tools.`;

// ---- 工具：只有一个 bash ----
const TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "bash",
      description: "Run a shell command and return its stdout and stderr.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to run" },
        },
        required: ["command"],
      },
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
export async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("模型没有返回内容");

    messages.push(message); // 把模型的回答（含 tool_calls）追加进历史

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) return message.content ?? ""; // 不再调用工具 → 结束

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const { command } = JSON.parse(call.function.arguments) as { command: string };
      console.log(`\x1b[33m$ ${command}\x1b[0m`);
      const output = runBash(command);
      console.log(output.slice(0, 500));
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}

// ---- REPL：多轮对话，messages 在轮次之间保留 ----
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }];
  console.log(`s01 agent loop · ${config.baseURL} · model=${MODEL} · 输入 q 退出`);
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
