/**
 * 闸门 3「问用户」的接口和终端实现（来自 s03）。
 * agentLoop / hook 只依赖 AskUser 这个类型；以后做 Web 界面时换一个实现即可。
 */
import type { Interface } from "node:readline/promises";

export interface AskRequest {
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}
export type AskAnswer = { allow: true; always: boolean } | { allow: false; feedback?: string };
export type AskUser = (req: AskRequest) => Promise<AskAnswer>;

export function terminalAsk(rl: Interface): AskUser {
  return async ({ tool, args, reason }) => {
    console.log(`\n\x1b[33m⚠  需要你确认：${reason}\x1b[0m`);
    console.log(`   ${tool} ${JSON.stringify(args).slice(0, 300)}`);
    const choice = (await rl.question("   [y] 允许一次  [a] 本会话同类操作都允许  [n] 拒绝（默认）> "))
      .trim()
      .toLowerCase();
    if (choice === "y" || choice === "yes") return { allow: true, always: false };
    if (choice === "a") return { allow: true, always: true };
    const feedback = (await rl.question("   （可选）告诉模型为什么拒绝、或者该怎么做，回车跳过 > ")).trim();
    return { allow: false, feedback: feedback || undefined };
  };
}
