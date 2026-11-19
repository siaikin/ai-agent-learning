/**
 * 统一读取模型配置。使用 Claude（Anthropic Messages API）格式的接口：
 * Anthropic 官方、DeepSeek 等提供的 Anthropic 兼容地址、你自己的中转都可以。
 *
 * 配置来源（优先级从高到低）：环境变量 > harness/.env
 * 用 `npm run setup` 可以通过表单生成 .env。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export const DEFAULTS = {
  /** 留空表示 Anthropic 官方地址 https://api.anthropic.com */
  baseURL: "",
  model: "claude-opus-5-5",
  /** 单次回复的 token 上限。非流式请求建议 16000 左右；兼容服务的上限可能更低 */
  maxTokens: 16000,
};

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export function loadConfig(): LLMConfig {
  if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
  const apiKey = process.env.LLM_API_KEY;
  if (!apiKey) {
    console.error("缺少 LLM_API_KEY：先运行 `npm run setup` 填写 API 配置");
    process.exit(1);
  }
  return {
    apiKey,
    baseURL: process.env.LLM_BASE_URL || DEFAULTS.baseURL,
    model: process.env.LLM_MODEL || DEFAULTS.model,
    maxTokens: Number(process.env.LLM_MAX_TOKENS) || DEFAULTS.maxTokens,
  };
}

export const OFFICIAL_BASE_URL = "https://api.anthropic.com";

export function createClient(config: Pick<LLMConfig, "apiKey" | "baseURL">) {
  const custom = Boolean(config.baseURL);
  return new Anthropic({
    apiKey: config.apiKey,
    // 留空时明确用官方地址，不让 SDK 去读系统里的 ANTHROPIC_BASE_URL（比如给其他工具设置的），行为只由 .env 决定
    baseURL: config.baseURL || OFFICIAL_BASE_URL,
    // SDK 1.x 用 Authorization: Bearer 发送 key；不少 Anthropic 兼容服务和中转只认传统的 x-api-key，
    // 所以连自定义地址时两种头都带上
    ...(custom ? { defaultHeaders: { "x-api-key": config.apiKey } } : {}),
    // SDK 自带的 OpenTelemetry span 关掉：LLM 调用由 lib/agent.ts 手动记录成 Langfuse generation，
    // 两边都开会让同一次调用在 Langfuse 里出现两次、token 被算两遍
    openTelemetry: false,
  });
}
