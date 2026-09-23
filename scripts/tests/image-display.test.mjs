import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, write, serve } from './helpers.mjs';
import { registerWorkspace, readRegistry } from '../lib/workspace.mjs';
import { Element, editorHarness } from './editor-harness.mjs';

const elements = new Map();
globalThis.location = { href: 'http://127.0.0.1/web/', origin: 'http://127.0.0.1' };
globalThis.document = {
  getElementById: (id) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  },
  createElement: (tag) => new Element(tag),
  createDocumentFragment: () => new Element('fragment'),
};
const helpers = await import('../../web/modules/app-helpers.js');
const { renderHeroBanner } = await import('../../web/modules/app-render.js');

function hero(overrides = {}) {
  return { category: 'hero', path: 'hero/力量/测试角色', title: '测试角色', name: '测试角色',
    meta: {}, fields: {}, heroImages: [], heroSkills: [{ key: '技能1', name: '斩击' }], ...overrides };
}

async function render(surface, doc) {
  if (surface === 'cover') {
    renderHeroBanner(doc);
    return elements.get('heroBanner').querySelector('img');
  }
  if (surface === 'list') return helpers.createDocButton(doc).querySelector('img');
  const h = await editorHarness(helpers);
  if (surface === 'skill') return h.runtime.buildHeroSkillCards(doc).querySelector('img');
  h.runtime.renderGallery(doc.heroImages, doc.title);
  return h.element('heroGallery').querySelector('img');
}

async function assets(t, files) {
  let root, registry;
  const source = Buffer.from('\uFEFF# 不改写的原文\r\n');
  t.after(async () => {
    if (!registry) return;
    assert.deepEqual(await readRegistry(root), registry);
    assert.deepEqual(await fs.readFile(path.join(root, 'design-data/原文.md')), source);
    for (const [file, content] of Object.entries(files)) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), content);
  });
  root = await fixture(t);
  await write(root, 'design-data/原文.md', source);
  for (const [file, content] of Object.entries(files)) await write(root, file, content);
  await registerWorkspace(root);
  registry = await readRegistry(root);
  const base = await serve(t, root);
  return base;
}

async function readsFile(base, image, file, content) {
  assert.ok(image);
  const url = new URL(image.src);
  assert.equal(url.protocol, 'http:', 'a real file must not be replaced by an avatar');
  // The actual renderers resolve against a fixed page origin. Adapt only its
  // ephemeral server port; keep the generated path, query and fragment intact.
  url.port = new URL(base).port;
  const response = await fetch(url);
  assert.equal(response.status, 200, image.src);
  assert.equal(await response.text(), content, 'must read the intended file, not a similar filename');
  assert.equal(url.hash, '');
  assert.equal(url.search, '');
  assert.equal(decodeURIComponent(url.pathname), `/${file}`);
}

for (const surface of ['cover', 'skill']) for (const [label, filename, decoy] of [
  ['fragment', '原画.png#定稿.png', '原画.png'],
  ['percent escape', '原画%20定稿.png', '原画 定稿.png'],
  ['literal percent', '100%原画.png', null],
  ['encoded separator text', '原画%2f定稿.png', '原画/定稿.png'],
  ['double dots', '原画..定稿.png', null],
  ['ordinary Unicode and spaces', '原画 全角Ａ 🦊.png', null],
]) test(`image display: ${surface} requests the registered ${label} filename literally`, async (t) => {
  const file = `assets/${filename}`, content = `target:${filename}`;
  const files = { [file]: content, ...(decoy ? { [`assets/${decoy}`]: 'wrong similar file' } : {}) };
  const base = await assets(t, files);
  const doc = hero({ heroImages: [file], heroSkills: [{ key: '技能1', name: '斩击', icon: file }] });
  await readsFile(base, await render(surface, doc), file, content);
  const gallery = await render('gallery', doc);
  await readsFile(base, gallery, file, content);
  await readsFile(base, await render('list', doc), file, content);
});

for (const file of ['assets/原画..定稿.png', 'assets/草案..定稿/原画.png']) test(`image display: list and gallery accept dots inside a filename or directory (${file})`, async (t) => {
  const base = await assets(t, { [file]: file });
  const doc = hero({ heroImages: [file] });
  for (const surface of ['list', 'gallery']) await readsFile(base, await render(surface, doc), file, file);
});

for (const surface of ['cover', 'skill']) for (const primary of [true, false]) test(`image display: ${surface} ${primary ? 'missing' : 'empty'} image uses a literal fallback path and ends at an avatar`, async (t) => {
  const label = '斩击#100%';
  const doc = hero({ path: 'hero/力量/角色#100%', heroImages: primary ? ['assets/missing.png'] : [],
    heroSkills: [{ key: '技能1', name: label, icon: primary ? 'assets/missing-skill.png' : '' }] });
  const fallback = surface === 'cover' ? helpers.getHeroFallbackPath(doc) : helpers.getHeroSkillImagePlaceholderPath(doc, label);
  const base = await assets(t, { [fallback]: 'fallback bytes' });
  const image = await render(surface, doc);
  if (primary) {
    const url = new URL(image.src); url.port = new URL(base).port;
    assert.equal((await fetch(url)).status, 404);
    assert.equal(typeof image.onerror, 'function');
    image.onerror();
  } else {
    assert.equal(image.className, surface === 'cover' ? 'hero-cover-placeholder' : 'hero-skill-empty');
  }
  await readsFile(base, image, fallback, 'fallback bytes');
  assert.ok(image.alt);
  image.onerror();
  assert.match(image.src, /^data:image\/svg\+xml/);
  const avatar = image.src;
  image.onerror(); image.onerror();
  assert.equal(image.src, avatar, 'an exhausted fallback chain must stop retrying');
});

test('image display: a generic document with a missing cover still gets a stable avatar', async (t) => {
  const base = await assets(t, {});
  const doc = hero({ category: 'character', path: 'character/星裔', heroImages: ['assets/missing.png'], heroSkills: [] });
  const image = await render('cover', doc);
  const url = new URL(image.src); url.port = new URL(base).port;
  assert.equal((await fetch(url)).status, 404);
  assert.equal(typeof image.onerror, 'function');
  image.onerror();
  assert.match(image.src, /^data:image\/svg\+xml/);
  const avatar = image.src;
  image.onerror();
  assert.equal(image.src, avatar);
});

test('image display: unsupported origins, backslashes and parent segments remain rejected', () => {
  for (const file of ['https://example.com/image.png', '//example.com/image.png', 'blob:unsafe', 'javascript:unsafe',
    'data:image/png;base64,AA==', 'private/image.png', 'assets/../private.png', 'assets/sub/../../private.png', 'assets/sub\\image.png']) {
    assert.equal(helpers.resolveImageUrl(file), '', file);
  }
});
