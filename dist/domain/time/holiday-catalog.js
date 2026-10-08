// Canonical facts/rules from user-approved TIME layout v8.
// Upstream reference: time-keyword-memory@f8fd6b9f1728ded0e46500fe05ad0e72e92624e0.
// No preview seed state or runtime network dependency.
const source = {
  "packs": [
    {
      "id": "traditional-cn",
      "name": "中国传统节日",
      "modern": true,
      "fictional": true,
      "defaultSelected": true
    },
    {
      "id": "solar-terms",
      "name": "二十四节气",
      "modern": true,
      "fictional": false,
      "defaultSelected": true
    },
    {
      "id": "modern-common",
      "name": "现代常用节日",
      "modern": true,
      "fictional": false,
      "defaultSelected": true
    },
    {
      "id": "western-common",
      "name": "西方常见节日",
      "modern": true,
      "fictional": false,
      "defaultSelected": false
    }
  ],
  "templates": [
    {
      "id": "cn-spring-festival",
      "packId": "traditional-cn",
      "name": "春节",
      "rule": {
        "type": "lunar",
        "month": 1,
        "day": 1
      },
      "fact": "常见习俗包括团圆、拜年和新年祝福。"
    },
    {
      "id": "cn-lantern-festival",
      "packId": "traditional-cn",
      "name": "元宵",
      "rule": {
        "type": "lunar",
        "month": 1,
        "day": 15
      },
      "fact": "常见习俗包括赏灯、猜灯谜和吃元宵或汤圆。"
    },
    {
      "id": "cn-qingming",
      "packId": "traditional-cn",
      "name": "清明",
      "rule": {
        "type": "solar-term",
        "name": "清明"
      },
      "fact": "常见习俗包括祭扫、踏青与缅怀先人。"
    },
    {
      "id": "cn-dragon-boat",
      "packId": "traditional-cn",
      "name": "端午",
      "rule": {
        "type": "lunar",
        "month": 5,
        "day": 5
      },
      "fact": "常见习俗包括吃粽子、赛龙舟和佩香囊。"
    },
    {
      "id": "cn-qixi",
      "packId": "traditional-cn",
      "name": "七夕",
      "rule": {
        "type": "lunar",
        "month": 7,
        "day": 7
      },
      "fact": "与牛郎织女传说相关，常用于表达感情。"
    },
    {
      "id": "cn-ghost-festival",
      "packId": "traditional-cn",
      "name": "中元",
      "rule": {
        "type": "lunar",
        "month": 7,
        "day": 15
      },
      "fact": "传统上常用于祭祖与追思。"
    },
    {
      "id": "cn-mid-autumn",
      "packId": "traditional-cn",
      "name": "中秋",
      "rule": {
        "type": "lunar",
        "month": 8,
        "day": 15
      },
      "fact": "常见习俗包括赏月、吃月饼和家人团聚。"
    },
    {
      "id": "cn-double-ninth",
      "packId": "traditional-cn",
      "name": "重阳",
      "rule": {
        "type": "lunar",
        "month": 9,
        "day": 9
      },
      "fact": "常见习俗包括登高、赏菊和敬老。"
    },
    {
      "id": "cn-laba",
      "packId": "traditional-cn",
      "name": "腊八",
      "rule": {
        "type": "lunar",
        "month": 12,
        "day": 8
      },
      "fact": "常见习俗包括喝腊八粥。"
    },
    {
      "id": "cn-little-new-year",
      "packId": "traditional-cn",
      "name": "小年",
      "rule": {
        "type": "lunar",
        "month": 12,
        "day": 23
      },
      "fact": "日期和习俗因地区而异，常见于腊月二十三或二十四。"
    },
    {
      "id": "cn-new-years-eve",
      "packId": "traditional-cn",
      "name": "除夕",
      "rule": {
        "type": "lunar-year-end"
      },
      "fact": "农历年最后一天，常见习俗包括年夜饭、守岁和迎接新年。"
    },
    {
      "id": "solar-term-小寒",
      "packId": "solar-terms",
      "name": "小寒",
      "rule": {
        "type": "solar-term",
        "name": "小寒"
      },
      "fact": ""
    },
    {
      "id": "solar-term-大寒",
      "packId": "solar-terms",
      "name": "大寒",
      "rule": {
        "type": "solar-term",
        "name": "大寒"
      },
      "fact": ""
    },
    {
      "id": "solar-term-立春",
      "packId": "solar-terms",
      "name": "立春",
      "rule": {
        "type": "solar-term",
        "name": "立春"
      },
      "fact": ""
    },
    {
      "id": "solar-term-雨水",
      "packId": "solar-terms",
      "name": "雨水",
      "rule": {
        "type": "solar-term",
        "name": "雨水"
      },
      "fact": ""
    },
    {
      "id": "solar-term-惊蛰",
      "packId": "solar-terms",
      "name": "惊蛰",
      "rule": {
        "type": "solar-term",
        "name": "惊蛰"
      },
      "fact": ""
    },
    {
      "id": "solar-term-春分",
      "packId": "solar-terms",
      "name": "春分",
      "rule": {
        "type": "solar-term",
        "name": "春分"
      },
      "fact": ""
    },
    {
      "id": "solar-term-清明",
      "packId": "solar-terms",
      "name": "清明",
      "rule": {
        "type": "solar-term",
        "name": "清明"
      },
      "fact": ""
    },
    {
      "id": "solar-term-谷雨",
      "packId": "solar-terms",
      "name": "谷雨",
      "rule": {
        "type": "solar-term",
        "name": "谷雨"
      },
      "fact": ""
    },
    {
      "id": "solar-term-立夏",
      "packId": "solar-terms",
      "name": "立夏",
      "rule": {
        "type": "solar-term",
        "name": "立夏"
      },
      "fact": ""
    },
    {
      "id": "solar-term-小满",
      "packId": "solar-terms",
      "name": "小满",
      "rule": {
        "type": "solar-term",
        "name": "小满"
      },
      "fact": ""
    },
    {
      "id": "solar-term-芒种",
      "packId": "solar-terms",
      "name": "芒种",
      "rule": {
        "type": "solar-term",
        "name": "芒种"
      },
      "fact": ""
    },
    {
      "id": "solar-term-夏至",
      "packId": "solar-terms",
      "name": "夏至",
      "rule": {
        "type": "solar-term",
        "name": "夏至"
      },
      "fact": ""
    },
    {
      "id": "solar-term-小暑",
      "packId": "solar-terms",
      "name": "小暑",
      "rule": {
        "type": "solar-term",
        "name": "小暑"
      },
      "fact": ""
    },
    {
      "id": "solar-term-大暑",
      "packId": "solar-terms",
      "name": "大暑",
      "rule": {
        "type": "solar-term",
        "name": "大暑"
      },
      "fact": ""
    },
    {
      "id": "solar-term-立秋",
      "packId": "solar-terms",
      "name": "立秋",
      "rule": {
        "type": "solar-term",
        "name": "立秋"
      },
      "fact": ""
    },
    {
      "id": "solar-term-处暑",
      "packId": "solar-terms",
      "name": "处暑",
      "rule": {
        "type": "solar-term",
        "name": "处暑"
      },
      "fact": ""
    },
    {
      "id": "solar-term-白露",
      "packId": "solar-terms",
      "name": "白露",
      "rule": {
        "type": "solar-term",
        "name": "白露"
      },
      "fact": ""
    },
    {
      "id": "solar-term-秋分",
      "packId": "solar-terms",
      "name": "秋分",
      "rule": {
        "type": "solar-term",
        "name": "秋分"
      },
      "fact": ""
    },
    {
      "id": "solar-term-寒露",
      "packId": "solar-terms",
      "name": "寒露",
      "rule": {
        "type": "solar-term",
        "name": "寒露"
      },
      "fact": ""
    },
    {
      "id": "solar-term-霜降",
      "packId": "solar-terms",
      "name": "霜降",
      "rule": {
        "type": "solar-term",
        "name": "霜降"
      },
      "fact": ""
    },
    {
      "id": "solar-term-立冬",
      "packId": "solar-terms",
      "name": "立冬",
      "rule": {
        "type": "solar-term",
        "name": "立冬"
      },
      "fact": ""
    },
    {
      "id": "solar-term-小雪",
      "packId": "solar-terms",
      "name": "小雪",
      "rule": {
        "type": "solar-term",
        "name": "小雪"
      },
      "fact": ""
    },
    {
      "id": "solar-term-大雪",
      "packId": "solar-terms",
      "name": "大雪",
      "rule": {
        "type": "solar-term",
        "name": "大雪"
      },
      "fact": ""
    },
    {
      "id": "solar-term-冬至",
      "packId": "solar-terms",
      "name": "冬至",
      "rule": {
        "type": "solar-term",
        "name": "冬至"
      },
      "fact": ""
    },
    {
      "id": "modern-new-year",
      "packId": "modern-common",
      "name": "元旦",
      "rule": {
        "type": "fixed",
        "month": 1,
        "day": 1
      },
      "fact": "公历新年第一天，宜称“元旦快乐”。"
    },
    {
      "id": "modern-labour",
      "packId": "modern-common",
      "name": "劳动节",
      "rule": {
        "type": "fixed",
        "month": 5,
        "day": 1
      },
      "fact": "向劳动者与劳动成果表达尊重。"
    },
    {
      "id": "modern-children",
      "packId": "modern-common",
      "name": "儿童节",
      "rule": {
        "type": "fixed",
        "month": 6,
        "day": 1
      },
      "fact": "关注儿童的节日。"
    },
    {
      "id": "modern-teachers",
      "packId": "modern-common",
      "name": "教师节",
      "rule": {
        "type": "fixed",
        "month": 9,
        "day": 10
      },
      "fact": "向教师表达感谢与尊重。"
    },
    {
      "id": "modern-national",
      "packId": "modern-common",
      "name": "国庆节",
      "rule": {
        "type": "fixed",
        "month": 10,
        "day": 1
      },
      "fact": "中华人民共和国国庆日。"
    },
    {
      "id": "western-valentine",
      "packId": "western-common",
      "name": "情人节",
      "rule": {
        "type": "fixed",
        "month": 2,
        "day": 14
      },
      "fact": "常用于表达爱意或感谢。"
    },
    {
      "id": "western-halloween",
      "packId": "western-common",
      "name": "万圣节",
      "rule": {
        "type": "fixed",
        "month": 10,
        "day": 31
      },
      "fact": "常见元素包括装扮、南瓜灯和糖果，不等同于中国过年。"
    },
    {
      "id": "western-christmas",
      "packId": "western-common",
      "name": "圣诞节",
      "rule": {
        "type": "fixed",
        "month": 12,
        "day": 25
      },
      "fact": "常见元素包括圣诞树、礼物和圣诞祝福，不套用春节习俗。"
    }
  ],
  "notice": "内置节日与习俗根据公开资料汇总整理，仅供故事创作参考。不同地区、年代及家庭习惯可能存在差异；内容可以修改，每个节日可单独选择是否提醒。"
};
export const HOLIDAY_CATEGORIES=Object.freeze(['中国传统节日','现代常见节日','西方常见节日','节气','自定义节日']);
export const holidayCatalog=()=>structuredClone(source);
export const holidayTemplates=()=>structuredClone(source.templates);
