from __future__ import annotations

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


def currency_label(template_name: str) -> str:
    definition = CURRENCY_BY_TEMPLATE.get(template_name)
    return definition.label if definition is not None else template_name


def currency_template(label: str) -> str:
    definition = CURRENCY_BY_LABEL.get(label)
    return definition.template_name if definition is not None else ""
