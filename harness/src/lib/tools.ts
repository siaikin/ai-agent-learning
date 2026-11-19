/**
 * 共用的基础工具集（来自 s02）：bash / read_file / write_file / edit_file / glob
 *
 * s02 的教学文件保留原样作为那一章的快照；从 s03 开始的章节都从这里导入工具，
 * 每章只写自己新增的机制。
 */
import { execSync } from "node:child_process";
import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export const WORKDIR = process.cwd();

export const MAX_OUTPUT = 50_000; // 防止超长输出撑爆上下文

// ---- 路径安全：文件类工具只能访问工作目录内的文件 ----
export function safePath(p: string): string {
  const resolved = path.resolve(WORKDIR, p);
  const rel = path.relative(WORKDIR, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes workspace: ${p}`);
  }
  return resolved;
}

// ---- 工具定义：schema 和实现放在一起 ----
export interface ToolDef<A> {
  name: string;
  description: string;
  input_schema: Anthropic.Tool.InputSchema; // JSON Schema，字段名和 Claude API 一致
  /** 可以是同步或异步的。s06 的 task 工具要等子 agent 跑完，所以是异步的 */
  handler: (args: A) => string | Promise<string>;
}
// 泛型只用于让 handler 的参数有类型提示；注册表里统一当作 ToolDef<any>
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const defineTool = <A>(def: ToolDef<A>): ToolDef<any> => def;

export const tools = [
  defineTool<{ command: string }>({
    name: "bash",
    description: "Run a shell command and return its stdout and stderr.",
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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
    input_schema: {
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

// ---- 从注册表自动生成：给模型看的 TOOLS（Claude 的 tools 格式），和给循环用的 TOOL_HANDLERS ----
const toSchema = ({ name, description, input_schema }: ToolDef<unknown>): Anthropic.Tool => ({ name, description, input_schema });
export const TOOLS: Anthropic.Tool[] = tools.map(toSchema);
export const TOOL_HANDLERS = Object.fromEntries(tools.map((t) => [t.name, t.handler]));

/**
 * 工具集（s05 起使用）：基础工具 + 各章新增的工具，一起生成 schema 和执行函数。
 * s03 / s04 仍使用上面固定的 TOOLS / executeTool。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Toolset {
  defs: ToolDef<any>[];
  schemas: Anthropic.Tool[];
  execute: (name: string, args: Record<string, unknown>) => Promise<string>;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildToolset(extra: ToolDef<any>[] = []): Toolset {
  const defs = [...tools, ...extra];
  const handlers = Object.fromEntries(defs.map((t) => [t.name, t.handler]));
  return {
    defs,
    schemas: defs.map(toSchema),
    execute: async (name, args) => {
      const handler = handlers[name];
      if (!handler) return `Error: unknown tool "${name}"`;
      try {
        return (await handler(args)).slice(0, MAX_OUTPUT);
      } catch (err) {
        return `Error: ${(err as Error).message}`;
      }
    },
  };
}

/**
 * 检查模型给的工具参数。Claude 格式里 tool_use.input 已经是解析好的对象（OpenAI 格式是 JSON 字符串），
 * 这里只确认它确实是一个对象，失败时返回 Error 文本，交给调用方还给模型。
 */
export function validateInput(input: unknown): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: `Error: tool input must be a JSON object, got ${JSON.stringify(input)}` };
  }
  return { ok: true, args: input as Record<string, unknown> };
}

/** 执行一个已经检查过参数的工具调用。所有错误都变成 "Error: …" 文本 */
export function executeTool(name: string, args: Record<string, unknown>): string {
  const handler = TOOL_HANDLERS[name];
  if (!handler) return `Error: unknown tool "${name}"`;
  try {
    // s03 / s04 的同步版本：基础工具都是同步的
    const output = handler(args);
    if (typeof output !== "string") return `Error: tool "${name}" is async; use buildToolset().execute`;
    return output.slice(0, MAX_OUTPUT);
  } catch (err) {
    return `Error: ${(err as Error).message}`;
  }
}
