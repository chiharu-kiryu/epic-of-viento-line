import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const designRoot = path.join(root, "design-data");

const skipFiles = new Set([
  path.join("design-data", "design-heros", "智力", "审查官"),
]);

const heroSectionHeaders = new Set([
  "天生技能：",
  "技能1：",
  "技能2：",
  "技能3：",
  "技能4：",
  "阳印：",
  "阴印：",
  "铸魔：",
  "铸神：",
]);

const commonSectionHeaders = new Set([
  "属性：",
  "被动：",
  "主动：",
  "被动技能：",
  "主动技能：",
  "合成公式：",
  "物品描述：",
]);

const labelMap = new Map([
  ["攻击距离", "攻击距离："],
  ["基础攻击间隔", "基础攻击间隔："],
  ["基础移动速度", "基础移动速度："],
  ["天生技能", "天生技能："],
  ["技能1", "技能1："],
  ["技能2", "技能2："],
  ["技能3", "技能3："],
  ["技能4", "技能4："],
  ["阳印", "阳印："],
  ["阴印", "阴印："],
  ["铸魔", "铸魔："],
  ["铸神", "铸神："],
  ["主属性", "主属性："],
  ["力量", "力量："],
  ["敏捷", "敏捷："],
  ["智力", "智力："],
  ["生命", "生命："],
  ["攻击", "攻击："],
  ["护甲", "护甲："],
  ["魔抗", "魔抗："],
  ["回血", "回血："],
  ["攻击间隔", "攻击间隔："],
  ["移动速度", "移动速度："],
  ["射程", "攻击距离："],
  ["击杀奖励", "击杀奖励："],
  ["价格", "价格："],
  ["属性", "属性："],
  ["被动", "被动："],
  ["主动", "主动："],
  ["被动技能", "被动技能："],
  ["主动技能", "主动技能："],
  ["类型", "类型："],
  ["冷却", "冷却："],
  ["冷却时间", "冷却："],
  ["魔力消耗", "魔力消耗："],
  ["内置冷却", "内置冷却："],
  ["内置cd", "内置冷却："],
  ["合成公式", "合成公式："],
  ["物品描述", "物品描述："],
]);

function listFiles(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full));
    } else {
      files.push(full);
    }
  }
  return files;
}

function normalizeText(text) {
  return text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function normalizeGrowth(value) {
  const trimmed = value.trim();
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*\+\s*(\d+(?:\.\d+)?)$/);
  if (!match) return trimmed;
  return `${match[1]} + ${match[2]}`;
}

function normalizeLabel(line) {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const shorthand = trimmed.match(/^(cd|mp)\s*[：:]\s*(.+)$/i);
  if (shorthand) {
    const key = shorthand[1].toLowerCase() === "cd" ? "冷却：" : "魔力消耗：";
    return `${key}${shorthand[2].trim()}`;
  }

  const match = trimmed.match(/^([^：:]{1,20})\s*[：:]\s*(.*)$/);
  if (match && labelMap.has(match[1])) {
    return `${labelMap.get(match[1])}${match[2].trim()}`;
  }

  if (labelMap.has(trimmed)) {
    return labelMap.get(trimmed);
  }

  if (/^[^：:]{1,30}:$/.test(trimmed)) {
    return `${trimmed.slice(0, -1)}：`;
  }

  return trimmed;
}

function collapseBlankLines(lines) {
  const result = [];
  let previousBlank = false;
  for (const line of lines) {
    const blank = line.trim() === "";
    if (blank && previousBlank) continue;
    result.push(blank ? "" : line);
    previousBlank = blank;
  }
  while (result.length > 0 && result[0] === "") result.shift();
  while (result.length > 0 && result[result.length - 1] === "") result.pop();
  return result;
}

function normalizeAttackTypeLine(line) {
  if (line === "近战" || line === "远程") {
    return `攻击类型：${line}`;
  }
  return line;
}

function ensureSectionSpacing(lines, headers) {
  const result = [];
  for (const line of lines) {
    const needsGap = headers.has(line) && result.length > 0 && result[result.length - 1] !== "";
    if (needsGap) result.push("");
    result.push(line);
  }
  return result;
}

