/**
 * 权限检查（s03）：每个工具调用在执行前都要经过三道闸门，顺序固定
 *
 *   闸门 1 拒绝列表：永远禁止的操作 → deny，不执行，也不问用户
 *   闸门 2 询问规则：要看情况的操作 → ask，交给闸门 3 由用户决定
 *   闸门 3 用户审批：在 s03-permission.ts 里实现（这里只返回 "ask"）
 *   都没命中 → allow，直接执行。大部分日常操作走这条路。
 *
 * 和教程的差异：
 *   - 用正则代替字符串包含。教程的 "sudo" in command 会误伤 "pseudo"，这里用 \b 单词边界
 *   - 多了一类规则：读取 .env 等敏感文件也要询问。读到的内容会被发给模型服务商，这本身就是一种泄露
 *   - 支持「本会话内同类操作都允许」：对应 Claude Code 8 个规则来源中的 session 来源
 *
 * ⚠️ 正则匹配命令字符串不是可靠的安全边界：变量展开、别名、base64 解码后再执行等写法都能绕过。
 * 它能挡住模型的“手滑”，挡不住刻意绕过。真正的隔离要靠容器、沙箱或 s18 的 worktree。
 */

export type Decision =
  | { behavior: "allow" }
  | { behavior: "deny"; reason: string }
  | { behavior: "ask"; reason: string; ruleId: string };

type Args = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

// ---- 闸门 1：拒绝列表（只针对 bash） ----
export const DENY_RULES: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bsudo\b/, reason: "sudo is not allowed" },
  { pattern: /\brm\s+(-\S+\s+)*(\/|~|\$HOME)(\*|\/\*?)?(\s|$)/, reason: "Deleting the root or home directory" },
  { pattern: /\b(shutdown|reboot|halt|poweroff)\b/, reason: "Shutting down the machine" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "Formatting a disk" },
  { pattern: /\bdd\b.*\bof=\/dev\//, reason: "Writing directly to a device" },
  { pattern: />\s*\/dev\/(sd|nvme|disk|hd)/, reason: "Writing directly to a device" },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: "Fork bomb" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/, reason: "Piping a download straight into a shell" },
];

// ---- 闸门 2：询问规则 ----
interface AskRule {
  id: string;
  tools: string[];
  check: (args: Args) => boolean;
  reason: string;
}

const SECRET_PATH = /(^|\/)\.env(\.[\w-]+)?$|(^|\/)\.ssh\/|(^|\/)id_(rsa|ed25519)|\.pem$/;
const SECRET_IN_CMD = /(^|[\s/'"])\.env\b|\.ssh\/|id_(rsa|ed25519)|\.pem\b/;

export const ASK_RULES: AskRule[] = [
  {
    id: "bash-destructive",
    tools: ["bash"],
    check: (a) =>
      /\b(rm|rmdir|mv|chmod|chown|truncate|shred)\b/.test(str(a.command)) ||
      /\bgit\s+(push|reset\s+--hard|clean|checkout\s+--|branch\s+-D|rebase)\b/.test(str(a.command)),
    reason: "May delete or overwrite files, or rewrite git history",
  },
  {
    id: "bash-network",
    tools: ["bash"],
    check: (a) => /\b(curl|wget|ssh|scp|rsync|nc)\b|\bnpm\s+publish\b/.test(str(a.command)),
    reason: "Network access",
  },
  {
    id: "secret-read",
    tools: ["read_file", "bash"],
    check: (a) => SECRET_PATH.test(str(a.path)) || SECRET_IN_CMD.test(str(a.command)),
    reason: "Touches a secret file; its content would be sent to the model provider",
  },
  {
    id: "secret-write",
    tools: ["write_file", "edit_file"],
    check: (a) => SECRET_PATH.test(str(a.path)) || /(^|\/)\.git\//.test(str(a.path)),
    reason: "Modifies a secret file or git internals",
  },
];

/** 本会话内用户选了「同类都允许」的规则 id */
export type SessionAllow = Set<string>;

export function checkPermission(tool: string, args: Args, sessionAllow: SessionAllow = new Set()): Decision {
  // 闸门 1：硬拒绝优先，用户也不能放行
  if (tool === "bash") {
    const command = str(args.command);
    const hit = DENY_RULES.find((r) => r.pattern.test(command));
    if (hit) return { behavior: "deny", reason: hit.reason };
  }
  // 闸门 2：命中询问规则 → 交给用户（除非本会话已经放行过这类操作）
  for (const rule of ASK_RULES) {
    if (rule.tools.includes(tool) && rule.check(args) && !sessionAllow.has(rule.id)) {
      return { behavior: "ask", reason: rule.reason, ruleId: rule.id };
    }
  }
  // 都没命中 → 放行
  return { behavior: "allow" };
}
