import assert from "node:assert/strict";
import { test } from "node:test";
import type Anthropic from "@anthropic-ai/sdk";

import { HookRegistry } from "./hooks.js";
import { runSubagent, taskTool } from "./subagent.js";
import { buildToolset } from "./tools.js";

type Step = { tools?: { name: string; input: Record<string, unknown> }[]; text?: string };

/** 按脚本回复的假客户端，同时记录每次收到的请求，方便检查子 agent 看到了什么 */
function fakeClient(script: Step[]) {
  const requests: { system: unknown; messages: Anthropic.MessageParam[]; tools: string[] }[] = [];
  let i = 0;
  const client = {
    messages: {
      create: async (body: { system: unknown; messages: Anthropic.MessageParam[]; tools: Anthropic.Tool[] }) => {
        requests.push({ system: body.system, messages: structuredClone(body.messages), tools: body.tools.map((t) => t.name) });
        const step = script[i++] ?? { text: "(script exhausted)" };
        const content = step.tools
          ? step.tools.map((t, j) => ({ type: "tool_use", id: `t${i}_${j}`, name: t.name, input: t.input }))
          : [{ type: "text", text: step.text }];
        return {
          id: `m${i}`, type: "message", role: "assistant", model: "fake", content,
          stop_reason: step.tools ? "tool_use" : "end_turn", stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      },
    },
  } as unknown as Anthropic;
  return { client, requests };
}

const quiet = () => {};
const opts = (client: Anthropic, extra: object = {}) => ({
  client, model: "fake", maxTokens: 100, toolset: buildToolset(), hooks: new HookRegistry(quiet), log: quiet, ...extra,
});

test("子 agent 从全新的 messages[] 开始，只看到任务描述", async () => {
  const { client, requests } = fakeClient([{ text: "done" }]);
  await runSubagent("find the test framework", opts(client));
  assert.deepEqual(requests[0]!.messages, [{ role: "user", content: "find the test framework" }]);
  assert.match(String(requests[0]!.system), /subagent/);
});

test("只交回最后的结论，中间的工具调用不出现在结果里，并给出统计", async () => {
  const { client } = fakeClient([
    { tools: [{ name: "glob", input: { pattern: "*.nothing" } }] },
    { tools: [{ name: "bash", input: { command: "echo intermediate-output" } }] },
    { text: "Framework: node:test" },
  ]);
  const { result, stats } = await runSubagent("task", opts(client));
  assert.equal(result, "Framework: node:test");
  assert.doesNotMatch(result, /intermediate-output/);
  assert.deepEqual(stats, { messages: 6, toolCalls: 2, resultChars: 20 });
});

test("子 agent 的工具里不能有 task（禁止递归）", async () => {
  const { client } = fakeClient([]);
  const withTask = buildToolset([taskTool(opts(client))]);
  await assert.rejects(runSubagent("x", opts(client, { toolset: withTask })), /no recursive subagents/);
});

test("子 agent 的工具调用照样经过 PreToolUse 钩子（权限不因隔离而跳过）", async () => {
  const { client, requests } = fakeClient([{ tools: [{ name: "bash", input: { command: "sudo ls" } }] }, { text: "blocked" }]);
  const hooks = new HookRegistry(quiet).register("PreToolUse", ({ args }) =>
    String(args.command).includes("sudo") ? { block: "denied by policy" } : undefined,
  );
  await runSubagent("x", opts(client, { hooks }));
  const toolResult = (requests[1]!.messages[2]!.content as Anthropic.ToolResultBlockParam[])[0]!;
  assert.equal(toolResult.content, "denied by policy");
  assert.equal(toolResult.is_error, true);
});

test("达到 maxTurns 就停下，结果里说明原因", async () => {
  const loop = Array.from({ length: 10 }, () => ({ tools: [{ name: "glob", input: { pattern: "*.x" } }] }));
  const { client, requests } = fakeClient(loop);
  const { result } = await runSubagent("x", opts(client, { maxTurns: 3 }));
  assert.equal(requests.length, 3);
  assert.match(result, /stopped after 3 turns/);
});

test("task 工具：主 agent 拿到的只是子 agent 的结论", async () => {
  const { client } = fakeClient([{ tools: [{ name: "bash", input: { command: "echo lots of detail" } }] }, { text: "summary only" }]);
  const tool = taskTool(opts(client));
  assert.equal(await tool.handler({ description: "do it" }), "summary only");
});
