/**
 * s02 · Tool Use —— "加一个工具，只加一个 handler"
 *
 * 对应教程：https://learn.shareai.run/zh/s02/
 *
 * 相对 s01 的变化：
 *   - 工具从 1 个（bash）变成 5 个：bash / read_file / write_file / edit_file / glob
 *   - 执行工具从硬编码 runBash() 变成查表：TOOL_HANDLERS[name](args)
 *   - 文件类工具加了 safePath()：路径不能逃出工作目录
 *   - agent 循环本身一行没改
 *
 * 与教程的差异（TypeScript 版的设计选择）：
 *   1. 用 defineTool() 把「schema + 实现」放在一个对象里，再自动生成 TOOLS 和 TOOL_HANDLERS。
 *      教程把两者分开写，便于理解；Claude Code 的 buildTool() 也是放在一起的，这样加工具时不会漏掉一边。
 *   2. 工具名写错、参数 JSON 解析失败、handler 抛异常时，都把错误作为 tool 结果还给模型，
 *      而不是让整个程序崩掉——模型看到错误后通常能自己修正。
 *   3. edit_file 要求 old_text 在文件中恰好出现一次（Claude Code 的做法），
 *      教程是替换第一次出现的位置，容易改错地方。
 *
 * ⚠️ bash 仍然不受限制（rm -rf 照样能跑），请在临时目录中运行。权限系统在 s03 实现。
 */
import { execSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

import { createClient, loadConfig } from "./config.js";

const config = loadConfig();
const MODEL = config.model;
const client = createClient(config);
const WORKDIR = process.cwd();

const SYSTEM = `You are a coding agent running in ${WORKDIR} on ${process.platform}.
Prefer the dedicated file tools (read_file, write_file, edit_file, glob) over bash for file operations.
You may call several tools at once when they don't depend on each other.
When the task is done, reply with a short summary and do not call tools.`;

const MAX_OUTPUT = 50_000; // 防止超长输出撑爆上下文

// ---- 路径安全：文件类工具只能访问工作目录内的文件 ----
function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// ---- 工具定义：schema 和实现放在一起 ----
interface ToolDef<A> {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  handler: (args: A) => string;
}
// 泛型只用于让 handler 的参数有类型提示；注册表里统一当作 ToolDef<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const defineTool = <A>(def: ToolDef<A>): ToolDef<any> => def;

const tools = [
  defineTool<{ command: string }>({
    name: "bash",
    description: "Run a shell command and return its stdout and stderr.",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The shell command to run" } },
      required: ["command"],
    },
    handler: ({ command }) => {
      try {
        const out = execSync(command, {
          cwd: WORKDIR,
          encoding: "utf8",
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return out || "(no output)";
      } catch (err) {
        const e = err as { stdout?: string; stderr?: string; message: string };
        return `Error: ${e.stderr || e.stdout || e.message}`;
      }
    },
  }),

  defineTool<{ path: string; limit?: number }>({
    name: "read_file",
    description: "Read a text file. Returns its contents with line numbers.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace" },
        limit: { type: "integer", description: "Only read the first N lines" },
      },
      required: ["path"],
    },
    handler: ({ path: p, limit }) => {
      const text = readFileSync(safePath(p), "utf8");
      let lines = text.split("\n");
      if (text.endsWith("\n")) lines.pop(); // 结尾换行不算一行
      const total = lines.length;
      if (limit) lines = lines.slice(0, limit);
      // 带行号，方便模型后续引用和编辑
      const body = lines.map((l, i) => `${String(i + 1).padStart(5)}  ${l}`).join("\n");
      return lines.length < total ? `${body}\n... (${total - lines.length} more lines)` : body;
    },
  }),

  defineTool<{ path: string; content: string }>({
    name: "write_file",
    description: "Create or overwrite a file with the given content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["path", "content"],
    },
    handler: ({ path: p, content }) => {
      const file = safePath(p);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return `Wrote ${Buffer.byteLength(content)} bytes to ${p}`;
    },
  }),

  defineTool<{ path: string; old_text: string; new_text: string }>({
    name: "edit_file",
    description:
      "Replace old_text with new_text in a file. old_text must appear exactly once; include enough surrounding context to make it unique.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path, relative to the workspace" },
        old_text: { type: "string", description: "Exact text to replace" },
        new_text: { type: "string", description: "Replacement text" },
      },
      required: ["path", "old_text", "new_text"],
    },
    handler: ({ path: p, old_text, new_text }) => {
      const file = safePath(p);
      const text = readFileSync(file, "utf8");
      const count = text.split(old_text).length - 1;
      if (count === 0) return "Error: old_text not found";
      if (count > 1) return `Error: old_text appears ${count} times; add more context to make it unique`;
      // 用函数形式替换，避免 new_text 里的 $& 等被当成特殊替换模式
      writeFileSync(file, text.replace(old_text, () => new_text));
      return `Edited ${p}`;
    },
  }),

  defineTool<{ pattern: string }>({
    name: "glob",
    description: 'Find files matching a glob pattern, e.g. "**/*.ts". Returns paths relative to the workspace.',
    parameters: {
      type: "object",
      properties: { pattern: { type: "string", description: "Glob pattern" } },
      required: ["pattern"],
    },
    handler: ({ pattern }) => {
      const matches = globSync(pattern, {
        cwd: WORKDIR,
        exclude: (f) => f === "node_modules" || f === ".git",
      });
      return matches.length ? matches.sort().join("\n") : "(no matches)";
    },
  }),
];

