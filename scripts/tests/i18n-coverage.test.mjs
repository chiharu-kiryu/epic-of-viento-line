import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'acorn';
import english from '../../web/i18n/en.js';
import japanese from '../../web/i18n/ja.js';
import { supportedLanguages } from '../../web/i18n/languages.js';

const root = new URL('../../', import.meta.url);
const syntax = (text) => parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (node.type) visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach((child) => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}
const parameters = (value) => [...value.matchAll(/\{\d+\}/g)].map(([text]) => text).sort();

test('native preferences and the shared browser/API registry accept the same language IDs', async () => {
  const source = await fs.readFile(new URL('src-tauri/src/preferences.rs', root), 'utf8');
  const native = [...source.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map((match) => match[1]).sort();
  assert.deepEqual(native, supportedLanguages.map(({ id }) => id).sort());
});

test('translation catalogues have identical keys, no duplicate entries and intact parameters', async () => {
  const keys = Object.keys(english).sort();
  for (const [locale, catalogue] of Object.entries({ en: english, ja: japanese })) {
    assert.deepEqual(Object.keys(catalogue).sort(), keys, `${locale}: missing or extra messages`);
    const ast = syntax(await fs.readFile(new URL(`web/i18n/${locale}.js`, root), 'utf8'));
    const entries = ast.body.find((node) => node.type === 'ExportDefaultDeclaration').declaration.properties;
    const seen = new Set();
    for (const entry of entries) {
      const key = entry.key.value;
      assert.ok(!seen.has(key), `${locale}: duplicate message ${key}`);
      seen.add(key);
    }
    for (const [key, value] of Object.entries(catalogue)) {
      assert.equal(typeof value, 'string', `${locale}: ${key}`);
      assert.ok(value.trim(), `${locale}: empty translation ${key}`);
      assert.deepEqual(parameters(value), parameters(key), `${locale}: parameters in ${key}`);
    }
  }
});

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(new URL(directory, root), { withFileTypes: true })) {
    if (entry.name === 'i18n' || entry.name === 'data' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
    const name = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(`${name}/`));
    else if (/\.(m?js|html)$/.test(name)) files.push(name);
  }
  return files;
}

test('marked interface messages are covered in English and Japanese', async () => {
  const messages = new Map();
  const add = (key, file) => { if (typeof key === 'string' && /\p{Script=Han}/u.test(key)) messages.set(key, file); };
  const leaves = (node, file) => {
    if (node?.type === 'Literal') add(node.value, file);
    else if (node?.type === 'ConditionalExpression') { leaves(node.consequent, file); leaves(node.alternate, file); }
    else if (node?.type === 'ObjectExpression') node.properties.forEach((entry) => leaves(entry.value, file));
    else if (node?.type === 'ArrayExpression') node.elements.forEach((entry) => leaves(entry, file));
    else if (node?.type === 'MemberExpression') leaves(node.object, file);
    else if (node?.type === 'LogicalExpression') { leaves(node.left, file); leaves(node.right, file); }
  };
  const files = [...await sourceFiles('engine/'), ...await sourceFiles('web/'), ...await sourceFiles('mobile/'), ...await sourceFiles('desktop/ui/'), 'web/i18n/settings.js',
    'scripts/lib/export-render.mjs', 'scripts/lib/export-package.mjs', 'scripts/lib/export-service.mjs',
    'scripts/lib/project-layout.mjs', 'scripts/lib/project-service.mjs', 'scripts/lib/doc-api-service.mjs',
    'scripts/lib/media-assets.mjs', 'scripts/lib/media-insertion.mjs', 'scripts/lib/document-field-draft.mjs'];
  for (const file of files) {
    const text = await fs.readFile(new URL(file, root), 'utf8');
    for (const match of text.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?=(["'])(.*?)\1/g)) add(match[2], file);
    if (!/\.m?js$/.test(file)) continue;
    walk(syntax(text), (node) => {
      if (node.type === 'CallExpression' && ['t', 'localize', 'uiMessage', 'userMessage', 'userError', 'exportError', 'fail', 'invalid', 'reject', 'notify'].includes(node.callee.name)) leaves(node.arguments[node.callee.name === 'reject' ? 1 : 0], file);
      if (node.type === 'TaggedTemplateExpression' && ['t', 'userMessage'].includes(node.tag.name)) {
        add(node.quasi.quasis.map((part, index) => `${index ? `{${index - 1}}` : ''}${part.value.cooked}`).join(''), file);
      }
      if (node.type === 'AssignmentExpression' && /^i18n(?:Title|Placeholder|AriaLabel)?$/.test(node.left?.property?.name || '')) leaves(node.right, file);
    });
  }
  for (const file of ['mobile_storage.rs', 'mobile_archive.rs', 'mobile_transfer.rs']) {
    const native = await fs.readFile(new URL(`src-tauri/src/${file}`, root), 'utf8');
    for (const match of native.matchAll(/error\(\s*\d+,\s*"([^"\n]+)"/g)) add(match[1], file);
  }
  const missing = [...messages].filter(([key]) => !Object.hasOwn(english, key) || !Object.hasOwn(japanese, key));
  assert.deepEqual(missing, [], 'Add each marked message to both translation catalogues');
  assert.ok(messages.size > 450, 'The audit must cover both editor and library messages');
});