function splitLeadingMeta(lines, stopHeaders = new Set()) {
  const title = lines[0] ?? "";
  let i = 1;
  const meta = [];
  while (i < lines.length) {
    const line = lines[i];
    if (stopHeaders.has(line)) break;
    if (line === "") {
      i += 1;
      break;
    }
    meta.push(line);
    i += 1;
  }
  while (i < lines.length && lines[i] === "") i += 1;
  return { title, meta, rest: lines.slice(i) };
}

function orderByPreferred(meta, preferredLabels) {
  const buckets = new Map();
  const unlabeled = [];
  for (const line of meta) {
    const match = line.match(/^([^：]+)：/);
    if (match && preferredLabels.includes(match[1])) {
      if (!buckets.has(match[1])) buckets.set(match[1], []);
      buckets.get(match[1]).push(line);
    } else {
      unlabeled.push(line);
    }
  }
  const ordered = [];
  for (const label of preferredLabels) {
    if (buckets.has(label)) ordered.push(...buckets.get(label));
  }
  ordered.push(...unlabeled);
  return ordered;
}

function extractTrailingParagraph(lines) {
  let end = lines.length - 1;
  while (end >= 0 && lines[end] === "") end -= 1;
  if (end < 0) return { head: [], tail: [] };
  let start = end;
  while (start >= 0 && lines[start] !== "") start -= 1;
  const tail = lines.slice(start + 1, end + 1);
  const head = lines.slice(0, start + 1);
  return { head, tail };
}

function normalizeHeroDoc(lines) {
  let normalized = lines.map(normalizeLabel).map(normalizeAttackTypeLine);

  if (
    normalized.length >= 10 &&
    ["力量", "敏捷", "智力", "力量：", "敏捷：", "智力："].includes(normalized[6]) &&
    /^\d/.test(normalized[7]) &&
    /^\d/.test(normalized[8]) &&
    /^\d/.test(normalized[9])
  ) {
    const primary = normalized[6].replace(/：$/, "");
    normalized.splice(
      6,
      4,
      `主属性：${primary}`,
      `力量：${normalizeGrowth(normalized[7])}`,
      `敏捷：${normalizeGrowth(normalized[8])}`,
      `智力：${normalizeGrowth(normalized[9])}`,
    );
  }

  normalized = normalized.map((line) => {
    if (/^(力量|敏捷|智力)：/.test(line)) {
      const [label, value] = line.split("：");
      return `${label}：${normalizeGrowth(value ?? "")}`;
    }
    return line;
  });

  normalized = collapseBlankLines(normalized);
  normalized = ensureSectionSpacing(normalized, heroSectionHeaders);
  return normalized;
}

function normalizeItemDoc(lines) {
  let normalized = lines.map(normalizeLabel);

  if (normalized.length > 1) {
    let index = 1;
    while (index < normalized.length && normalized[index] === "") index += 1;
    if (index < normalized.length && normalized[index].startsWith("+")) {
      normalized.splice(index, 0, "属性：");
    }
  }

  normalized = collapseBlankLines(normalized);

  const { title, meta, rest } = splitLeadingMeta(normalized, commonSectionHeaders);
  const orderedMeta = orderByPreferred(meta, ["属性", "价格"]);
  let body = [...rest];

  const priceInBody = body.filter((line) => line.startsWith("价格："));
  if (priceInBody.length > 0) {
    body = body.filter((line) => !line.startsWith("价格："));
    orderedMeta.push(...priceInBody);
  }

  const hasDescriptionLabel = body.some((line) => line === "物品描述：");
  if (!hasDescriptionLabel) {
    const { head, tail } = extractTrailingParagraph(body);
    if (tail.length > 0 && !tail.some((line) => /^[^：]+：/.test(line))) {
      body = [...head];
      if (body.length > 0 && body[body.length - 1] !== "") body.push("");
      body.push("物品描述：", ...tail);
    }
  }

  const result = [title];
  if (orderedMeta.length > 0) result.push("", ...orderedMeta);
  if (body.length > 0) result.push("", ...body);

  return ensureSectionSpacing(collapseBlankLines(result), commonSectionHeaders);
}

