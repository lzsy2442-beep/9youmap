// 敏感词过滤：涉黄 / 涉毒 / 涉赌 / 涉政 / 诈骗广告 / 辱骂
//
// 设计取舍：
// 1. 只做「第一道筛子」，不追求全覆盖——真正的兜底是举报 + 人工处置留痕。
// 2. 命中后不告诉用户具体是哪个词，避免被用来试探词库。
// 3. 匹配前做归一化：全角转半角、去空格/标点/符号，能挡住「赌 博」「赌.博」这类拆字。

export const WORD_GROUPS = {
  porn: [
    '色情', '黄色网站', '黄片', '成人视频', '裸聊', '裸照', '约炮', '一夜情', '性服务',
    '援交', '楼凤', '外围女', '卖淫', '嫖娼', '成人电影', '情色', '做爱', '口交', '自慰'
  ],
  drug: [
    '毒品', '吸毒', '贩毒', '冰毒', '海洛因', '摇头丸', 'k粉', '大麻', '麻古', '可卡因',
    '笑气', '飞叶子', '摇头水', '迷幻药', '上头烟', '违禁药'
  ],
  gamble: [
    '赌博', '博彩', '赌场', '网赌', '私彩', '时时彩', '六合彩', '百家乐', '盘口', '下注',
    '洗码', '赌球', '棋牌室', '代打彩票', '稳赚不赔', '包赢', '刷流水', '跑分'
  ],
  politics: [
    '颠覆国家政权', '分裂国家', '煽动颠覆', '暴力革命', '恐怖袭击', '暴恐', '法轮功',
    '邪教组织', '制爆', '恐怖组织', '反社会', '游行示威串联'
  ],
  scam: [
    '刷单', '日结兼职', '高薪兼职', '加微信领', '返利', '免费领养', '代充', '低价出号',
    '盗号', '钓鱼网站', '验证码代收', '跑腿代付'
  ],
  abuse: [
    '傻逼', '草泥马', '狗娘养', '去死吧', 'nmsl'
  ]
};

export const GROUP_LABEL = {
  porn: '色情内容',
  drug: '涉毒内容',
  gamble: '赌博内容',
  politics: '违法内容',
  scam: '诈骗广告',
  abuse: '辱骂内容'
};

/** 归一化：全角→半角、转小写、去掉空白与标点符号 */
export function normalize(text) {
  let s = String(text == null ? '' : text).toLowerCase();
  // 全角 ASCII → 半角
  s = s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  // 去掉空白、标点、符号（含零宽字符）
  s = s.replace(/[\s\u3000\u200B-\u200D\uFEFF]/g, '');
  s = s.replace(/[\p{P}\p{S}]/gu, '');
  return s;
}

// 预打平的词表：{ word: 归一化后的词, group }
const FLAT = [];
for (const [group, list] of Object.entries(WORD_GROUPS)) {
  for (const w of list) {
    const n = normalize(w);
    if (n) FLAT.push({ word: n, group });
  }
}
// 长词优先，避免短词先命中导致误判
FLAT.sort((a, b) => b.word.length - a.word.length);

/**
 * 检查一段文本
 * @returns {{hit: boolean, group?: string, message?: string}}
 */
export function checkText(text) {
  if (!text) return { hit: false };
  const s = normalize(text);
  if (!s) return { hit: false };
  for (const item of FLAT) {
    if (s.includes(item.word)) {
      return {
        hit: true,
        group: item.group,
        message: `内容里包含${GROUP_LABEL[item.group] || '违规词'}，请修改后再提交`
      };
    }
  }
  return { hit: false };
}
