import fs from 'node:fs/promises';
import path from 'node:path';

// Small synthetic inputs belong to tests, never to the user's active workspace.
export async function createTemplateFixture(root) {
  const templates = {
    'design-heros/模板-英雄': '名称：测试英雄\n',
    'design-item/模板-物品': '名称：测试物品\n\n属性加值：\n\n物品描述：\n',
    'design-units/模板-单位': '名称：测试单位\n',
    'design-building/模板-建筑': '名称：测试建筑\n',
    'design-skills/模板-技能': '名称：测试技能\n',
    'backstory/模板-背景故事': '# 测试故事\n\n正文。\n',
    'design-scenes/模板-场景': '名称：测试场景\n',
    'design-rules/模板-规则': '名称：测试规则\n',
    'README.md': '# 测试模板\n',
  };
  for (const [relative, content] of Object.entries(templates)) {
    const target = path.join(root, 'data-template', relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}