function normalizeSkillDoc(lines) {
  let normalized = lines.map(normalizeLabel);

  const titleMatch = normalized[0]?.match(/^【(.+?)：(.+)】$/);
  const hasTypeLine = normalized.some((line, index) => index > 0 && line.startsWith("类型："));
  if (titleMatch) {
    normalized[0] = titleMatch[2].trim();
    if (!hasTypeLine) {
      normalized.splice(1, 0, "", `类型：${titleMatch[1].trim()}`);
    }
  }

  normalized = collapseBlankLines(normalized);
  const title = normalized[0] ?? "";
  const typeLine = normalized.find((line, index) => index > 0 && line.startsWith("类型：")) ?? "";
  const desc = [];
  const meta = [];
  for (let i = 1; i < normalized.length; i += 1) {
    const line = normalized[i];
    if (line === typeLine) continue;
    if (/^(冷却|魔力消耗|内置冷却)：/.test(line)) meta.push(line);
    else desc.push(line);
  }
  const orderedMeta = orderByPreferred(meta, ["冷却", "魔力消耗", "内置冷却"]);
  const result = [title];
  if (typeLine) result.push("", typeLine);
  if (desc.length > 0) result.push("", ...desc);
  if (orderedMeta.length > 0) result.push("", ...orderedMeta);
  return collapseBlankLines(result);
}

function normalizeStructuredDoc(lines) {
  let normalized = lines.map(normalizeLabel).map(normalizeAttackTypeLine);
  normalized = collapseBlankLines(normalized);
  const { title, meta, rest } = splitLeadingMeta(normalized, commonSectionHeaders);
  const orderedMeta = orderByPreferred(meta, [
    "攻击类型",
    "攻击距离",
    "生命",
    "攻击",
    "护甲",
    "魔抗",
    "攻击间隔",
    "移动速度",
    "回血",
    "击杀奖励",
  ]);
  const result = [title];
  if (orderedMeta.length > 0) result.push("", ...orderedMeta);
  if (rest.length > 0) result.push("", ...rest);
  return ensureSectionSpacing(collapseBlankLines(result), commonSectionHeaders);
}

function normalizeByKind(relPath, raw) {
  const lines = normalizeText(raw).split("\n").map((line) => line.trimEnd());

  if (relPath.startsWith(path.join("design-data", "design-heros")) || relPath.startsWith(path.join("design-data", "design-template"))) {
    return `${normalizeHeroDoc(lines).join("\n")}\n`;
  }

  if (
    relPath.startsWith(path.join("design-data", "design-item"))
  ) {
    return `${normalizeItemDoc(lines).join("\n")}\n`;
  }

  if (relPath.startsWith(path.join("design-data", "design-skills"))) {
    return `${normalizeSkillDoc(lines).join("\n")}\n`;
  }

  if (
    relPath.startsWith(path.join("design-data", "design-units")) ||
    relPath.startsWith(path.join("design-data", "design-building")) ||
    relPath.startsWith(path.join("design-data", "design-scenes"))
  ) {
    return `${normalizeStructuredDoc(lines).join("\n")}\n`;
  }

  return `${collapseBlankLines(lines.map((line) => line.trim())).join("\n")}\n`;
}

const files = listFiles(designRoot).filter((file) => {
  const relPath = path.relative(root, file);
  if (skipFiles.has(relPath)) return false;
  if (relPath.endsWith(".json")) return false;
  if (relPath.endsWith(".md")) return false;
  if (path.basename(relPath) === ".DS_Store") return false;
  return true;
});

for (const file of files) {
  const relPath = path.relative(root, file);
  const current = fs.readFileSync(file, "utf8");
  const next = normalizeByKind(relPath, current);
  if (next !== normalizeText(current)) {
    fs.writeFileSync(file, next, "utf8");
  }
}
