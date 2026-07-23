export const DOC_TYPE_TEMPLATE_DEFS = {
  hero: {
    templateSource: 'data-template/design-heros/模板-英雄',
    sections: [
      {
        title: '英雄信息',
        fields: [
          { label: '英雄名', keys: ['_header', '名称', '英雄名', '角色名', 'title'] },
          { label: '别名', keys: ['别名', '别称'] },
          { label: '英文名', keys: ['英文名', '英文名称'] },
          { label: '主属性', keys: ['主属性'] },
          { label: '攻击类型', keys: ['攻击类型'] },
          { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
          { label: '攻击间隔', keys: ['基础攻击间隔', '攻击间隔'] },
          { label: '基础移动速度', keys: ['基础移动速度', '移动速度'] },
        ],
      },
      {
        title: '核心数据',
        fields: [
          { label: '生命', keys: ['生命', '生命值', '基础生命', '生命值加成'] },
          { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
          { label: '护甲', keys: ['护甲', '护甲值', '护甲上限'] },
          { label: '魔抗', keys: ['魔抗', '魔法抗性', '法抗'] },
          { label: '回血', keys: ['回血', '回血速度', '基础回血'] },
          { label: '攻速', keys: ['攻击速度', '攻速'] },
          { label: '力量', keys: ['力量'] },
          { label: '敏捷', keys: ['敏捷'] },
          { label: '智力', keys: ['智力'] },
          { label: '技能核心', keys: ['天生技能', '技能1', '技能2', '技能3', '技能4', '阳印', '阴印', '铸魔', '铸神'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  item: {
    templateSource: 'data-template/design-item/模板-物品',
    sections: [
      {
        title: '基础信息',
        fields: [
          { label: '物品名', keys: ['_header', '名称', '物品名', '简称'] },
          { label: '价格', keys: ['价格', '售价', 'Cost', 'price'] },
          { label: '类型', keys: ['类型', '物品类型'] },
          { label: '属性', keys: ['属性', '技能', '词缀', '效果'] },
          { label: '属性加成', keys: ['属性加成', '属性加值', '加成'] },
          { label: '合成', keys: ['合成', '合成材料', '合成消耗', '合成方式'] },
          { label: '合成公式', keys: ['合成公式'] },
          { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长', '补货冷却', '内置冷却'] },
          { label: '消耗', keys: ['消耗', '魔力消耗', '魔法消耗', '法力消耗'] },
          { label: '最大存货数量', keys: ['最大存货数量', '上限', '库存上限'] },
        ],
      },
      {
        title: '文本与说明',
        fields: [
          { label: '物品描述', keys: ['物品描述', '描述', '说明', '背景描述', '物品背景', '物品背景描述', '说明补充'] },
          { label: '注', keys: ['注', '注释', '备注'] },
          { label: '不包含', keys: ['不包含'] },
          { label: '携带与补给', keys: ['携带与补给机制', '携带与补给', '携带机制', '补给'] },
        ],
      },
      {
        title: '技能与特效',
        fields: [
          { label: '主动', keys: ['主动', '主动技能'] },
          { label: '被动', keys: ['被动', '被动技能'] },
          { label: '特殊效果', keys: ['特殊效果', '特性', '效果', '特殊机制'] },
        ],
      },
    ],
    includeRemaining: true,
  },

  unit: {
    templateSource: 'data-template/design-units/模板-单位',
    sections: [
      {
        title: '单位属性',
        fields: [
          { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
          { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
          { label: '攻击类型', keys: ['攻击类型'] },
          { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
          { label: '攻击间隔', keys: ['攻击间隔', '基础攻击间隔'] },
          { label: '护甲', keys: ['护甲', '护甲值'] },
          { label: '魔抗', keys: ['魔抗', '魔法抗性'] },
          { label: '回血', keys: ['回血', '回血', '回血速度', '基础回血'] },
          { label: '移动速度', keys: ['移动速度', '基础移动速度'] },
          { label: '状态抗性', keys: ['状态抗性', '状态抗性值'] },
          { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'] },
          { label: '击杀奖励', keys: ['击杀奖励'] },
          { label: '被动', keys: ['被动', '特性'] },
          { label: '主动', keys: ['主动', '技能'] },
          { label: '技能', keys: ['技能', '技能列表'] },
          { label: '魔力涌动', keys: ['魔力涌动', '魔法涌动'] },
          { label: '段落', keys: ['段落'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  building: {
    templateSource: 'data-template/design-building/模板-建筑',
    sections: [
      {
        title: '建筑属性',
        fields: [
          { label: '生命', keys: ['生命', '生命值', '基础生命', '生命上限'] },
          { label: '攻击', keys: ['攻击', '基础攻击', '攻击力'] },
          { label: '攻击类型', keys: ['攻击类型'] },
          { label: '攻击距离', keys: ['攻击距离', '攻击范围'] },
          { label: '攻击间隔', keys: ['攻击间隔', '基础攻击间隔'] },
          { label: '护甲', keys: ['护甲', '护甲值'] },
          { label: '魔抗', keys: ['魔抗', '魔法抗性'] },
          { label: '回血', keys: ['回血', '回血', '回血速度', '基础回血'] },
          { label: '击杀奖励', keys: ['击杀奖励'] },
          { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'] },
          { label: '被动', keys: ['被动', '特性'] },
          { label: '特殊效果', keys: ['特殊效果', '技能', '附魔'] },
          { label: '段落', keys: ['段落'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  skill: {
    templateSource: 'data-template/design-skills/模板-技能',
    sections: [
      {
        title: '技能机制',
        fields: [
          { label: '技能类型', keys: ['类型', '技能类型'] },
          { label: '伤害', keys: ['伤害', '每次伤害', '基础伤害'] },
          { label: '冷却', keys: ['冷却', '冷却时间', '冷却时长'] },
          { label: '消耗', keys: ['消耗', '魔力消耗', '魔法消耗', '法力消耗'] },
          { label: '施法距离', keys: ['施法距离', '最大施法距离', '距离'] },
          { label: '作用范围', keys: ['作用范围', '范围', '施法范围'] },
          { label: '持续时间', keys: ['持续时间', '持续'] },
          { label: '前摇', keys: ['前摇', '前置时间'] },
          { label: '公式', keys: ['公式', '效果', '伤害公式'] },
          { label: '异常/例外', keys: ['异常', '例外', '说明'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  backstory: {
    templateSource: 'data-template/backstory/模板-背景故事',
    sections: [
      {
        title: '背景主线',
        fields: [
          { label: '正文', keys: ['正文', '内容', '剧情', '正文内容'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  scene: {
    templateSource: 'data-template/design-scenes/模板-场景',
    sections: [
      {
        title: '场景说明',
        fields: [
          { label: '标题', keys: ['_header', '标题', '名称', '场景名'] },
          { label: '场景定位', keys: ['场景定位', '定位'] },
          { label: '地貌或环境特征', keys: ['地貌或环境特征', '地貌', '环境特征'] },
          { label: '玩法关联', keys: ['玩法关联', '玩法'] },
          { label: '连接关系', keys: ['连接关系', '连接'] },
        ],
      },
    ],
    includeRemaining: false,
  },

  rule: {
    templateSource: 'data-template/design-rules/模板-规则',
    sections: [
      {
        title: '规则公式',
        fields: [
          { label: '规则名称', keys: ['_header', '标题', '名称', '规则名'] },
          { label: '基础参数', keys: ['力量', '敏捷', '智力', '基础参数'] },
          { label: '说明', keys: ['说明', '内容', '备注'] },
          { label: '作用范围', keys: ['作用范围', '范围'] },
          { label: '公式', keys: ['公式', '数值'] },
          { label: '异常/例外', keys: ['异常', '例外', '异常/例外'] },
        ],
      },
    ],
    includeRemaining: true,
  },

  template: {
    templateSource: 'data-template/README.md',
    sections: [],
    includeRemaining: true,
  },
};

export const getDocTemplate = (category = 'other') => DOC_TYPE_TEMPLATE_DEFS[category] || null;
