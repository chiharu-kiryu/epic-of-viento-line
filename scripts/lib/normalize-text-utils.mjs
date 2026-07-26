function toUnixLineEndings(text) {
  return String(text || '').replace(/\r\n?/g, '\n');
}

function stripBom(text, mode = 'leading') {
  if (mode === 'all') {
    return text.replace(/\uFEFF/g, '');
  }
  return text.replace(/^\uFEFF/, '');
}

function normalizeForCompare(text, {
  stripBomMode = 'leading',
  collapseLineTailSpaces = true,
  trimMode = 'trim',
} = {}) {
  let normalized = toUnixLineEndings(text);
  normalized = stripBom(normalized, stripBomMode);

  if (collapseLineTailSpaces) {
    normalized = normalized.replace(/[ \t]+\n/g, '\n');
  }

  if (trimMode === 'trimEnd') {
    normalized = normalized.trimEnd();
  } else if (trimMode === 'trimStart') {
    normalized = normalized.trimStart();
  } else if (trimMode === 'trim') {
    normalized = normalized.trim();
  } else if (trimMode === 'none') {
    // preserve raw text boundaries
  }

  return normalized;
}

export {
  toUnixLineEndings,
  normalizeForCompare,
};
