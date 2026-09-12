import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDisplayPath } from '../lib/category.mjs';

// The helpers' pure grouping functions only need the state module to initialize.
globalThis.location = { href: 'http://127.0.0.1/web/' };
globalThis.document = { getElementById: () => null };
const { getHeroDisplayDocs, getHeroCount } = await import('../../web/modules/app-helpers.js');

test('all 360 story chapters retain distinct IDs and remain individually selectable after grouping', () => {
  const docs = [];
  for (const act of ['第一幕分章', '第二幕分章', '第三幕分章']) {
    for (let chapter = 1; chapter <= 120; chapter += 1) {
      const name = `${String(chapter).padStart(3, '0')}-章节`;
      const sourcePath = `design-data/backstory/故事/${act}/${name}.md`;
      const meta = { attribute: '故事', hero: act };
      docs.push({ category: 'backstory', name, meta, source: { path: sourcePath }, path: buildDisplayPath('backstory', sourcePath, meta, name) });
    }
  }
  assert.equal(new Set(docs.map((doc) => doc.path)).size, 360);
  const displayed = getHeroDisplayDocs(docs, 'all');
  assert.equal(displayed.length, 360);
  assert.equal(getHeroCount(docs), 0, 'standalone story chapters are not characters');
  const byPath = new Map(docs.map((doc) => [doc.path, doc]));
  for (const doc of displayed) assert.equal(byPath.get(doc.path), doc);
});

test('hero profiles still link to their matching standalone backstory', () => {
  const hero = { category: 'hero', name: '英雄', path: 'hero/力量/英雄', meta: { hero: '英雄' } };
  const story = { category: 'backstory', name: '英雄', path: 'backstory/力量/英雄.txt', source: { path: 'design-data/backstory/力量/英雄.txt' }, meta: { hero: '英雄' } };
  const displayed = getHeroDisplayDocs([story, hero], 'all');
  assert.equal(displayed.length, 1);
  assert.equal(displayed[0]._linkedBackstory, story);
});
