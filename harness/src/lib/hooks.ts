/**
 * Hook 注册表（s04）："挂在循环上，不写进循环里"
 *
 * 循环只在 4 个时机调用 run*()，具体做什么由注册进来的回调决定：
 *
 *   UserPromptSubmit  用户输入后、发给模型前   可以拦下输入，或补充上下文
 *   PreToolUse        工具执行前               可以阻止这次执行（权限检查就挂在这里）
 *   PostToolUse       工具执行后               可以改写输出（比如截断超长输出）
 *   Stop              模型说“做完了”、循环要退出前  可以让它继续干（比如“你还没跑测试”）
 *
 * 和教程的差异：
 *   - 两种注册方式：register(event, fn) 和教程一样一次挂一个；
 *     use(plugin) 一次挂一组，像 Vite / Rollup 插件，同一个插件的多个钩子可以共享状态
 *   - 回调可以是 async：权限检查要等用户在终端回答
 *   - 某个 hook 抛异常时只打印警告，不会把整个 agent 搞崩（Claude Code 称为 non_blocking_error）
 *   - Stop 钩子每轮最多强制续跑一次（Claude Code 的 stopHookActive），避免永远停不下来
 *   - UserPromptSubmit 真的能补充上下文，PostToolUse 真的能改写输出（教程只打印日志）
 */
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

type Awaitable<T> = T | Promise<T>;
type Args = Record<string, unknown>;

export interface HookEvents {
  UserPromptSubmit: {
    input: { prompt: string };
    result: { block: string } | { addContext: string } | void;
  };
  PreToolUse: {
    input: { tool: string; args: Args };
    result: { block: string } | void;
  };
  PostToolUse: {
    input: { tool: string; args: Args; output: string };
    result: { output: string } | void;
  };
  Stop: {
    input: { messages: ChatCompletionMessageParam[] };
    result: { continueWith: string } | void;
  };
}
export type HookEvent = keyof HookEvents;
export type HookFn<E extends HookEvent> = (input: HookEvents[E]["input"]) => Awaitable<HookEvents[E]["result"]>;

/** 插件：一个名字 + 若干钩子，钩子之间可以通过闭包共享状态 */
export type HookPlugin = { name: string } & { [E in HookEvent]?: HookFn<E> };

interface Entry<E extends HookEvent> {
  name: string;
  fn: HookFn<E>;
}

export class HookRegistry {
  private hooks: { [E in HookEvent]: Entry<E>[] } = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  constructor(private warn: (msg: string) => void = (m) => console.warn(m)) {}

  register<E extends HookEvent>(event: E, fn: HookFn<E>, name = fn.name || "anonymous") {
    (this.hooks[event] as Entry<E>[]).push({ name, fn });
    return this;
  }

  use(plugin: HookPlugin) {
    for (const event of Object.keys(this.hooks) as HookEvent[]) {
      const fn = plugin[event];
      // 这里的类型收窄 TypeScript 推不出来，用 never 绕过；上面的 HookPlugin 类型已经保证了正确性
      if (fn) this.register(event, fn as never, `${plugin.name}:${event}`);
    }
    return this;
  }

  /** 列出已注册的钩子，方便调试 */
  list(): Record<HookEvent, string[]> {
    const out = {} as Record<HookEvent, string[]>;
    for (const event of Object.keys(this.hooks) as HookEvent[]) out[event] = this.hooks[event].map((h) => h.name);
    return out;
  }

  /** 按注册顺序依次调用；回调抛异常时只警告，继续后面的回调 */
  private async call<E extends HookEvent>(event: E, entry: Entry<E>, input: HookEvents[E]["input"]) {
    try {
      return await entry.fn(input);
    } catch (err) {
      this.warn(`[hook] ${entry.name} 出错，已跳过：${(err as Error).message}`);
      return undefined;
    }
  }

  /** 任一回调 block → 拦下输入；所有 addContext 收集起来一起返回 */
  async runUserPromptSubmit(input: HookEvents["UserPromptSubmit"]["input"]) {
    const contexts: string[] = [];
    for (const h of this.hooks.UserPromptSubmit) {
      const r = await this.call("UserPromptSubmit", h, input);
      if (r && "block" in r) return { block: r.block, contexts };
      if (r && "addContext" in r) contexts.push(r.addContext);
    }
    return { block: undefined, contexts };
  }

  /** 第一个返回 block 的回调生效，后面的不再调用（短路） */
  async runPreToolUse(input: HookEvents["PreToolUse"]["input"]): Promise<string | undefined> {
    for (const h of this.hooks.PreToolUse) {
      const r = await this.call("PreToolUse", h, input);
      if (r && "block" in r) return r.block;
    }
    return undefined;
  }

  /** 像流水线一样传递：每个回调拿到的是上一个回调改写后的输出 */
  async runPostToolUse(input: HookEvents["PostToolUse"]["input"]): Promise<string> {
    let output = input.output;
    for (const h of this.hooks.PostToolUse) {
      const r = await this.call("PostToolUse", h, { ...input, output });
      if (r && "output" in r) output = r.output;
    }
    return output;
  }

  /** 第一个返回 continueWith 的回调生效 */
  async runStop(input: HookEvents["Stop"]["input"]): Promise<string | undefined> {
    for (const h of this.hooks.Stop) {
      const r = await this.call("Stop", h, input);
      if (r && "continueWith" in r) return r.continueWith;
    }
    return undefined;
  }
}
