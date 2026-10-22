/**
 * money.ts — the currency of the tariff figures and the one money formatter (v1.191.0, S5c / CA14).
 *
 * TARIFF_CURRENCY (ISO 4217, optional) names the currency every tariff figure is in. Cents stay
 * hundredths of that unit. Unset is USD, and the text is exactly today's: `$1.89`, `1234¢`.
 *
 * It is an option and is not derived from Home Assistant on purpose: changing the unit of a money
 * sensor on a running install changes a long-term statistic's unit, which Home Assistant asks the user
 * to repair. A code that is not in CURRENCIES keeps USD (the unit Home Assistant already has) and raises
 * a repair issue (tariff.ts tariffRepairIssues); it never invents a unit.
 *
 * CURRENCIES is also the discovery audit's list of units that denote an amount of money
 * (mqttDiscovery.ts CURRENCY_UNITS), so every accepted currency is covered by the
 * currency-needs-monetary-total rule.
 */
import { option } from './config.js';

/** The ISO 4217 codes the add-on knows how to label. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD'] as const;
export type Currency = (typeof CURRENCIES)[number];

/** The symbol before an amount, and the suffix of a figure in hundredths of the unit. */
const SYMBOLS: Readonly<Record<Currency, { major: string; minor: string }>> = Object.freeze({
  USD: { major: '$', minor: '¢' },
  CAD: { major: '$', minor: '¢' },
  AUD: { major: '$', minor: 'c' },
  EUR: { major: '€', minor: 'c' },
  GBP: { major: '£', minor: 'p' },
});

export interface CurrencyResolution {
  /** The currency the figures are labelled in (USD when unset or unknown). */
  code: Currency;
  /** TARIFF_CURRENCY was set. */
  set: boolean;
  /** Why a set value was not used, or null. */
  error: string | null;
}

/** TARIFF_CURRENCY, resolved (case-insensitive). Read at call time. */
export function tariffCurrency(): CurrencyResolution {
  const raw = option<string | null>('TARIFF_CURRENCY');
  if (raw == null) return { code: 'USD', set: false, error: null };
  const up = raw.toUpperCase();
  if ((CURRENCIES as readonly string[]).includes(up)) return { code: up as Currency, set: true, error: null };
  return { code: 'USD', set: true, error: `TARIFF_CURRENCY ${JSON.stringify(raw)} is not one of ${CURRENCIES.join(', ')}; the money units stay USD` };
}

/** The symbol of the currency in effect (`$` when unset). */
export function moneySymbol(): string {
  return SYMBOLS[tariffCurrency().code].major;
}

/** An amount in the currency's unit: `$1.89` (the sign stays after the symbol, as the text always had it). */
export function fmtMoney(amount: number, digits = 2): string {
  return `${moneySymbol()}${amount.toFixed(digits)}`;
}

/** A figure in hundredths of the unit, as given: `1234¢` (`1234c` in EUR, `1234p` in GBP). */
export function fmtMinor(minorUnits: number | string): string {
  return `${minorUnits}${SYMBOLS[tariffCurrency().code].minor}`;
}
