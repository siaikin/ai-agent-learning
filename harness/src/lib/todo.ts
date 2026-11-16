/**
 * Todo 清单（s05）：给 agent 一个“先列计划再动手”的工具
 *
 * 设计要点：
 *   - 整表覆盖：模型每次调用 todo_write 都提交完整清单，而不是“新增一条 / 删除一条”。
 *     对模型来说更简单（不用记 id、不会增删错位），对 harness 来说更好校验（拿到的就是最终状态）。
 *     Claude Code 的 TodoWrite 也是整表覆盖。
 *   - 同一时间最多一项 in_progress：逼模型一次只专注做一件事，也让你一眼看出它在干什么。
 *   - 校验失败就返回 Error 文本、不修改清单，模型看到错误会自己改正后重新提交。
 */
import { defineTool } from "./tools.js";

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

export const MAX_TODOS = 20;
const STATUSES: TodoStatus[] = ["pending", "in_progress", "completed"];
const MARK: Record<TodoStatus, string> = { pending: "[ ]", in_progress: "[>]", completed: "[x]" };

export class TodoList {
  items: TodoItem[] = [];

  /** 校验并整表替换。返回 null 表示成功，否则返回错误原因（清单保持不变） */
  replace(input: unknown): string | null {
    if (!Array.isArray(input)) return "todos must be an array";
    if (input.length > MAX_TODOS) return `too many todos (${input.length}); keep at most ${MAX_TODOS}`;
    const next: TodoItem[] = [];
    const ids = new Set<string>();
    for (const [i, raw] of input.entries()) {
      const t = raw as Partial<TodoItem>;
      const id = String(t?.id ?? "").trim();
      const content = String(t?.content ?? "").trim();
      if (!id) return `todo #${i + 1} is missing an id`;
      if (ids.has(id)) return `duplicate todo id "${id}"`;
      if (!content) return `todo "${id}" has empty content`;
      if (!STATUSES.includes(t.status as TodoStatus)) return `todo "${id}" has invalid status "${t.status}"; use ${STATUSES.join(" / ")}`;
      ids.add(id);
      next.push({ id, content, status: t.status as TodoStatus });
    }
    const doing = next.filter((t) => t.status === "in_progress");
    if (doing.length > 1) return `only one todo can be in_progress at a time (got ${doing.map((t) => t.id).join(", ")})`;
    this.items = next;
    return null;
  }

  get unfinished() {
    return this.items.filter((t) => t.status !== "completed");
  }

  render(): string {
    if (this.items.length === 0) return "(no todos)";
    const done = this.items.length - this.unfinished.length;
    const lines = this.items.map((t) => `${MARK[t.status]} ${t.id}. ${t.content}`);
    return `${lines.join("\n")}\n(${done}/${this.items.length} completed)`;
  }
}

/** todo_write 工具：模型通过它提交整张清单 */
export function todoTool(list: TodoList, onChange?: (list: TodoList) => void) {
  return defineTool<{ todos: unknown }>({
    name: "todo_write",
    description:
      "Create or update your task list. Always send the COMPLETE list (it replaces the previous one). " +
      "Use it for tasks with 3 or more steps. Keep exactly one item in_progress while working, " +
      "and mark items completed as soon as they are done.",
    parameters: {
      type: "object",
      properties: {
        todos: {
          type: "array",
          maxItems: MAX_TODOS,
          items: {
            type: "object",
            properties: {
              id: { type: "string", description: "Short stable id, e.g. \"1\"" },
              content: { type: "string", description: "What to do, in imperative form" },
              status: { type: "string", enum: STATUSES },
            },
            required: ["id", "content", "status"],
          },
        },
      },
      required: ["todos"],
    },
    handler: ({ todos }) => {
      const error = list.replace(todos);
      if (error) return `Error: ${error}. The todo list was not changed.`;
      onChange?.(list);
      return list.render();
    },
  });
}
