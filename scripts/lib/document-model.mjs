// Portable document identity and ownership. Content layout belongs to the parser,
// never to a document type or to an application's game-specific field list.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const PARSER_PROFILES = ['structured', 'prose', 'legacy-hero'];

export function legacyDocumentDefaults(sourcePath = '') {
  const parts = sourcePath.replace(/^docs-standard\//, '').split('/');
  const domain = parts[0] === 'design-data' ? parts[1] : '';
  const types = {
    'design-heros': 'character', characters: 'character',
    backstory: 'story', stories: 'story',
    'design-item': 'item', items: 'item', 'design-skills': 'skill',
    'design-units': 'unit', 'design-building': 'building',
    'design-scenes': 'scene', 'design-rules': 'rule', 'design-template': 'template',
  };
  return {
    documentType: Object.hasOwn(types, domain) ? types[domain] : 'document',
    parserProfile: domain === 'design-heros' ? 'legacy-hero'
      : ['backstory', 'stories'].includes(domain) ? 'prose' : 'structured',
  };
}

export function validateDocumentModels(records) {
  const byId = new Map(records.map((record) => [record.id, record]));
  for (const record of records) {
    if (record.documentType !== undefined && (typeof record.documentType !== 'string'
      || !record.documentType.trim() || record.documentType.length > 120)) throw new Error(`无效的文档类型：${record.sourcePath}`);
    if (record.parserProfile !== undefined && !PARSER_PROFILES.includes(record.parserProfile)) throw new Error(`不支持的解析配置：${record.sourcePath}`);
    if (record.relations === undefined) continue;
    if (!Array.isArray(record.relations)) throw new Error(`文档关系必须为数组：${record.sourcePath}`);
    const seen = new Set();
    for (const relation of record.relations) {
      if (!relation || typeof relation.kind !== 'string' || !relation.kind.trim()
        || !UUID.test(relation.targetId) || !byId.has(relation.targetId)
        || (relation.slot !== undefined && typeof relation.slot !== 'string')) throw new Error(`无效的文档关系：${record.sourcePath}`);
      const key = `${relation.kind}:${relation.targetId}`;
      if (seen.has(key)) throw new Error(`重复的文档关系：${record.sourcePath}`);
      seen.add(key);
    }
  }
  const complete = new Set(), active = new Set();
  function visit(record) {
    if (complete.has(record.id)) return;
    if (active.has(record.id)) throw new Error(`文档归属存在循环：${record.sourcePath}`);
    active.add(record.id);
    for (const relation of record.relations || []) if (relation.kind === 'part-of') visit(byId.get(relation.targetId));
    active.delete(record.id);
    complete.add(record.id);
  }
  records.forEach(visit);
}

// This is an explicit legacy import, not a name-based runtime join. Ambiguous
// matches remain independent until the workspace supplies an exact mapping.
export function planLegacyDocumentModels(records, sharedOwners = {}) {
  const bySource = new Map(records.map((record) => [record.sourcePath, record]));
  const heroKeys = new Map();
  const stem = (name) => name.replace(/\.(md|txt|json|ya?ml)$/i, '');
  for (const record of records) {
    const match = record.sourcePath.match(/^design-data\/design-heros\/([^/]+)\/([^/]+)$/);
    if (!match) continue;
    const key = `${match[1]}/${stem(match[2])}`;
    heroKeys.set(key, [...(heroKeys.get(key) || []), record]);
  }
  for (const [source, owners] of Object.entries(sharedOwners)) {
    if (!bySource.has(source) || !Array.isArray(owners) || !owners.length
      || owners.some((owner) => !bySource.has(owner))) throw new Error(`无效的显式归属映射：${source}`);
  }
  const unresolved = [];
  const documents = records.map((record) => {
    const next = { ...legacyDocumentDefaults(record.sourcePath), ...record };
    if (record.relations !== undefined) return next;
    let owners = (sharedOwners[record.sourcePath] || []).map((source) => bySource.get(source));
    const match = record.sourcePath.match(/^design-data\/backstory\/([^/]+)\/([^/]+)$/);
    if (!owners.length && match && match[1] !== '故事') {
      const candidates = heroKeys.get(`${match[1]}/${stem(match[2])}`) || [];
      if (candidates.length === 1) owners = candidates;
      else unresolved.push({ sourcePath: record.sourcePath, reason: candidates.length ? 'ambiguous-owner' : 'missing-owner' });
    }
    next.relations = [...new Map(owners.map((owner) => [owner.id, owner])).values()]
      .map((owner) => ({ kind: 'part-of', targetId: owner.id, slot: '背景故事' }));
    return next;
  });
  validateDocumentModels(documents);
  return { documents, unresolved };
}

export function attachDocumentHierarchy(docs) {
  const byId = new Map(docs.filter((doc) => doc.id).map((doc) => [doc.id, doc]));
  const describe = (doc, slot) => ({ id: doc.id, path: doc.path, title: doc.title || doc.name, slot });
  for (const doc of docs) { doc.owners = []; doc.ownedDocuments = []; }
  for (const doc of docs) {
    for (const relation of doc.relations || []) {
      if (relation.kind !== 'part-of') continue;
      const owner = byId.get(relation.targetId);
      // A temporarily missing source must not make its children disappear.
      if (!owner) continue;
      doc.owners.push(describe(owner, relation.slot || '附属内容'));
      owner.ownedDocuments.push(describe(doc, relation.slot || '附属内容'));
    }
  }
  return docs;
}
