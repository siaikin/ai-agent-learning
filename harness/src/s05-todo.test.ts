import assert from "node:assert/strict";
import { test } from "node:test";

import { HookRegistry } from "./lib/hooks.js";
import { TodoList } from "./lib/todo.js";
import { todoPlugin } from "./s05-todo.js";

const silent = () => {};
const post = (hooks: HookRegistry, tool: string, output = "ok") => hooks.runPostToolUse({ tool, args: {}, output });

function setup(remindAfter = 3) {
  const list = new TodoList();
  const hooks = new HookRegistry(silent).use(todoPlugin(list, remindAfter));
  return { list, hooks };
}

test("有未完成项时，连续 N 次工具调用没更新清单就追加提醒，然后重新计数", async () => {
  const { list, hooks } = setup(3);
  list.replace([{ id: "1", content: "a", status: "in_progress" }]);
  assert.equal(await post(hooks, "bash"), "ok");
  assert.equal(await post(hooks, "bash"), "ok");
  assert.match(await post(hooks, "bash"), /^ok\n\n<reminder>You have made 3 tool calls/);
  assert.equal(await post(hooks, "bash"), "ok", "提醒后重新计数");
});

test("调用 todo_write 会把计数清零", async () => {
  const { list, hooks } = setup(3);
  list.replace([{ id: "1", content: "a", status: "pending" }]);
  await post(hooks, "bash");
  await post(hooks, "bash");
  await post(hooks, "todo_write");
  assert.equal(await post(hooks, "bash"), "ok");
  assert.equal(await post(hooks, "bash"), "ok");
});

test("清单为空或全部完成时不提醒", async () => {
  const { list, hooks } = setup(2);
  await post(hooks, "bash");
  assert.equal(await post(hooks, "bash"), "ok");
  list.replace([{ id: "1", content: "a", status: "completed" }]);
  await post(hooks, "bash");
  assert.equal(await post(hooks, "bash"), "ok");
});

test("Stop：有未完成项就要求继续，全部完成就放行", async () => {
  const { list, hooks } = setup();
  assert.equal(await hooks.runStop({ messages: [] }), undefined, "没有清单时放行");
  list.replace([
    { id: "1", content: "a", status: "completed" },
    { id: "2", content: "b", status: "in_progress" },
  ]);
  assert.match((await hooks.runStop({ messages: [] }))!, /unfinished items:\n\[x\] 1\. a\n\[>\] 2\. b/);
  list.replace([
    { id: "1", content: "a", status: "completed" },
    { id: "2", content: "b", status: "completed" },
  ]);
  assert.equal(await hooks.runStop({ messages: [] }), undefined);
});
