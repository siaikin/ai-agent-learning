/**
 * 共用的 agent 循环（s05 起使用），Claude（Anthropic Messages API）格式
 *
 * 就是 s04 的循环，只是把“用哪个模型、哪套工具、哪些 hook”都改成参数传进来，
 * 这样后面的章节只需要组装自己的工具和插件，不用再复制一遍循环。
 *
 * Claude 格式的要点：
 *   - system prompt 是单独的 system 参数，不在 messages 里
 *   - 模型的回复是内容块数组：text 块、tool_use 块（input 已经是对象）
 *   - 工具结果放在下一条 role: "user" 消息里，每个结果是一个 tool_result 块；
 *     同一轮的所有结果要放进同一条 user 消息，失败的结果标 is_error: true
 *
 * 可观测性（没有启用 telemetry 时都是空操作）：
 *   - 每次调用模型记成一个 Langfuse generation：模型、完整输入输出、token 用量
 *   - 每次工具调用记成一个 tool observation：参数、输出、是否被拦截
 *   - Stop 钩子要求继续时记一个 event
 */
import type Anthropic from "@anthropic-ai/sdk";
import { startActiveObservation, startObservation } from "@langfuse/tracing";

import type { HookRegistry } from "./hooks.js";
import { validateInput, type Toolset } from "./tools.js";

export interface AgentOptions {
  client: Anthropic;
  model: string;
  system: string;
  maxTokens: number;
  toolset: Toolset;
  hooks: HookRegistry;
  /** 打印工具调用和输出；测试时可以传一个空函数 */
  log?: (line: string) => void;
}

const textOf = (content: Anthropic.ContentBlock[]) =>
  content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n");

/** 调用一次模型，并把这次调用记成 Langfuse generation */
function callModel(messages: Anthropic.MessageParam[], opts: AgentOptions) {
  const { client, model, system, maxTokens, toolset } = opts;
  return startActiveObservation(
    "anthropic.messages.create",
    async (generation) => {
      generation.update({ model, input: { system, messages }, modelParameters: { max_tokens: maxTokens } });
      const response = await client.messages.create({ model, max_tokens: maxTokens, system, messages, tools: toolset.schemas });
      const u = response.usage;
      generation.update({
        output: response.content,
        usageDetails: {
          input: u.input_tokens,
          output: u.output_tokens,
          ...(u.cache_read_input_tokens ? { cache_read_input_tokens: u.cache_read_input_tokens } : {}),
          ...(u.cache_creation_input_tokens ? { cache_creation_input_tokens: u.cache_creation_input_tokens } : {}),
        },
        metadata: { stop_reason: response.stop_reason, message_id: response.id },
        ...(response.stop_reason === "max_tokens" || response.stop_reason === "refusal"
          ? { level: "WARNING" as const, statusMessage: `stop_reason: ${response.stop_reason}` }
          : {}),
      });
      return response;
    },
    { asType: "generation" },
  );
}

/** 执行一个 tool_use 块：检查参数 → PreToolUse → 执行 → PostToolUse，并记成 Langfuse tool observation */
function runToolUse(block: Anthropic.ToolUseBlock, opts: AgentOptions): Promise<Anthropic.ToolResultBlockParam> {
  const { toolset, hooks, log = console.log } = opts;
  const result = (content: string, isError = false): Anthropic.ToolResultBlockParam => ({
    type: "tool_result",
    tool_use_id: block.id,
    content,
    ...(isError ? { is_error: true } : {}),
  });

  return startActiveObservation(
    `tool:${block.name}`,
    async (span) => {
      span.update({ input: block.input, metadata: { toolUseId: block.id } });
      const checked = validateInput(block.input);
      if (!checked.ok) {
        span.update({ output: checked.error, level: "ERROR", statusMessage: "invalid input" });
        return result(checked.error, true);
      }
      const blocked = await hooks.runPreToolUse({ tool: block.name, args: checked.args });
      if (blocked) {
        span.update({ output: blocked, level: "WARNING", statusMessage: "blocked by PreToolUse hook" });
        return result(blocked, true);
      }
      const raw = toolset.execute(block.name, checked.args);
      const output = await hooks.runPostToolUse({ tool: block.name, args: checked.args, output: raw });
      const isError = output.startsWith("Error");
      span.update({
        output,
        ...(isError ? { level: "ERROR" as const, statusMessage: output.slice(0, 200) } : {}),
        ...(output !== raw ? { metadata: { toolUseId: block.id, modifiedByPostToolUse: true } } : {}),
      });
      // todo_write 成功时由它自己画清单，这里不重复打印；出错时照常打印，让你看到
      if (block.name !== "todo_write" || isError) log(output.slice(0, 500));
      return result(output, isError);
    },
    { asType: "tool" },
  );
}

export async function runAgentLoop(messages: Anthropic.MessageParam[], opts: AgentOptions) {
  const { hooks, log = console.log } = opts;
  let stopHookActive = false;
  while (true) {
    const response = await callModel(messages, opts);
    // 把完整的内容块数组（不只是文字）追加进历史
    messages.push({ role: "assistant", content: response.content });

    // 和 Claude Code 一样直接看内容里有没有 tool_use 块，而不是只依赖 stop_reason
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");

    if (toolUses.length === 0) {
      if (response.stop_reason === "pause_turn") continue; // 服务端暂停了这一轮，原样再发一次即可继续
      if (response.stop_reason === "max_tokens") log("\x1b[33m⚠ 回复达到 max_tokens 上限被截断，可以调大 LLM_MAX_TOKENS\x1b[0m");
      if (response.stop_reason === "refusal") return textOf(response.content) || "（模型拒绝了这个请求）";

      if (!stopHookActive) {
        const continueWith = await hooks.runStop({ messages });
        if (continueWith) {
          stopHookActive = true;
          startObservation("stop-hook", { input: textOf(response.content), output: continueWith, level: "WARNING" }, { asType: "event" });
          messages.push({ role: "user", content: continueWith });
          continue;
        }
      }
      return textOf(response.content);
    }

    // 按顺序执行这一轮的所有工具调用，结果放进同一条 user 消息
    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      log(`\x1b[33m▶ ${block.name}\x1b[0m \x1b[2m${JSON.stringify(block.input).slice(0, 200)}\x1b[0m`);
      results.push(await runToolUse(block, opts));
    }
    messages.push({ role: "user", content: results });
  }
}
