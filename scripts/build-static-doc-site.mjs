import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = process.cwd();
const ASSET_ROOT = path.join(PROJECT_ROOT, 'assets');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'web/data/index.json');
const OUTPUT_DIR = path.dirname(OUTPUT_PATH);
const STANDARD_ROOT = path.join(PROJECT_ROOT, 'docs-standard');
const INCLUDED_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const SKIP_DIRS = new Set(['.git', '.DS_Store', 'node_modules', '.tmp']);

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function trimExt(name) {
  return name.replace(/\.md$|\.txt$|\.json$|\.yml$|\.yaml$/i, '');
}

function isTextPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '' || INCLUDED_EXTENSIONS.has(ext);
}

function classify(relativePath) {
  const parts = relativePath.split('/');
  if (parts.length >= 2 && parts[0] === 'design-data') {
    if (parts[1] === 'design-heros' && parts.length >= 4) {
      return {
        category: 'hero',
        group: `英雄 / ${parts[2]}`,
        meta: { attribute: parts[2], hero: parts[3] },
      };
    }
    if (parts[1] === 'design-item' && parts.length >= 4) {
      return {
        category: 'item',
        group: `物品 / ${parts[2]}/${parts[3]}`,
      };
    }
    if (parts[1] === 'design-skills' && parts.length >= 4) {
      return {
        category: 'skill',
        group: `技能 / ${parts[2]}/${parts[3]}`,
      };
    }
    if (parts[1] === 'design-units' && parts.length >= 3) {
      const unitType = parts[2] || '';
      const unitSub = parts[3] || '';
      return {
        category: 'unit',
        group: unitSub ? `单位 / ${unitType}/${unitSub}` : `单位 / ${unitType}`,
      };
    }
    if (parts[1] === 'backstory' && parts.length >= 3) {
      return { category: 'backstory', group: `背景故事 / ${parts[2]}` };
    }
    if (parts[1] === 'design-rules') {
      return { category: 'rule', group: '规则' };
    }
    if (parts[1] === 'design-building') {
      return { category: 'building', group: `建筑 / ${parts[2] || ''}` };
    }
    if (parts[1] === 'design-scenes') {
      return { category: 'scene', group: '场景' };
    }
    if (parts[1] === 'design-template') {
      return { category: 'template', group: '模板' };
    }
    return { category: 'other', group: parts[1] || '其他' };
  }
  return { category: 'other', group: '其他' };
}

async function findFiles(rootDir, relativeBase = '') {
  const entries = await fs.readdir(rootDir, { withFileTypes: true });
  const list = [];

  for (const entry of entries) {
    if (entry.name.startsWith('.')) {
      continue;
    }
    if (SKIP_DIRS.has(entry.name)) {
      continue;
    }
    const absolute = path.join(rootDir, entry.name);
    const relative = toPosix(path.join(relativeBase, entry.name));
    if (entry.isDirectory()) {
      const nested = await findFiles(absolute, relative);
      list.push(...nested);
      continue;
    }
    if (entry.isFile() && isTextPath(entry.name)) {
      list.push(relative);
    }
  }
  return list;
}

async function collectHeroImages(attribute, hero) {
  const heroDir = path.join(ASSET_ROOT, 'images', 'heros', attribute, hero);
  try {
    const items = await fs.readdir(heroDir);
    return items
      .filter((name) => path.extname(name).toLowerCase() === '.png')
      .sort()
      .map((name) => toPosix(path.join('assets', 'images', 'heros', attribute, hero, name)));
  } catch {
    return [];
  }
}

