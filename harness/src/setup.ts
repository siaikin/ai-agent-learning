/**
 * 交互式配置表单：npm run setup
 *
 * 填写 API 地址 / API Key / 模型 → 测试连通性 → 写入 harness/.env
 * 再次运行时，回车即可保留当前值。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { DEFAULTS, ENV_PATH, createClient, type LLMConfig } from "./config.js";

/** 普通输入：每次提问新建一个 readline，用完即关，避免和下面的密码输入抢 stdin */
async function question(prompt: string) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

/** 密码输入：raw 模式下逐字符读取，屏幕上只显示 * */
function questionSecret(prompt: string): Promise<string> {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) return question(prompt); // 非终端（如管道输入）时退化为普通输入
  return new Promise((resolve) => {
    let value = "";
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") {
          stdin.off("data", onData);
          stdin.setRawMode(false);
          stdin.pause();
          stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") {
          // Ctrl+C
          stdin.setRawMode(false);
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          // 退格
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue; // 忽略其他控制字符
        value += ch;
        stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_PATH)) return {};
  const env: Record<string, string> = {};
  for (const line of readFileSync(ENV_PATH, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m?.[1]) env[m[1]] = m[2]!.replace(/^["']|["']$/g, "");
  }
  return env;
}

function maskKey(key: string) {
  return key.length <= 8 ? "****" : `${key.slice(0, 3)}****${key.slice(-4)}`;
}

/**
 * 规范化 API 地址（Claude 格式）：SDK 会自己在后面拼 /v1/messages，
 * 所以去掉结尾的 /、误填的 /v1/messages 或 /v1。留空表示 Anthropic 官方地址。
 */
function normalizeBaseURL(input: string) {
  let url = input.trim().replace(/\/+$/, "");
  if (!url) return "";
  for (const suffix of ["/v1/messages", "/messages", "/v1"]) {
    if (url.endsWith(suffix)) {
      url = url.slice(0, -suffix.length);
      console.log(`  已去掉结尾的 ${suffix}（SDK 会自动拼上 /v1/messages）→ ${url}`);
      break;
    }
  }
  new URL(url); // 格式不对会抛错
  return url;
}

async function ask(label: string, current: string, opts: { secret?: boolean } = {}) {
  const shown = current ? (opts.secret ? maskKey(current) : current) : "";
  const hint = shown ? ` \x1b[2m[${shown}]\x1b[0m` : "";
  const prompt = `${label}${hint}: `;
  const answer = (opts.secret ? await questionSecret(prompt) : await question(prompt)).trim();
  return answer || current;
}

async function testConnection(config: LLMConfig) {
  const client = createClient(config);
  // 1) 列出可用模型（部分中转服务不支持，失败不算错）
  try {
    const models = await client.models.list();
    const ids = models.data.map((m) => m.id);
    if (ids.length) console.log(`  可用模型：${ids.slice(0, 15).join(", ")}${ids.length > 15 ? " …" : ""}`);
    if (ids.length && !ids.includes(config.model)) {
      console.log(`  \x1b[33m注意：列表里没有 ${config.model}，请确认模型名\x1b[0m`);
    }
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) throw err; // Key 错误，直接报告
    console.log("  （该服务不支持 /models，跳过模型列表）");
  }
  // 2) 发一条最小的对话请求，确认地址、Key、模型都正确
  const res = await client.messages.create({
    model: config.model,
    max_tokens: 64,
    messages: [{ role: "user", content: "Reply with: ok" }],
  });
  const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
  console.log(`  \x1b[32m✓ 连接成功\x1b[0m，模型回复：${text || "(空)"}（stop_reason: ${res.stop_reason}）`);
}

/** 把若干变量合并写回 .env，保留其他已有变量 */
function writeEnv(updates: Record<string, string>) {
  const merged = { ...readEnvFile(), ...updates };
  const body = Object.entries(merged).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
  writeFileSync(ENV_PATH, body, { mode: 0o600 });
}

const LANGFUSE_REGIONS: Record<string, string> = {
  "1": "https://cloud.langfuse.com",
  "2": "https://us.cloud.langfuse.com",
  "3": "https://jp.cloud.langfuse.com",
};

/** 用公开 API 验证 key：成功时返回项目名 */
async function testLangfuse(baseUrl: string, publicKey: string, secretKey: string) {
  const res = await fetch(`${baseUrl}/api/public/projects`, {
    headers: { Authorization: `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString("base64")}` },
  });
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
  const body = (await res.json()) as { data?: { name?: string }[] };
  return body.data?.[0]?.name ?? "(unknown project)";
}

