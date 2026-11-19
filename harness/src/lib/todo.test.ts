import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_TODOS, TodoList, todoTool } from "./todo.js";

const item = (id: string, status = "pending", content = `task ${id}`) => ({ id, content, status });

test("整表覆盖：第二次提交完全替换第一次", () => {
  const list = new TodoList();
  assert.equal(list.replace([item("1"), item("2")]), null);
  assert.equal(list.replace([item("1", "completed"), item("3", "in_progress")]), null);
  assert.deepEqual(list.items.map((t) => `${t.id}:${t.status}`), ["1:completed", "3:in_progress"]);
});

test("最多一项 in_progress", () => {
  const list = new TodoList();
  list.replace([item("1")]);
  const err = list.replace([item("1", "in_progress"), item("2", "in_progress")]);
  assert.match(err!, /only one todo can be in_progress/);
  assert.deepEqual(list.items, [item("1")], "校验失败时清单保持不变");
});

test("各种不合法输入都会被拒绝", () => {
  const list = new TodoList();
  assert.match(list.replace("not an array")!, /must be an array/);
  assert.match(list.replace([{ content: "x", status: "pending" }])!, /missing an id/);
  assert.match(list.replace([item("1"), item("1")])!, /duplicate/);
  assert.match(list.replace([item("1", "pending", "  ")])!, /empty content/);
  assert.match(list.replace([item("1", "done")])!, /invalid status/);
  assert.match(list.replace(Array.from({ length: MAX_TODOS + 1 }, (_, i) => item(String(i))))!, /too many/);
});

test("render 显示勾选状态和进度", () => {
  const list = new TodoList();
  list.replace([item("1", "completed", "读代码"), item("2", "in_progress", "写测试"), item("3", "pending", "跑测试")]);
  assert.equal(list.render(), "[x] 1. 读代码\n[>] 2. 写测试\n[ ] 3. 跑测试\n(1/3 completed)");
  assert.equal(list.unfinished.length, 2);
});

test("todo_write 工具：成功返回清单，失败返回 Error 且不触发 onChange", async () => {
  const list = new TodoList();
  let changes = 0;
  const tool = todoTool(list, () => changes++);
  assert.match(await tool.handler({ todos: [item("1", "in_progress")] }), /\[>\] 1\. task 1/);
  assert.equal(changes, 1);
  assert.match(await tool.handler({ todos: [item("1", "bogus")] }), /^Error: .*not changed/);
  assert.equal(changes, 1);
});
