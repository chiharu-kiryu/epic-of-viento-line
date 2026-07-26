import fs from 'node:fs/promises';

function defaultFormatWriteValue(normalizedValue) {
  return normalizedValue;
}

function defaultCompareValue(value) {
  return value;
}

async function runTextNormalizationBatch({
  files,
  normalizeItem,
  shouldWrite = false,
  compareValue = defaultCompareValue,
  formatWriteValue = defaultFormatWriteValue,
} = {}) {
  if (!Array.isArray(files)) {
    throw new TypeError('files 必须是数组');
  }
  if (typeof normalizeItem !== 'function') {
    throw new TypeError('normalizeItem 必须是函数');
  }

  const results = [];
  let changed = 0;

  for (const filePath of files) {
    const rawText = await fs.readFile(filePath, 'utf8');
    const normalized = await normalizeItem(filePath, rawText);
    const sourceComparable = compareValue(rawText);
    const normalizedComparable = compareValue(normalized);
    const shouldUpdate = sourceComparable !== normalizedComparable;

    if (shouldUpdate) {
      changed += 1;
    }
    results.push({
      file: filePath,
      rawText,
      normalized,
      shouldUpdate,
    });
  }

  if (shouldWrite) {
    for (const item of results) {
      if (!item.shouldUpdate) {
        continue;
      }
      await fs.writeFile(item.file, formatWriteValue(item.normalized), 'utf8');
    }
  }

  return {
    changed,
    total: files.length,
    results,
  };
}

export {
  runTextNormalizationBatch,
};
