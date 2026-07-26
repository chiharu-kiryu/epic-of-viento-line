function buildBackstoryPayload(standardDoc) {
  return {
    source: standardDoc.source?.path || '',
    category: 'backstory',
    group: standardDoc.meta?.group || '',
    title: standardDoc.meta?.title || '',
    purpose: standardDoc.meta?.purpose || '',
    meta: {
      ...(standardDoc.meta || {}),
      category: 'backstory',
    },
    fields: standardDoc.fields || {},
    sections: standardDoc.sections || [],
    outline: standardDoc.outline || [],
    blocks: standardDoc.blocks || [],
    parser: standardDoc.parser || {},
    parserStats: standardDoc.parserStats || null,
    rawPath: standardDoc.rawPath || '',
    raw: standardDoc.raw || '',
  };
}

function attachBackstory(heroDoc, backstoryDoc) {
  if (!heroDoc || !backstoryDoc || backstoryDoc.meta?.category !== 'backstory') {
    return heroDoc;
  }

  const normalizedHero = { ...heroDoc };
  normalizedHero.meta = {
    ...normalizedHero.meta,
    hasBackstory: true,
    backstorySource: backstoryDoc.source?.path || backstoryDoc.rawPath || '',
    purpose: normalizedHero.meta?.purpose,
  };
  normalizedHero.backstory = buildBackstoryPayload(backstoryDoc);
  return normalizedHero;
}

export {
  buildBackstoryPayload,
  attachBackstory,
};
