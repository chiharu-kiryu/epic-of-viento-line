import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, node, write } from './helpers.mjs';

test('templates accept arbitrary OC fields, ignore sidecars and reject malformed structured input', async (t) => {
  const root = await fixture(t);
  for (const category of ['hero', 'item', 'unit', 'building', 'skill', 'backstory', 'scene', 'rule']) {
    const fields = category === 'item' ? { 属性加成: '10', 物品背景描述: '背景' }
      : category === 'backstory' ? { '他问': '这是什么？' } : {};
    for (let i = 0; i < 2; i += 1) {
      await write(root, `docs-standard/design-data/${category}-${i}.json`, JSON.stringify({ meta: { category }, fields }));
    }
  }
  await write(root, 'data-template/design-item/._模板-物品', Buffer.from('00051607', 'hex'));
  await node(root, ['scripts/validate-data-template-alignment.mjs', '--strict']);
  for (let i = 0; i < 2; i += 1) {
    await write(root, `docs-standard/design-data/item-${i}.json`, JSON.stringify({ meta: { category: 'item' }, fields: { 未定义的装备参数: '100' } }));
  }
  await write(root, 'data-template/自定义世界/物种.json', '{"灵魂数量":0,"可繁衍":false}');
  await node(root, ['scripts/validate-data-template-alignment.mjs', '--strict']);
  await write(root, 'data-template/自定义世界/物种.json', '{"灵魂数量":}');
  await assert.rejects(node(root, ['scripts/validate-data-template-alignment.mjs', '--strict']), /模板解析失败.*物种.json/);
});
