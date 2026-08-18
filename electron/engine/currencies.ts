export interface CurrencyDefinition {
  key: string;
  label: string;
  templateName: string;
  tradeId: string;
  officialName: string;
}

export const CURRENCIES: CurrencyDefinition[] = [
  {
    key: "transmutation",
    label: "蜕变石",
    templateName: "currency_transmutation",
    tradeId: "transmute",
    officialName: "Orb of Transmutation",
  },
  {
    key: "augmentation",
    label: "增幅石",
    templateName: "currency_augmentation",
    tradeId: "aug",
    officialName: "Orb of Augmentation",
  },
  {
    key: "alteration",
    label: "改造石",
    templateName: "currency_alteration",
    tradeId: "alt",
    officialName: "Orb of Alteration",
  },
  {
    key: "chance",
    label: "机会石",
    templateName: "currency_chance",
    tradeId: "chance",
    officialName: "Orb of Chance",
  },
  {
    key: "alchemy",
    label: "点金石",
    templateName: "currency_alchemy",
    tradeId: "alch",
    officialName: "Orb of Alchemy",
  },
  {
    key: "chaos",
    label: "混沌石",
    templateName: "currency_chaos",
    tradeId: "chaos",
    officialName: "Chaos Orb",
  },
  {
    key: "regal",
    label: "富豪石",
    templateName: "currency_regal",
    tradeId: "regal",
    officialName: "Regal Orb",
  },
  {
    key: "scouring",
    label: "重铸石",
    templateName: "currency_scouring",
    tradeId: "scour",
    officialName: "Orb of Scouring",
  },
  {
    key: "exalted",
    label: "崇高石",
    templateName: "currency_exalted",
    tradeId: "exalted",
    officialName: "Exalted Orb",
  },
  {
    key: "divine",
    label: "神圣石",
    templateName: "currency_divine",
    tradeId: "divine",
    officialName: "Divine Orb",
  },
  {
    key: "annulment",
    label: "剥离石",
    templateName: "currency_annulment",
    tradeId: "annul",
    officialName: "Orb of Annulment",
  },
  {
    key: "vaal",
    label: "瓦尔宝珠",
    templateName: "currency_vaal",
    tradeId: "vaal",
    officialName: "Vaal Orb",
  },
  {
    key: "fusing",
    label: "链接石",
    templateName: "currency_fusing",
    tradeId: "fusing",
    officialName: "Orb of Fusing",
  },
  {
    key: "jewellers",
    label: "工匠石",
    templateName: "currency_jewellers",
    tradeId: "jewellers",
    officialName: "Jeweller's Orb",
  },
  {
    key: "chromatic",
    label: "幻色石",
    templateName: "currency_chromatic",
    tradeId: "chrome",
    officialName: "Chromatic Orb",
  },
  {
    key: "gemcutter",
    label: "宝石匠棱镜",
    templateName: "currency_gemcutter",
    tradeId: "gcp",
    officialName: "Gemcutter's Prism",
  },
  {
    key: "chisel",
    label: "制图石",
    templateName: "currency_chisel",
    tradeId: "chisel",
    officialName: "Cartographer's Chisel",
  },
  {
    key: "bauble",
    label: "玻璃匠棱镜",
    templateName: "currency_bauble",
    tradeId: "bauble",
    officialName: "Glassblower's Bauble",
  },
  {
    key: "whetstone",
    label: "磨刀石",
    templateName: "currency_whetstone",
    tradeId: "whetstone",
    officialName: "Blacksmith's Whetstone",
  },
  {
    key: "scrap",
    label: "护甲片",
    templateName: "currency_scrap",
    tradeId: "scrap",
    officialName: "Armourer's Scrap",
  },
  {
    key: "blessed",
    label: "祝福石",
    templateName: "currency_blessed",
    tradeId: "blessed",
    officialName: "Blessed Orb",
  },
  {
    key: "regret",
    label: "后悔石",
    templateName: "currency_regret",
    tradeId: "regret",
    officialName: "Orb of Regret",
  },
  {
    key: "wisdom",
    label: "知识卷轴",
    templateName: "currency_wisdom",
    tradeId: "wisdom",
    officialName: "Scroll of Wisdom",
  },
  {
    key: "portal",
    label: "传送卷轴",
    templateName: "currency_portal",
    tradeId: "portal",
    officialName: "Portal Scroll",
  },
  {
    key: "mirror",
    label: "镜像",
    templateName: "currency_mirror",
    tradeId: "mirror",
    officialName: "Mirror of Kalandra",
  },
];

export const CURRENCY_BY_LABEL = Object.fromEntries(CURRENCIES.map((c) => [c.label, c]));
export const CURRENCY_BY_TEMPLATE = Object.fromEntries(CURRENCIES.map((c) => [c.templateName, c]));

const CURRENCY_STACK_COUNT_RE =
  /(?:堆\s*叠\s*数\s*量|Stack\s+Size)\s*[:：]\s*([\d,，]+)(?:\s*\/\s*[\d,，]+)?/i;

export function currencyLabel(templateName: string): string {
  return CURRENCY_BY_TEMPLATE[templateName]?.label ?? templateName;
}

export function currencyStackCount(copiedText: string): number | null {
  const match = CURRENCY_STACK_COUNT_RE.exec(copiedText || "");
  if (!match) return null;
  return parseInt(match[1].replace(/[,，]/g, ""), 10);
}
