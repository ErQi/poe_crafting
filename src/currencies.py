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
    CurrencyDefinition(
        key="transmutation",
        label="蜕变石",
        template_name="currency_transmutation",
        trade_id="transmute",
        official_name="Orb of Transmutation",
    ),
    CurrencyDefinition(
        key="alteration",
        label="改造石",
        template_name="currency_alteration",
        trade_id="alt",
        official_name="Orb of Alteration",
    ),
    CurrencyDefinition(
        key="augmentation",
        label="增幅石",
        template_name="currency_augmentation",
        trade_id="aug",
        official_name="Orb of Augmentation",
    ),
    CurrencyDefinition(
        key="regal",
        label="富豪石",
        template_name="currency_regal",
        trade_id="regal",
        official_name="Regal Orb",
    ),
    CurrencyDefinition(
        key="scouring",
        label="重铸石",
        template_name="currency_scouring",
        trade_id="scour",
        official_name="Orb of Scouring",
    ),
    CurrencyDefinition(
        key="exalted",
        label="崇高石",
        template_name="currency_exalted",
        trade_id="exalted",
        official_name="Exalted Orb",
    ),
    CurrencyDefinition(
        key="annulment",
        label="剥离石",
        template_name="currency_annulment",
        trade_id="annul",
        official_name="Orb of Annulment",
    ),
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
