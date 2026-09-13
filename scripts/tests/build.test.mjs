import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, node, write } from './helpers.mjs';

test('custom output preserves the default catalog, prunes its own stale files and excludes itself from sources', async (t) => {
  const root = await fixture(t);
  await write(root, 'design-data/design-rules/example.txt', '测试规则\n力量：1');
  await write(root, 'docs-standard/keep.json', '{"sentinel":true}');
  await write(root, 'generated/stale.json', '{"stale":true}');
  const args = ['scripts/standardize-docs.mjs', '--output', 'generated'];
  const first = await node(root, args);
  const second = await node(root, args);
  assert.equal(first.stdout, second.stdout);
  assert.equal(await fs.readFile(path.join(root, 'docs-standard/keep.json'), 'utf8'), '{"sentinel":true}');
  await assert.rejects(fs.access(path.join(root, 'generated/stale.json')));
  const result = JSON.parse(await fs.readFile(path.join(root, 'generated/design-data/design-rules/example.txt.json'), 'utf8'));
  assert.equal(result.source.path, 'design-data/design-rules/example.txt');
  await assert.rejects(fs.access(path.join(root, 'generated/generated')));
  for (const output of ['.', 'design-data', 'scripts/generated', '.viento', '.viento/cache', 'desktop', 'src-tauri']) {
    await assert.rejects(node(root, ['scripts/standardize-docs.mjs', '--output', output]), /separate from project sources/);
  }
  assert.equal(await fs.readFile(path.join(root, 'design-data/design-rules/example.txt'), 'utf8'), '测试规则\n力量：1');
});

test('no-build still standardizes selected sources without rewriting the static index', async (t) => {
  const root = await fixture(t);
  const sentinel = await fs.readFile(path.join(root, 'web/data/index.json'), 'utf8');
  await write(root, 'design-data/design-rules/example.txt', '测试规则\n力量：2');
  await node(root, ['--input-type=module', '-e', `
    import { parseSiteArgs } from './scripts/lib/site-options.mjs';
    import { rebuildIndex } from './scripts/lib/rebuild-workflow.mjs';
    const result = await rebuildIndex(parseSiteArgs(['--no-build']));
    if (!result.performedStandardize || result.performedBuild) throw new Error('Incorrect rebuild plan');
  `]);
  assert.equal(await fs.readFile(path.join(root, 'web/data/index.json'), 'utf8'), sentinel);
  await fs.access(path.join(root, 'docs-standard/design-data/design-rules/example.txt.json'));
});

test('API preflight validates the extracted request service and still rejects broken requests', async (t) => {
  const root = await fixture(t);
  const args = ['--input-type=module', '-e', `
    import { runDocApiContractPreflight } from './scripts/lib/verify-doc-api-contract.mjs';
    await runDocApiContractPreflight();
  `];
  await node(root, args);
  const service = path.join(root, 'web/modules/app-doc-service.js');
  const source = await fs.readFile(service, 'utf8');
  await fs.writeFile(service, source.replaceAll('[API_REQUEST_KEYS.path]', 'incorrectPath'));
  await assert.rejects(node(root, args), /DOCAPI-FRONTEND-SERVICE/);
});

test('static indexing rejects duplicate document identities before replacing an existing index', async (t) => {
  const root = await fixture(t);
  const sentinel = await fs.readFile(path.join(root, 'web/data/index.json'), 'utf8');
  const doc = JSON.stringify({ source: { path: 'design-data/design-rules/repeated.txt' }, meta: { category: 'rule' } });
  await write(root, 'docs-standard/a.json', doc);
  await write(root, 'docs-standard/b.json', doc);
  await assert.rejects(node(root, ['scripts/build-static-doc-site.mjs']), /文档标识重复/);
  assert.equal(await fs.readFile(path.join(root, 'web/data/index.json'), 'utf8'), sentinel);
});