// ---- 从注册表自动生成：给模型看的 TOOLS，和给循环用的 TOOL_HANDLERS ----
const TOOLS: ChatCompletionTool[] = tools.map(({ name, description, parameters }) => ({
  type: "function",
  function: { name, description, parameters },
}));
const TOOL_HANDLERS = Object.fromEntries(tools.map((t) => [t.name, t.handler]));

function runTool(name: string, rawArgs: string): string {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return `Error: unknown tool "${name}"`;
  let args: unknown;
  try {
    args = JSON.parse(rawArgs || "{}");
  } catch {
    return `Error: invalid JSON arguments: ${rawArgs}`;
  }
  try {
    return handler(args).slice(0, MAX_OUTPUT);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}

// ---- 核心：agent 循环（和 s01 相同，只有执行工具那一行变成查表） ----
export async function agentLoop(messages: ChatCompletionMessageParam[]) {
  while (true) {
    const response = await client.chat.completions.create({
      model: MODEL,
      messages,
      tools: TOOLS,
    });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("模型没有返回内容");

    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) return message.content ?? "";

    if (toolCalls.length > 1) console.log(`\x1b[2m(本轮 ${toolCalls.length} 个工具调用)\x1b[0m`);
    // 和教程一样按顺序逐个执行；Claude Code 会把连续的只读调用并发执行
    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const { name, arguments: rawArgs } = call.function;
      console.log(`\x1b[33m▶ ${name}\x1b[0m \x1b[2m${rawArgs.slice(0, 200)}\x1b[0m`);
      const output = runTool(name, rawArgs); // ← s01 这里是 runBash(command)
      console.log(output.slice(0, 500));
      messages.push({ role: "tool", tool_call_id: call.id, content: output });
    }
  }
}

// ---- REPL ----
async function main() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const history: ChatCompletionMessageParam[] = [{ role: "system", content: SYSTEM }];
  console.log(`s02 tool use · ${config.baseURL} · model=${MODEL} · 工具：${tools.map((t) => t.name).join(", ")}`);
  console.log("输入 q 退出");
  while (true) {
    let query: string;
    try {
      query = (await rl.question("\x1b[36ms02 >> \x1b[0m")).trim();
    } catch {
      break;
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
