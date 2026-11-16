/**
 * 共用的 hook 插件（来自 s04）。s04 文件保留原样作为快照，s05 起从这里导入。
 */
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

import type { AskUser } from "./ask.js";
import type { HookPlugin } from "./hooks.js";
import { checkPermission, type SessionAllow } from "./permission.js";
import { WORKDIR } from "./tools.js";

const dim = (s: string) => console.log(`\x1b[90m${s}\x1b[0m`);

/** PreToolUse：把每次工具调用（包括后面被拒绝的）写进审计日志 */
export function auditPlugin(file = path.join(WORKDIR, ".harness", "audit.jsonl")): HookPlugin {
  return {
    name: "audit",
    PreToolUse: ({ tool, args }) => {
      mkdirSync(path.dirname(file), { recursive: true });
      appendFileSync(file, JSON.stringify({ time: new Date().toISOString(), tool, args }) + "\n");
    },
  };
}

/** PreToolUse：s03 的权限检查 */
export function permissionPlugin(askUser: AskUser, sessionAllow: SessionAllow): HookPlugin {
  return {
    name: "permission",
    PreToolUse: async ({ tool, args }) => {
      const decision = checkPermission(tool, args, sessionAllow);
      if (decision.behavior === "deny") {
        console.log(`\x1b[31m⛔ 已拦截：${decision.reason}\x1b[0m`);
        return { block: `Permission denied by policy: ${decision.reason}. This action is never allowed; do not retry it.` };
      }
      if (decision.behavior === "ask") {
        const answer = await askUser({ tool, args, reason: decision.reason });
        if (!answer.allow) {
          dim("✕ 你拒绝了这次调用");
          return {
            block:
              "Permission denied by the user." +
              (answer.feedback ? ` User says: ${answer.feedback}` : "") +
              " Do not retry the same action; choose another approach or ask the user.",
          };
        }
        if (answer.always) sessionAllow.add(decision.ruleId);
      }
    },
  };
}
