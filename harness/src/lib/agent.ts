/**
 * 共用的 agent 循环（s05 起使用）
 *
 * 就是 s04 的循环，只是把“用哪个模型、哪套工具、哪些 hook”都改成参数传进来，
 * 这样后面的章节只需要组装自己的工具和插件，不用再复制一遍循环。
 *
 * 可观测性：每次工具调用都包在一个 Langfuse "tool" observation 里（参数、输出、是否被拦截），
 * Stop 钩子要求继续时记一个 event。没有启用 telemetry 时，这些调用都是空操作。
 * LLM 调用本身由 telemetry.wrapClient() 包装过的客户端自动记录。
 */
import { startActiveObservation, startObservation } from "@langfuse/tracing";
import type OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

import type { HookRegistry } from "./hooks.js";
import { parseArgs, type Toolset } from "./tools.js";

export interface AgentOptions {
  client: OpenAI;
  model: string;
  toolset: Toolset;
  hooks: HookRegistry;
  /** 打印工具调用和输出；测试时可以传一个空函数 */
  log?: (line: string) => void;
}

export async function runAgentLoop(messages: ChatCompletionMessageParam[], opts: AgentOptions) {
  const { client, model, toolset, hooks, log = console.log } = opts;
  let stopHookActive = false;
  while (true) {
    const response = await client.chat.completions.create({ model, messages, tools: toolset.schemas });
    const message = response.choices[0]?.message;
    if (!message) throw new Error("模型没有返回内容");
    messages.push(message);

    const toolCalls = message.tool_calls ?? [];
    if (toolCalls.length === 0) {
      if (!stopHookActive) {
        const continueWith = await hooks.runStop({ messages });
        if (continueWith) {
          stopHookActive = true;
          startObservation("stop-hook", { input: message.content ?? "", output: continueWith, level: "WARNING" }, { asType: "event" });
          messages.push({ role: "user", content: continueWith });
          continue;
        }
      }
      return message.content ?? "";
    }

    for (const call of toolCalls) {
      if (call.type !== "function") continue;
      const { name, arguments: rawArgs } = call.function;
      log(`\x1b[33m▶ ${name}\x1b[0m \x1b[2m${rawArgs.slice(0, 200)}\x1b[0m`);

      const content = await startActiveObservation(
        `tool:${name}`,
        async (span) => {
          span.update({ input: rawArgs, metadata: { toolCallId: call.id } });
          const parsed = parseArgs(rawArgs);
          if (!parsed.ok) {
            span.update({ output: parsed.error, level: "ERROR", statusMessage: "invalid arguments" });
            return parsed.error;
          }
          span.update({ input: parsed.args });

          const blocked = await hooks.runPreToolUse({ tool: name, args: parsed.args });
          if (blocked) {
            span.update({ output: blocked, level: "WARNING", statusMessage: "blocked by PreToolUse hook" });
            return blocked;
          }
          const raw = toolset.execute(name, parsed.args);
          const output = await hooks.runPostToolUse({ tool: name, args: parsed.args, output: raw });
          span.update({
            output,
            ...(output.startsWith("Error") ? { level: "ERROR" as const, statusMessage: output.slice(0, 200) } : {}),
            ...(output !== raw ? { metadata: { toolCallId: call.id, modifiedByPostToolUse: true } } : {}),
          });
          // todo_write 成功时由它自己画清单，这里不重复打印；出错时照常打印，让你看到
          if (name !== "todo_write" || output.startsWith("Error")) log(output.slice(0, 500));
          return output;
        },
        { asType: "tool" },
      );
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
  }
}
