import assert from "node:assert/strict";
import { test } from "node:test";

import { HookRegistry } from "./hooks.js";

const silent = () => {};

test("按注册顺序执行，PreToolUse 第一个 block 短路后面的回调", async () => {
  const calls: string[] = [];
  const hooks = new HookRegistry(silent)
    .register("PreToolUse", () => void calls.push("a"))
    .register("PreToolUse", () => (calls.push("b"), { block: "no" }))
    .register("PreToolUse", () => void calls.push("c"));
  assert.equal(await hooks.runPreToolUse({ tool: "bash", args: {} }), "no");
  assert.deepEqual(calls, ["a", "b"]);
});

test("PostToolUse 像流水线：每个回调拿到上一个改写后的输出", async () => {
  const hooks = new HookRegistry(silent)
    .register("PostToolUse", ({ output }) => ({ output: output + "1" }))
    .register("PostToolUse", () => undefined)
    .register("PostToolUse", ({ output }) => ({ output: output + "2" }));
  assert.equal(await hooks.runPostToolUse({ tool: "x", args: {}, output: "o" }), "o12");
});

test("UserPromptSubmit 收集所有 addContext，block 时停止", async () => {
  const hooks = new HookRegistry(silent)
    .register("UserPromptSubmit", () => ({ addContext: "A" }))
    .register("UserPromptSubmit", () => ({ addContext: "B" }));
  assert.deepEqual(await hooks.runUserPromptSubmit({ prompt: "hi" }), { block: undefined, contexts: ["A", "B"] });

  hooks.register("UserPromptSubmit", ({ prompt }) => (prompt.includes("password") ? { block: "contains secret" } : undefined));
  const r = await hooks.runUserPromptSubmit({ prompt: "my password is 123" });
  assert.equal(r.block, "contains secret");
});

test("回调抛异常只警告，不影响后面的回调", async () => {
  const warnings: string[] = [];
  const hooks = new HookRegistry((m) => warnings.push(m))
    .register("PreToolUse", function broken() {
      throw new Error("boom");
    })
    .register("PreToolUse", () => ({ block: "still runs" }));
  assert.equal(await hooks.runPreToolUse({ tool: "bash", args: {} }), "still runs");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /broken.*boom/);
});

test("async 回调会被等待", async () => {
  const hooks = new HookRegistry(silent).register("PreToolUse", async () => {
    await new Promise((r) => setTimeout(r, 10));
    return { block: "after wait" };
  });
  assert.equal(await hooks.runPreToolUse({ tool: "bash", args: {} }), "after wait");
});

test("use(plugin) 把插件的每个钩子都注册上，并共享状态", async () => {
  let count = 0;
  const hooks = new HookRegistry(silent).use({
    name: "counter",
    PostToolUse: () => void count++,
    Stop: () => (count > 1 ? { continueWith: `ran ${count} tools` } : undefined),
  });
  assert.deepEqual(hooks.list(), {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: ["counter:PostToolUse"],
    Stop: ["counter:Stop"],
  });
  await hooks.runPostToolUse({ tool: "a", args: {}, output: "" });
  assert.equal(await hooks.runStop({ messages: [] }), undefined);
  await hooks.runPostToolUse({ tool: "b", args: {}, output: "" });
  assert.equal(await hooks.runStop({ messages: [] }), "ran 2 tools");
});
