/**
 * 子 agent（s06）："大任务拆小，每个小任务一个干净的上下文"
 *
 * task 工具被调用时：
 *   1. 新建一个只有任务描述的 messages[]（不继承主 agent 的任何对话）
 *   2. 用同一个 runAgentLoop 跑子 agent 自己的循环，换一套工具、一个 system prompt、一组插件
 *   3. 只把子 agent 最后的文字结论作为 task 工具的结果交回主 agent；中间过程全部丢弃
 *
 * 三条规则：
 *   - 子 agent 的工具里没有 task：不能再派生子 agent（防止无限递归）
 *   - 子 agent 的工具调用照样经过权限插件：上下文隔离 ≠ 权限隔离
 *   - 子 agent 最多跑 maxTurns 轮：防止停不下来
 *
 * 文件系统的副作用（写文件、跑命令）会保留，被丢弃的只是对话上下文。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { startActiveObservation } from "@langfuse/tracing";

import { runAgentLoop } from "./agent.js";
import type { HookRegistry } from "./hooks.js";
import { WORKDIR, defineTool, type Toolset } from "./tools.js";

export const SUB_SYSTEM = `You are a subagent running in ${WORKDIR} on ${process.platform}.
You were given one self-contained task by a parent agent. Complete it directly with your tools; do not delegate.
The parent only sees your final message, not your tool calls, so end with a concise summary:
what you found or changed (with file paths), and anything the parent needs to know to continue.`;

export interface SubagentOptions {
  client: Anthropic;
  model: string;
  maxTokens: number;
  /** 子 agent 能用的工具：通常是基础工具，不能包含 task 本身 */
  toolset: Toolset;
  /** 子 agent 的插件：至少要有权限插件 */
  hooks: HookRegistry;
  maxTurns?: number;
  log?: (line: string) => void;
}

export interface SubagentStats {
  messages: number;
  toolCalls: number;
  resultChars: number;
}

/** 跑一个子 agent，返回它的最终结论和一些统计（统计用来让你看清隔离省掉了多少上下文） */
export async function runSubagent(description: string, opts: SubagentOptions): Promise<{ result: string; stats: SubagentStats }> {
  if (opts.toolset.defs.some((t) => t.name === "task")) {
    throw new Error("subagent toolset must not include the task tool (no recursive subagents)");
  }
  const log = opts.log ?? console.log;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: description }]; // 全新的 messages[]

  const result = await startActiveObservation(
    "subagent",
    async (span) => {
      span.update({ input: description });
      const text = await runAgentLoop(messages, {
        client: opts.client,
        model: opts.model,
        system: SUB_SYSTEM,
        maxTokens: opts.maxTokens,
        toolset: opts.toolset,
        hooks: opts.hooks,
        maxTurns: opts.maxTurns ?? 30,
        log: (line) => log(`    \x1b[35m[sub]\x1b[0m ${line}`),
      });
      span.update({ output: text });
      return text;
    },
    { asType: "agent" },
  );

  const toolCalls = messages
    .filter((m) => m.role === "assistant" && Array.isArray(m.content))
    .reduce((n, m) => n + (m.content as Anthropic.ContentBlockParam[]).filter((b) => b.type === "tool_use").length, 0);
  return {
    result: result || "(subagent finished without a summary)",
    stats: { messages: messages.length, toolCalls, resultChars: result.length },
  };
}

/** task 工具：主 agent 通过它把一个子任务交给子 agent */
export function taskTool(opts: SubagentOptions) {
  const log = opts.log ?? console.log;
  return defineTool<{ description: string }>({
    name: "task",
    description:
      "Launch a subagent with a fresh, empty context to handle one self-contained subtask " +
      "(e.g. exploring many files, researching a question, or making an isolated change). " +
      "The subagent knows nothing about this conversation, so the description must include everything it needs. " +
      "Returns only the subagent's final summary.",
    input_schema: {
      type: "object",
      properties: {
        description: { type: "string", description: "Complete, self-contained instructions for the subagent" },
      },
      required: ["description"],
    },
    handler: async ({ description }) => {
      log(`\x1b[35m┌ 子 agent 启动\x1b[0m \x1b[2m${description.slice(0, 120)}\x1b[0m`);
      const { result, stats } = await runSubagent(description, opts);
      log(
        `\x1b[35m└ 子 agent 完成\x1b[0m：内部 ${stats.messages} 条消息、${stats.toolCalls} 次工具调用 → 只交回 ${stats.resultChars} 个字符`,
      );
      return result;
    },
  });
}
