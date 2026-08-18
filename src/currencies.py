from __future__ import annotations

import re
from dataclasses import dataclass


@dataclass(frozen=True)
class CurrencyDefinition:
    key: str
    label: str
    template_name: str
    trade_id: str
    official_name: str


CURRENCIES: tuple[CurrencyDefinition, ...] = (
    CurrencyDefinition("transmutation", "蜕变石", "currency_transmutation", "transmute", "Orb of Transmutation"),
    CurrencyDefinition("augmentation", "增幅石", "currency_augmentation", "aug", "Orb of Augmentation"),
    CurrencyDefinition("alteration", "改造石", "currency_alteration", "alt", "Orb of Alteration"),
    CurrencyDefinition("chance", "机会石", "currency_chance", "chance", "Orb of Chance"),
    CurrencyDefinition("alchemy", "点金石", "currency_alchemy", "alch", "Orb of Alchemy"),
    CurrencyDefinition("chaos", "混沌石", "currency_chaos", "chaos", "Chaos Orb"),
    CurrencyDefinition("regal", "富豪石", "currency_regal", "regal", "Regal Orb"),
    CurrencyDefinition("scouring", "重铸石", "currency_scouring", "scour", "Orb of Scouring"),
    CurrencyDefinition("exalted", "崇高石", "currency_exalted", "exalted", "Exalted Orb"),
    CurrencyDefinition("divine", "神圣石", "currency_divine", "divine", "Divine Orb"),
    CurrencyDefinition("annulment", "剥离石", "currency_annulment", "annul", "Orb of Annulment"),
    CurrencyDefinition("vaal", "瓦尔宝珠", "currency_vaal", "vaal", "Vaal Orb"),
    CurrencyDefinition("fusing", "链接石", "currency_fusing", "fusing", "Orb of Fusing"),
    CurrencyDefinition("jewellers", "珠宝匠之石", "currency_jewellers", "jewellers", "Jeweller's Orb"),
    CurrencyDefinition("chromatic", "幻色石", "currency_chromatic", "chrome", "Chromatic Orb"),
    CurrencyDefinition("gemcutter", "宝石匠棱镜", "currency_gemcutter", "gcp", "Gemcutter's Prism"),
    CurrencyDefinition("chisel", "制图石", "currency_chisel", "chisel", "Cartographer's Chisel"),
    CurrencyDefinition("bauble", "玻璃匠棱镜", "currency_bauble", "bauble", "Glassblower's Bauble"),
    CurrencyDefinition("whetstone", "磨刀石", "currency_whetstone", "whetstone", "Blacksmith's Whetstone"),
    CurrencyDefinition("scrap", "护甲片", "currency_scrap", "scrap", "Armourer's Scrap"),
    CurrencyDefinition("blessed", "祝福石", "currency_blessed", "blessed", "Blessed Orb"),
    CurrencyDefinition("regret", "后悔石", "currency_regret", "regret", "Orb of Regret"),
    CurrencyDefinition("wisdom", "知识卷轴", "currency_wisdom", "wisdom", "Scroll of Wisdom"),
    CurrencyDefinition("portal", "传送卷轴", "currency_portal", "portal", "Portal Scroll"),
    CurrencyDefinition("mirror", "镜像", "currency_mirror", "mirror", "Mirror of Kalandra"),
)

CURRENCY_BY_LABEL = {currency.label: currency for currency in CURRENCIES}
CURRENCY_BY_TEMPLATE = {currency.template_name: currency for currency in CURRENCIES}

# 国服字段偶尔会在汉字之间插入空格，例如“堆 叠 数 量”。
# 同时兼容英文客户端，便于单元测试和以后切换语言。
CURRENCY_STACK_COUNT_RE = re.compile(
    r"(?:堆\s*叠\s*数\s*量|Stack\s+Size)\s*[:：]\s*([\d,，]+)"
    r"(?:\s*/\s*[\d,，]+)?",
    re.IGNORECASE,
)


def currency_label(template_name: str) -> str:
    definition = CURRENCY_BY_TEMPLATE.get(template_name)
    return definition.label if definition is not None else template_name


def currency_template(label: str) -> str:
    definition = CURRENCY_BY_LABEL.get(label)
    return definition.template_name if definition is not None else ""


def currency_stack_count(copied_text: str) -> int | None:
    """从通货 Ctrl+C 文本中读取当前堆叠数量。"""

    match = CURRENCY_STACK_COUNT_RE.search(copied_text or "")
    if match is None:
        return None
    # 国服通货页的大堆叠会复制为“1,808 / 20”；斜杠前才是
    # 实际剩余量，逗号只是千位分隔符。
    raw_count = match.group(1).replace(",", "").replace("，", "")
    return int(raw_count)
