/**
 * 统一读取模型配置。任何兼容 OpenAI 接口的服务都能用：
 * DeepSeek 官方、你自己的 API / 中转、vLLM 等。
 *
 * 配置来源（优先级从高到低）：环境变量 > harness/.env
 * 用 `npm run setup` 可以通过表单生成 .env。
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";

export const ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export const DEFAULTS = {
  baseURL: "https://api.deepseek.com",
  model: "deepseek-chat",
};

export interface LLMConfig {
  baseURL: string;
  apiKey: string;
  model: string;
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
  };
}

export function createClient(config: LLMConfig) {
  return new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL });
}
