import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { BUILTIN_SKILLS_DIR, loadSkillTool, parseFrontmatter, scanSkills, skillCatalog } from "./skills.js";

function makeSkill(root: string, dir: string, manifest: string, extra: Record<string, string> = {}) {
  mkdirSync(path.join(root, dir), { recursive: true });
  writeFileSync(path.join(root, dir, "SKILL.md"), manifest);
  for (const [rel, content] of Object.entries(extra)) {
    mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
    writeFileSync(path.join(root, dir, rel), content);
  }
}

function fixture() {
  const base = mkdtempSync(path.join(tmpdir(), "skills-"));
  const builtin = path.join(base, "builtin");
  const project = path.join(base, "project");
  makeSkill(builtin, "sql", "---\nname: sql-style\ndescription: \"SQL conventions\"\n---\n# SQL\nUse snake_case.", {
    "references/tables.md": "users(id, name)",
  });
  makeSkill(builtin, "review", "---\nname: review\ndescription: generic review\n---\nbuiltin body");
  makeSkill(builtin, "nofront", "# Plain title line\nbody");
  makeSkill(project, "review", "---\nname: review\ndescription: our team's review rules\n---\nproject body");
  return { builtin, project };
}

test("parseFrontmatter 读出 key: value，去掉引号；没有 frontmatter 时原样返回", () => {
  const { meta, body } = parseFrontmatter("---\nname: a\ndescription: 'quoted text'\n---\nhello");
  assert.deepEqual(meta, { name: "a", description: "quoted text" });
  assert.equal(body, "hello");
  assert.deepEqual(parseFrontmatter("no front"), { meta: {}, body: "no front" });
});

test("扫描两个来源：名字取自 frontmatter，没有时用目录名和第一行；项目技能覆盖同名内置技能", () => {
  const reg = scanSkills(fixture());
  assert.deepEqual([...reg.keys()].sort(), ["nofront", "review", "sql-style"]);
  assert.equal(reg.get("nofront")!.description, "Plain title line");
  assert.equal(reg.get("review")!.source, "project");
  assert.equal(reg.get("review")!.description, "our team's review rules");
});

test("目录只包含名字和描述，不包含正文", () => {
  const catalog = skillCatalog(scanSkills(fixture()));
  assert.match(catalog, /- sql-style: SQL conventions/);
  assert.doesNotMatch(catalog, /snake_case/);
  assert.equal(skillCatalog(new Map()), "(no skills installed)");
});

test("load_skill 返回完整内容，并列出附件", async () => {
  const tool = loadSkillTool(scanSkills(fixture()));
  const out = await tool.handler({ name: "sql-style" });
  assert.match(out, /Use snake_case/);
  assert.match(out, /Extra files in this skill.*references\/tables\.md/);
  assert.equal(await tool.handler({ name: "sql-style", file: "references/tables.md" }), "users(id, name)");
});

test("load_skill：未知技能、跳出技能目录、文件不存在都返回 Error", async () => {
  const tool = loadSkillTool(scanSkills(fixture()));
  assert.match(await tool.handler({ name: "nope" }), /^Error: skill "nope" not found\. Available: /);
  assert.match(await tool.handler({ name: "sql-style", file: "../review/SKILL.md" }), /^Error: path escapes/);
  assert.match(await tool.handler({ name: "sql-style", file: "/etc/passwd" }), /^Error: path escapes/);
  assert.match(await tool.handler({ name: "sql-style", file: "missing.md" }), /^Error: file not found/);
});

test("仓库自带的内置技能都能被扫描到，且都有描述", () => {
  const reg = scanSkills({ builtin: BUILTIN_SKILLS_DIR, project: "/nonexistent" });
  assert.deepEqual([...reg.keys()].sort(), ["code-review", "git-commit", "vue-component"]);
  for (const s of reg.values()) assert.ok(s.description.length > 20, s.name);
});
