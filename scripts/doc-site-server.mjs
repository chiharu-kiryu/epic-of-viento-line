import fs from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';

const PORT = Number(process.env.PORT || 4173);
const PROJECT_ROOT = process.cwd();
const DOC_ROOT = path.join(PROJECT_ROOT, 'design-data');
const ASSET_ROOT = path.join(PROJECT_ROOT, 'assets');
const WEB_ROOT = path.join(PROJECT_ROOT, 'web');

const TEXT_EXTENSIONS = new Set(['.md', '.txt', '.json', '.yml', '.yaml']);
const IGNORE_DIRS = new Set(['.git', '.DS_Store', '.tmp', 'node_modules']);

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'application/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.md', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
]);

function normalizeSeparator(filePath) {
  return filePath.split(path.sep).join('/');
}

function trimExt(name) {
  return name.replace(/\.md$|\.txt$/i, '').replace(/\.json$/i, '');
}

function classifyEntry(relativePath) {
  const parts = relativePath.split('/');
  if (parts[0] !== 'design-data') {
    return {
      category: 'other',
      group: '其他',
      name: parts.at(-1) || relativePath,
    };
  }

  if (parts[1] === 'design-heros' && parts.length >= 4) {
    return {
      category: 'hero',
      group: `英雄 / ${parts[2]}`,
      meta: {
        attribute: parts[2],
        hero: parts[3],
      },
    };
  }

  if (parts[1] === 'design-item' && parts.length >= 4) {
    return {
      category: 'item',
      group: `物品 / ${parts[2]} / ${parts[3]}`,
    };
  }

  if (parts[1] === 'design-skills' && parts.length >= 4) {
    return {
      category: 'skill',
      group: `技能 / ${parts[2]} / ${parts[3]}`,
    };
  }

  if (parts[1] === 'design-units' && parts.length >= 3) {
    const unitType = parts[2] || '';
    const subtype = parts[3] || '';
    return {
      category: 'unit',
      group: subtype ? `单位 / ${unitType} / ${subtype}` : `单位 / ${unitType}`,
    };
  }

  if (parts[1] === 'backstory' && parts.length >= 3) {
    return {
      category: 'backstory',
      group: `背景故事 / ${parts[2]}`,
    };
  }

  if (parts[1] === 'design-rules' && parts.length >= 3) {
    return {
      category: 'rule',
      group: '规则',
    };
  }

  if (parts[1] === 'design-building' && parts.length >= 3) {
    return {
      category: 'building',
      group: `建筑 / ${parts[2]}`,
    };
  }

  if (parts[1] === 'design-scenes' && parts.length >= 3) {
    return {
      category: 'scene',
      group: '场景',
    };
  }

  if (parts[1] === 'design-template') {
    return {
      category: 'template',
      group: '模板',
    };
  }

  return {
    category: 'other',
    group: '其他',
  };
}

function isTextFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return ext === '' || TEXT_EXTENSIONS.has(ext);
}

async function safeReadDir(dir, relativeBase = '') {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue;
      }
      if (IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const child = await safeReadDir(full, `${relativeBase}${entry.name}/`);
        files.push(...child);
      } else if (entry.isFile()) {
        if (isTextFile(entry.name)) {
          const rel = path.join(relativeBase, entry.name);
          files.push(path.join(dir, rel));
        }
      }
    }
    return files;
  } catch (err) {
    return [];
  }
}

async function findHeroImages(attribute, hero) {
  const heroImageDir = path.join(ASSET_ROOT, 'images', 'heros', attribute, hero);
  try {
    const files = await fs.readdir(heroImageDir);
    return files
      .filter((item) => path.extname(item).toLowerCase() === '.png')
      .sort()
      .map((item) => normalizeSeparator(path.relative(PROJECT_ROOT, path.join(heroImageDir, item))));
  } catch {
    return [];
  }
}

