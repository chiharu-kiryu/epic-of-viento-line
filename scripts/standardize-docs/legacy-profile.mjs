// Import-only compatibility for historical source notation. The text parser
// itself has no character, combat-stat, directory or workspace-name rules.
import { legacyDocumentDefaults } from '../lib/document-model.mjs';

export function parserOptionsForSource(sourcePath, descriptor = {}) {
  const profile = descriptor.parserProfile || legacyDocumentDefaults(sourcePath).parserProfile;
  if (profile === 'prose') return { keyValueMode: 'prose', allowedFieldKeys: ['_header', '正文', '内容', '剧情', '正文内容'] };
  if (profile === 'legacy-hero') return {
    multilineFieldKeys: ['天生技能', '先天技能', '技能1', '技能2', '技能3', '技能4', '阳印', '阴印', '铸魔', '铸神'],
    boundaryFieldKeys: ['_header', '英雄名', '姓名', '英文名', '英文名称', '主属性', '基础攻击间隔', '基础移动速度'],
  };
  if (profile !== 'structured') throw new Error(`不支持的解析配置：${profile}`);
  return {};
}