async function langfuseSetup() {
  const env = readEnvFile();
  console.log("\n配置 Langfuse 可观测性（可选）：每次 LLM 调用、工具调用都会上报到 Langfuse");
  console.log("在 Langfuse 网页的 Settings → API Keys 里创建 key。回车保留方括号中的当前值。\n");
  console.log("数据区域：[1] 欧盟 cloud.langfuse.com  [2] 美国  [3] 日本  或直接输入地址（自部署）");
  const current = env.LANGFUSE_BASE_URL || LANGFUSE_REGIONS["1"]!;
  const regionInput = await ask("区域或地址", current);
  const baseUrl = (LANGFUSE_REGIONS[regionInput] ?? regionInput).replace(/\/+$/, "");
  const publicKey = await ask("Public Key (pk-lf-...)", env.LANGFUSE_PUBLIC_KEY ?? "");
  const secretKey = await ask("Secret Key (sk-lf-...)", env.LANGFUSE_SECRET_KEY ?? "", { secret: true });
  if (!publicKey || !secretKey) {
    console.log("未填写 key，跳过 Langfuse。");
    return;
  }
  console.log("\n测试 Langfuse 连接…");
  let ok = true;
  try {
    const project = await testLangfuse(baseUrl, publicKey, secretKey);
    console.log(`  \x1b[32m✓ 连接成功\x1b[0m，项目：${project}`);
  } catch (err) {
    ok = false;
    const e = err as { status?: number; message: string };
    console.log(`  \x1b[31m✗ 连接失败\x1b[0m：${e.message}`);
    if (e.status === 401) console.log("  提示：key 不正确，或者 key 属于另一个数据区域");
  }
  const choice = (await question(ok ? "保存到 .env？(Y/n) " : "仍然保存？(y/N) ")).trim().toLowerCase();
  if (ok ? choice === "n" : choice !== "y") {
    console.log("未保存。");
    return;
  }
  writeEnv({ LANGFUSE_BASE_URL: baseUrl, LANGFUSE_PUBLIC_KEY: publicKey, LANGFUSE_SECRET_KEY: secretKey });
  console.log(`已保存到 ${ENV_PATH}。之后运行 npm run s05 就会自动上报。`);
}

async function main() {
  if (process.argv.includes("langfuse")) return langfuseSetup();

  const env = readEnvFile();
  console.log("\n配置模型 API（Claude / Anthropic Messages API 格式，回车保留方括号中的当前值）");
  console.log("API 地址留空表示 Anthropic 官方；也可以填 Anthropic 兼容的服务或你自己的中转\n");

  while (true) {
    let baseURL: string;
    while (true) {
      try {
        baseURL = normalizeBaseURL(await ask("API 地址 (Base URL)", env.LLM_BASE_URL || DEFAULTS.baseURL));
        break;
      } catch {
        console.log("  地址格式不对，示例：https://api.anthropic.com 或 https://your-host/anthropic（留空 = 官方）");
      }
    }
    let apiKey = "";
    while (!apiKey) {
      apiKey = await ask("API Key", env.LLM_API_KEY ?? "", { secret: true });
      if (!apiKey) console.log("  API Key 不能为空");
    }
    const model = await ask("模型名 (Model)", env.LLM_MODEL || DEFAULTS.model);
    const maxTokens = Number(await ask("单次回复 token 上限 (max_tokens)", env.LLM_MAX_TOKENS || String(DEFAULTS.maxTokens))) || DEFAULTS.maxTokens;
    const config: LLMConfig = { baseURL, apiKey, model, maxTokens };

    console.log("\n测试连接…");
    let ok = true;
    try {
      await testConnection(config);
    } catch (err) {
      ok = false;
      const e = err as { status?: number; message: string };
      console.log(`  \x1b[31m✗ 连接失败\x1b[0m${e.status ? `（HTTP ${e.status}）` : ""}：${e.message}`);
      if (e.status === 404) console.log("  提示：确认这个地址提供的是 Anthropic 格式的接口（/v1/messages），而不是 OpenAI 格式（/v1/chat/completions）");
      if (e.status === 401) console.log("  提示：API Key 不正确");
    }

    const prompt = ok ? "保存到 .env？(Y/n) " : "仍然保存？(y/N) 输入 r 重新填写：";
    const choice = (await question(prompt)).trim().toLowerCase();
    if (choice === "r") {
      Object.assign(env, { LLM_BASE_URL: baseURL, LLM_API_KEY: apiKey, LLM_MODEL: model, LLM_MAX_TOKENS: String(maxTokens) });
      continue;
    }
    if (ok ? choice === "n" : choice !== "y") {
      console.log("未保存。");
      break;
    }
    // 保留 .env 里的其他变量，只更新这三项
    writeEnv({ LLM_BASE_URL: baseURL, LLM_API_KEY: apiKey, LLM_MODEL: model, LLM_MAX_TOKENS: String(maxTokens) });
    console.log(`已保存到 ${ENV_PATH}（已被 .gitignore 忽略，不会提交）`);
    break;
  }

  const configured = Boolean(readEnvFile().LANGFUSE_PUBLIC_KEY);
  const next = (await question(`\n配置 Langfuse 可观测性？${configured ? "（已配置）" : ""}(y/N) `)).trim().toLowerCase();
  if (next === "y") await langfuseSetup();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
