/**
 * 可观测性：把 agent 的每一步上报到 Langfuse（https://langfuse.com）
 *
 * 结构（在 Langfuse 里看到的样子）：
 *   Session（一次 npm run 启动到退出）
 *   └─ Trace "agent-turn"（你的一次输入）            asType: agent
 *      ├─ Generation（每次调用 LLM，observeOpenAI 自动记录：消息、token、耗时）
 *      ├─ Tool "tool:read_file"（每次工具调用：参数、输出、是否被拦截）
 *      └─ Event "stop-hook"（Stop 钩子要求继续时）
 *
 * 只有 .env 里配置了 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY 才会启用；
 * 否则所有函数都是空操作，不联网、不影响性能。用 `npm run setup` 可以填写这几个值。
 *
 * 接入方式完全按官方文档：OpenTelemetry NodeSDK + LangfuseSpanProcessor + observeOpenAI
 * https://langfuse.com/docs/observability/get-started
 */
import { randomUUID } from "node:crypto";

import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";

export interface Telemetry {
  enabled: boolean;
  sessionId: string;
  /** 包装 OpenAI 客户端，之后每次 LLM 调用都会自动记录为一个 generation */
  wrapClient<T extends object>(client: T): T;
  /** 把一轮对话记录为一条 trace，里面的 LLM 调用、工具调用都会挂在它下面 */
  traceTurn(input: string, fn: () => Promise<string>): Promise<string>;
  /** 退出前调用：把还没发出去的数据发完 */
  shutdown(): Promise<void>;
}

export function langfuseConfigured(env = process.env) {
  return Boolean(env.LANGFUSE_PUBLIC_KEY && env.LANGFUSE_SECRET_KEY);
}

/** 调用前要先加载 .env（loadConfig() 会做这件事），SDK 从环境变量读取 key 和地址 */
export function initTelemetry(opts: { traceName?: string; tags?: string[] } = {}): Telemetry {
  const sessionId = `harness-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}-${randomUUID().slice(0, 8)}`;
  const traceName = opts.traceName ?? "agent-turn";

  if (!langfuseConfigured()) {
    return {
      enabled: false,
      sessionId,
      wrapClient: (c) => c,
      traceTurn: (_input, fn) => fn(),
      shutdown: async () => {},
    };
  }

  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();

  return {
    enabled: true,
    sessionId,
    wrapClient: (client) => observeOpenAI(client, { sessionId, tags: opts.tags }),
    traceTurn: (input, fn) =>
      propagateAttributes({ sessionId, traceName, tags: opts.tags }, () =>
        startActiveObservation(
          traceName,
          async (span) => {
            span.update({ input });
            try {
              const output = await fn();
              span.update({ output });
              return output;
            } catch (err) {
              span.update({ level: "ERROR", statusMessage: (err as Error).message });
              throw err;
            }
          },
          { asType: "agent" },
        ),
      ),
    shutdown: () => sdk.shutdown(),
  };
}