async function buildDocIndex() {
  const result = [];
  const fileList = await safeReadDir(DOC_ROOT);

  for (const filePath of fileList) {
    const rel = normalizeSeparator(path.relative(PROJECT_ROOT, filePath));
    const parts = rel.split('/');
    const classification = classifyEntry(rel);
    const baseName = path.basename(filePath);

    const entry = {
      path: rel,
      title: trimExt(baseName),
      category: classification.category,
      group: classification.group,
      name: trimExt(baseName),
      fullPath: rel,
      lastModified: '',
      heroImages: [],
    };

    if (classification.category === 'hero') {
      entry.heroImages = await findHeroImages(classification.meta.attribute, classification.meta.hero);
    }

    try {
      const stats = await fs.stat(filePath);
      entry.lastModified = stats.mtime.toISOString();
    } catch {
      entry.lastModified = '';
    }

    result.push(entry);
  }

  const readmePaths = ['README.md', 'design-data/README.md'];
  for (const readme of readmePaths) {
    const abs = path.join(PROJECT_ROOT, readme);
    if (await fs
      .access(abs)
      .then(() => true)
      .catch(() => false)) {
      const rel = normalizeSeparator(readme);
      if (!result.some((item) => item.path === rel)) {
        result.unshift({
          path: rel,
          title: '项目说明文档',
          category: 'root',
          group: '根目录',
          name: '项目说明文档',
          lastModified: '',
          heroImages: [],
        });
      }
    }
  }

  result.sort((a, b) => {
    if (a.group !== b.group) {
      return a.group.localeCompare(b.group, 'zh-CN');
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });

  return {
    generatedAt: new Date().toISOString(),
    count: result.length,
    entries: result,
  };
}

async function sendApiError(response, statusCode, message) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify({ error: message }));
}

function safePathFromQuery(rawPath) {
  if (!rawPath) {
    return '';
  }
  const clean = path.normalize(rawPath).replace(/^(\.\.(\/|\\))+/, '');
  return clean;
}

async function readTextFile(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

function getMime(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES.get(ext) || 'application/octet-stream';
}

async function sendFile(filePath, response) {
  response.statusCode = 200;
  response.setHeader('Content-Type', getMime(filePath));
  const stream = createReadStream(filePath);
  stream.pipe(response);
}

function createApiResponse(response, data) {
  response.statusCode = 200;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  if (pathname === '/api/index') {
    try {
      const indexData = await buildDocIndex();
      createApiResponse(res, indexData);
    } catch (error) {
      await sendApiError(res, 500, error?.message || 'failed to build index');
    }
    return;
  }

  if (pathname === '/api/doc') {
    const filePath = safePathFromQuery(url.searchParams.get('path') || '');
    if (!filePath || !filePath.startsWith('design-data/')) {
      await sendApiError(res, 400, 'bad path');
      return;
    }
    const absolutePath = path.join(PROJECT_ROOT, filePath);
    const content = await readTextFile(absolutePath);
    if (content === null) {
      await sendApiError(res, 404, 'document not found');
      return;
    }

    const type = path.extname(filePath).replace('.', '') || 'txt';
    createApiResponse(res, {
      path: filePath,
      type,
      title: trimExt(path.basename(filePath)),
      content,
    });
    return;
  }

  if (pathname === '/' || pathname === '/index.html') {
    const indexPath = path.join(WEB_ROOT, 'index.html');
    await sendFile(indexPath, res);
    return;
  }

  const rel = decodeURIComponent(pathname);
  const candidatePath = path.join(PROJECT_ROOT, rel.startsWith('/') ? rel.slice(1) : rel);
  const normalizedCandidate = path.normalize(candidatePath);
  if (!normalizedCandidate.startsWith(PROJECT_ROOT)) {
    await sendApiError(res, 403, 'forbidden');
    return;
  }

  try {
    const stat = await fs.stat(normalizedCandidate);
    if (stat.isDirectory()) {
      if (pathname === '/') {
        const indexPath = path.join(WEB_ROOT, 'index.html');
        await sendFile(indexPath, res);
        return;
      }
      res.statusCode = 403;
      res.end('Directory access disabled');
      return;
    }
    await sendFile(normalizedCandidate, res);
  } catch {
    if (pathname.startsWith('/web/')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    // SPA fallback
    const indexPath = path.join(WEB_ROOT, 'index.html');
    await sendFile(indexPath, res);
  }
});

server.listen(PORT, () => {
  console.log(`Doc viewer running at http://localhost:${PORT}`);
});