function sourcePathFromStandardDoc(standardDoc, relativePath) {
  const sourcePath = standardDoc?.source?.path;
  if (typeof sourcePath === 'string' && sourcePath.trim()) {
    return sourcePath.trim();
  }
  return relativePath.replace(/^docs-standard\//, '').replace(/\.json$/, '');
}

function sourceTypeFromPath(sourcePath) {
  const extension = path.extname(sourcePath);
  if (!extension) {
    return 'txt';
}
  return extension.replace('.', '');
}

async function buildIndexFromStandard() {
  const files = await findFiles(STANDARD_ROOT, 'docs-standard');
  const docs = [];

  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const rawStandard = await fs.readFile(absolutePath, 'utf8');
    const standardDoc = JSON.parse(rawStandard);
    const sourcePath = sourcePathFromStandardDoc(standardDoc, relPath);
    const normalizedName = trimExt(path.basename(sourcePath));
    const sourceCategory = standardDoc.meta?.category || 'other';
    const cls = classify(sourcePath);
    const fileName = path.basename(sourcePath);
    const group = sourceCategory && sourceCategory !== 'other' ? standardDoc.meta?.group || cls.group : cls.group;
    const title = standardDoc.meta?.title || normalizedName;
    let imageList = [];
    if ((sourceCategory || cls.category) === 'hero') {
      const attribute = standardDoc.meta?.attribute;
      const hero = standardDoc.meta?.hero;
      if (attribute && hero) {
        imageList = await collectHeroImages(attribute, hero);
      }
    }

    docs.push({
      path: sourcePath,
      title,
      name: normalizedName,
      category: sourceCategory || cls.category,
      group: group || cls.group,
      type: sourceTypeFromPath(sourcePath),
      lastModified: standardDoc.source?.modifiedAt || new Date().toISOString(),
      size: standardDoc.source?.size || 0,
      content: standardDoc.raw || JSON.stringify(standardDoc.data || standardDoc, null, 2),
      heroImages: imageList,
      standardPath: relPath,
      parser: standardDoc.parser || {},
    });
  }

  return docs;
}

async function buildIndex() {
  const shouldUseStandard = fsSync.existsSync(STANDARD_ROOT);
  if (shouldUseStandard) {
    const docs = await buildIndexFromStandard();
    docs.sort((a, b) => {
      if (a.group !== b.group) {
        return a.group.localeCompare(b.group, 'zh-CN');
      }
      return a.name.localeCompare(b.name, 'zh-CN');
    });
    return {
      generatedAt: new Date().toISOString(),
      count: docs.length,
      docs,
    };
  }

  const files = await findFiles(path.join(PROJECT_ROOT, 'design-data'), 'design-data');
  const docs = [];

  for (const relPath of files) {
    const absolutePath = path.join(PROJECT_ROOT, relPath);
    const fileName = path.basename(relPath);
    const ext = path.extname(fileName).toLowerCase();
    const cls = classify(relPath);

    const stat = await fs.stat(absolutePath);
    const content = await fs.readFile(absolutePath, 'utf8');
    let imageList = [];
    if (cls.category === 'hero') {
      imageList = await collectHeroImages(cls.meta.attribute, cls.meta.hero);
    }

    docs.push({
      path: relPath,
      title: trimExt(fileName),
      name: trimExt(fileName),
      category: cls.category,
      group: cls.group,
      type: ext ? ext.slice(1) : 'txt',
      lastModified: stat.mtime.toISOString(),
      size: stat.size,
      content,
      heroImages: imageList,
    });
  }

  const rootFiles = ['README.md', 'design-data/README.md'];
  for (const relPath of rootFiles) {
    const absolute = path.join(PROJECT_ROOT, relPath);
    if (!fsSync.existsSync(absolute)) {
      continue;
    }
    const stat = await fs.stat(absolute);
    const raw = await fs.readFile(absolute, 'utf8');
    docs.push({
      path: relPath,
      title: relPath === 'README.md' ? '项目说明文档' : '设计资料说明',
      name: relPath === 'README.md' ? '项目说明文档' : '设计资料说明',
      category: relPath === 'README.md' ? 'root' : 'other',
      group: relPath === 'README.md' ? '根目录' : '设计资料',
      type: 'md',
      lastModified: stat.mtime.toISOString(),
      size: stat.size,
      content: raw,
      heroImages: [],
    });
  }

  docs.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group, 'zh-CN');
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return {
    generatedAt: new Date().toISOString(),
    count: docs.length,
    docs,
  };
}

async function main() {
  const index = await buildIndex();
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(OUTPUT_PATH, `${JSON.stringify(index)}\n`, 'utf8');
  console.log(`Static index created: ${OUTPUT_PATH}`);
  console.log(`docs=${index.count}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
