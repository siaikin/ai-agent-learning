/**
 * 技能按需加载（s07）："用到时再加载，别全塞 prompt 里"
 *
 * 两层：
 *   1. 目录：启动时扫描技能目录，把每个技能的 name + description 放进 system prompt（每个约 100 token，每轮都带）
 *   2. 内容：模型调用 load_skill 时，完整的 SKILL.md 作为工具结果进入对话（用到才花 token）
 *
 * 技能就是一个目录，里面有 SKILL.md（开头是 YAML frontmatter），可以再带附件：
 *   code-review/
 *     SKILL.md              ← ---\nname: code-review\ndescription: ...\n---\n正文
 *     references/security.md
 *
 * 两个来源，同名时项目的覆盖内置的（对应 Claude Code 的用户级 / 项目级技能）：
 *   - 内置：harness/skills/        随 harness 一起提供的通用技能
 *   - 项目：<工作目录>/.harness/skills/   某个项目自己的规范，比如它的组件写法、SQL 风格
 *
 * 和教程的差异：
 *   - 两个来源（教程只有一个 skills/ 目录）
 *   - load_skill 可以带 file 参数读取技能目录里的附件；路径会检查，不能跳出技能目录。
 *     内置技能的目录不在工作目录里，read_file 碰不到，所以需要这个参数
 *   - 目录里每条描述最多 200 字符，防止某个技能把 system prompt 撑大（Claude Code 给技能目录的预算约为上下文的 1%）
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WORKDIR, defineTool } from "./tools.js";

export const BUILTIN_SKILLS_DIR = fileURLToPath(new URL("../../skills", import.meta.url));
export const PROJECT_SKILLS_DIR = path.join(WORKDIR, ".harness", "skills");
const MAX_DESCRIPTION = 200;

export interface Skill {
  name: string;
  description: string;
  /** SKILL.md 的完整内容（含 frontmatter） */
  content: string;
  dir: string;
  source: "builtin" | "project";
}
export type SkillRegistry = Map<string, Skill>;

/** 解析最简单的 YAML frontmatter：只支持一行一个 `key: value`，值可以加引号 */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (kv) meta[kv[1]!] = kv[2]!.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return { meta, body: raw.slice(m[0].length) };
}

function scanDir(dir: string, source: Skill["source"], into: SkillRegistry) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir).sort()) {
    const skillDir = path.join(dir, entry);
    const manifest = path.join(skillDir, "SKILL.md");
    if (!statSync(skillDir).isDirectory() || !existsSync(manifest)) continue;
    const content = readFileSync(manifest, "utf8");
    const { meta, body } = parseFrontmatter(content);
    const name = meta.name || entry;
    const firstLine = body.split("\n").find((l) => l.trim())?.replace(/^#+\s*/, "") ?? "";
    into.set(name, { name, description: meta.description || firstLine, content, dir: skillDir, source });
  }
}

/** 启动时扫描一次。后扫描的项目技能会覆盖同名的内置技能 */
export function scanSkills(dirs: { builtin?: string; project?: string } = {}): SkillRegistry {
  const registry: SkillRegistry = new Map();
  scanDir(dirs.builtin ?? BUILTIN_SKILLS_DIR, "builtin", registry);
  scanDir(dirs.project ?? PROJECT_SKILLS_DIR, "project", registry);
  return registry;
}

/** 第一层：放进 system prompt 的技能目录 */
export function skillCatalog(registry: SkillRegistry): string {
  if (registry.size === 0) return "(no skills installed)";
  return [...registry.values()]
    .map((s) => {
      const desc = s.description.length > MAX_DESCRIPTION ? `${s.description.slice(0, MAX_DESCRIPTION)}…` : s.description;
      return `- ${s.name}: ${desc}`;
    })
    .join("\n");
}

/** 列出技能目录里除 SKILL.md 以外的附件（相对路径） */
function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const full = path.join(dir, f);
    if (statSync(full).isDirectory()) return listFiles(full, base);
    const rel = path.relative(base, full);
    return rel === "SKILL.md" ? [] : [rel];
  });
}

/** 第二层：load_skill 工具 */
export function loadSkillTool(registry: SkillRegistry) {
  return defineTool<{ name: string; file?: string }>({
    name: "load_skill",
    description:
      "Load the full instructions of a skill listed under 'Skills available' in the system prompt. " +
      "Load a skill before doing a task it covers. Pass `file` to read one of the extra files the skill mentions " +
      "(paths are relative to the skill directory).",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name from the catalog" },
        file: { type: "string", description: "Optional: a file inside the skill directory, e.g. references/security.md" },
      },
      required: ["name"],
    },
    handler: ({ name, file }) => {
      const skill = registry.get(name);
      if (!skill) return `Error: skill "${name}" not found. Available: ${[...registry.keys()].join(", ") || "(none)"}`;
      if (file) {
        // 通过注册表找到技能目录，再检查 file 不能跳出这个目录
        const resolved = path.resolve(skill.dir, file);
        const rel = path.relative(skill.dir, resolved);
        if (rel.startsWith("..") || path.isAbsolute(rel)) return `Error: path escapes the skill directory: ${file}`;
        if (!existsSync(resolved) || !statSync(resolved).isFile()) return `Error: file not found in skill "${name}": ${file}`;
        return readFileSync(resolved, "utf8");
      }
      const extras = listFiles(skill.dir);
      const footer = extras.length
        ? `\n\n---\nExtra files in this skill (read with load_skill and \`file\`): ${extras.join(", ")}`
        : "";
      return `${skill.content}${footer}`;
    },
  });
}
