import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const heroDocRoot = path.join(root, "design-data", "design-heros");
const heroImageRoot = path.join(root, "assets", "images", "heros");
const videoRoot = path.join(root, "assets", "videos");

const sectionHeaders = [
  "天生技能：",
  "技能1：",
  "技能2：",
  "技能3：",
  "技能4：",
];

function walkHeroDocs() {
  const heroes = [];
  for (const attr of fs.readdirSync(heroDocRoot)) {
    const attrDir = path.join(heroDocRoot, attr);
    if (!fs.statSync(attrDir).isDirectory()) continue;
    for (const hero of fs.readdirSync(attrDir)) {
      const full = path.join(attrDir, hero);
      if (!fs.statSync(full).isFile()) continue;
      heroes.push({ attr, hero, full });
    }
  }
  heroes.sort((a, b) => `${a.attr}/${a.hero}`.localeCompare(`${b.attr}/${b.hero}`, "zh-Hans-CN"));
  return heroes;
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
}

function parseExpectedImageNames(lines) {
  const expected = ["原画.png"];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!sectionHeaders.includes(line)) continue;
    const next = lines.slice(i + 1).map((x) => x.trim()).find(Boolean);
    if (!next) continue;
    let imageName = next
      .replace(/[：:]\s*$/, "")
      .replace(/[：:]\s*.+$/, "")
      .trim();
    if (!imageName) continue;
    const fileName = `${imageName}.png`;
    if (!expected.includes(fileName)) expected.push(fileName);
  }
  return expected;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => fs.statSync(path.join(dir, name)).isFile())
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function fileExists(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

const heroes = walkHeroDocs();
const rows = [];
let totalHeroes = 0;
let readyHeroes = 0;
let partialHeroes = 0;
let emptyHeroes = 0;
let videoCount = 0;

for (const { attr, hero, full } of heroes) {
  totalHeroes += 1;
  const heroDir = path.join(heroImageRoot, attr, hero);
  ensureDir(heroDir);

  const expected = parseExpectedImageNames(readLines(full));
  const existing = listFiles(heroDir);
  const existingPng = existing.filter((name) => name.toLowerCase().endsWith(".png"));
  const matched = expected.filter((name) => existingPng.includes(name));
  const missing = expected.filter((name) => !existingPng.includes(name));
  const unexpected = existingPng.filter((name) => !expected.includes(name));

  let status = "空目录";
  if (missing.length === 0 && expected.length > 0) {
    status = unexpected.length > 0 ? "已就绪（含额外文件）" : "已就绪";
    readyHeroes += 1;
  } else if (matched.length > 0 || existing.length > 0) {
    status = "部分完成";
    partialHeroes += 1;
  } else {
    emptyHeroes += 1;
  }

  const video = fileExists(path.join(videoRoot, `${hero}.mp4`));
  if (video) videoCount += 1;

  rows.push({
    attr,
    hero,
    status,
    expected,
    existing,
    matched,
    missing,
    unexpected,
    video,
  });
}

function writeFile(file, content) {
  fs.writeFileSync(file, content, "utf8");
}

const readme = `# Hero Images\n\n` +
`英雄图片资源沿用当前仓库已有格式：\n\n` +
`- 路径：\`assets/images/heros/<属性>/<英雄名>/\`\n` +
`- 原画文件：\`原画.png\`\n` +
`- 技能图文件：按英雄设计文档中的“天生技能 / 技能1-技能4”名称命名，例如 \`星空祈唤.png\`\n` +
`- 视频资源：与图片并列保存在 \`assets/videos/<英雄名>.mp4\`\n\n` +
`资源清单见 [资源对照表.md](/Users/Shared/chroot/dev/epic-of-viento-line/assets/images/heros/资源对照表.md)。\n`;

const summaryLines = [
  "# 英雄图片资源对照表",
  "",
  "## 汇总",
  "",
  `- 英雄总数：${totalHeroes}`,
  `- 已就绪：${readyHeroes}`,
  `- 部分完成：${partialHeroes}`,
  `- 空目录：${emptyHeroes}`,
  `- 已有视频：${videoCount}`,
  "",
  "## 说明",
  "",
  "- 期望文件名根据英雄设计文档自动提取，规则为 `原画.png + 天生技能名.png + 技能1-4名.png`。",
  "- `已就绪（含额外文件）` 表示核心图片已齐，但目录中还有额外命名文件。",
  "- 宙灵兽等特殊角色可能存在多形态原画，额外文件会保留，不做重命名。",
  "",
  "## 明细",
  "",
  "| 属性 | 英雄 | 状态 | 已有文件 | 缺失文件 | 视频 |",
  "| --- | --- | --- | --- | --- | --- |",
];

for (const row of rows) {
  summaryLines.push(
    `| ${row.attr} | ${row.hero} | ${row.status} | ${row.existing.length ? row.existing.join("<br>") : "-"}` +
      ` | ${row.missing.length ? row.missing.join("<br>") : "-"}` +
      ` | ${row.video ? "有" : "-"} |`,
  );
}

writeFile(path.join(heroImageRoot, "README.md"), readme);
writeFile(path.join(heroImageRoot, "资源对照表.md"), `${summaryLines.join("\n")}\n`);
