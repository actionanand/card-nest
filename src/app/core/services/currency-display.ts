export interface CountryCurrencyOption {
  readonly countryCode: string;
  readonly countryName: string;
  readonly currencyCode: string;
}

const COUNTRY_CURRENCY_DATA = `
AD:EUR AE:AED AF:AFN AG:XCD AL:ALL AM:AMD AO:AOA AR:ARS AT:EUR AU:AUD AZ:AZN
BA:BAM BB:BBD BD:BDT BE:EUR BF:XOF BG:BGN BH:BHD BI:BIF BJ:XOF BN:BND BO:BOB BR:BRL BS:BSD BT:BTN BW:BWP BY:BYN BZ:BZD
CA:CAD CD:CDF CF:XAF CG:XAF CH:CHF CI:XOF CL:CLP CM:XAF CN:CNY CO:COP CR:CRC CU:CUP CV:CVE CY:EUR CZ:CZK
DE:EUR DJ:DJF DK:DKK DM:XCD DO:DOP DZ:DZD
EC:USD EE:EUR EG:EGP ER:ERN ES:EUR ET:ETB
FI:EUR FJ:FJD FM:USD FR:EUR
GA:XAF GB:GBP GD:XCD GE:GEL GH:GHS GM:GMD GN:GNF GQ:XAF GR:EUR GT:GTQ GW:XOF GY:GYD
HK:HKD HN:HNL HR:EUR HT:HTG HU:HUF
ID:IDR IE:EUR IL:ILS IN:INR IQ:IQD IR:IRR IS:ISK IT:EUR
JM:JMD JO:JOD JP:JPY
KE:KES KG:KGS KH:KHR KI:AUD KM:KMF KN:XCD KP:KPW KR:KRW KW:KWD KZ:KZT
LA:LAK LB:LBP LC:XCD LI:CHF LK:LKR LR:LRD LS:LSL LT:EUR LU:EUR LV:EUR LY:LYD
MA:MAD MC:EUR MD:MDL ME:EUR MG:MGA MH:USD MK:MKD ML:XOF MM:MMK MN:MNT MR:MRU MT:EUR MU:MUR MV:MVR MW:MWK MX:MXN MY:MYR MZ:MZN
NA:NAD NE:XOF NG:NGN NI:NIO NL:EUR NO:NOK NP:NPR NR:AUD NZ:NZD
OM:OMR
PA:PAB PE:PEN PG:PGK PH:PHP PK:PKR PL:PLN PS:ILS PT:EUR PW:USD PY:PYG
QA:QAR
RO:RON RS:RSD RU:RUB RW:RWF
SA:SAR SB:SBD SC:SCR SD:SDG SE:SEK SG:SGD SI:EUR SK:EUR SL:SLE SM:EUR SN:XOF SO:SOS SR:SRD SS:SSP ST:STN SV:USD SY:SYP SZ:SZL
TD:XAF TG:XOF TH:THB TJ:TJS TL:USD TM:TMT TN:TND TO:TOP TR:TRY TT:TTD TV:AUD TW:TWD TZ:TZS
UA:UAH UG:UGX US:USD UY:UYU UZ:UZS
VA:EUR VC:XCD VE:VES VN:VND VU:VUV
WS:WST XK:EUR
YE:YER
ZA:ZAR ZM:ZMW ZW:USD
`;

const FALLBACK_REGION_NAMES: Readonly<Record<string, string>> = {
  CD: 'DR Congo',
  CG: 'Congo',
  CI: 'Côte d’Ivoire',
  FM: 'Micronesia',
  GB: 'United Kingdom',
  KR: 'South Korea',
  KP: 'North Korea',
  LA: 'Laos',
  MD: 'Moldova',
  MK: 'North Macedonia',
  RU: 'Russia',
  SY: 'Syria',
  TL: 'Timor-Leste',
  TW: 'Taiwan',
  TZ: 'Tanzania',
  US: 'United States',
  VA: 'Vatican City',
  VE: 'Venezuela',
};

const regionNames = createDisplayNames('region');
const currencyNames = createDisplayNames('currency');

export const COUNTRY_CURRENCY_OPTIONS: readonly CountryCurrencyOption[] =
  COUNTRY_CURRENCY_DATA.trim()
    .split(/\s+/)
    .map((entry) => {
      const [countryCode, currencyCode] = entry.split(':');
      return {
        countryCode,
        countryName:
          regionNames?.of(countryCode) ?? FALLBACK_REGION_NAMES[countryCode] ?? countryCode,
        currencyCode,
      };
    })
    .sort((left, right) => left.countryName.localeCompare(right.countryName, 'en'));

export const DISPLAY_CURRENCY_CODES: readonly string[] = [
  ...new Set(COUNTRY_CURRENCY_OPTIONS.map((option) => option.currencyCode)),
].sort((left, right) => currencyLabel(left).localeCompare(currencyLabel(right), 'en'));

let activeCountryCode = 'IN';
let activeCurrencyCode = 'INR';

export function configureMoneyDisplay(countryCode: string, currencyCode: string): void {
  activeCountryCode = countryOption(countryCode)?.countryCode ?? 'IN';
  activeCurrencyCode = DISPLAY_CURRENCY_CODES.includes(currencyCode) ? currencyCode : 'INR';
}

export function preferredMoneyCountry(): string {
  return activeCountryCode;
}

export function preferredMoneyCurrency(): string {
  return activeCurrencyCode;
}

export function isSupportedDisplayCurrency(currencyCode: string): boolean {
  return DISPLAY_CURRENCY_CODES.includes(currencyCode);
}

export function preferredMoneyLocale(): string {
  return activeCountryCode === 'IN' ? 'en-IN' : `en-${activeCountryCode}`;
}

export function countryOption(countryCode: string): CountryCurrencyOption | undefined {
  return COUNTRY_CURRENCY_OPTIONS.find((option) => option.countryCode === countryCode);
}

const REPRESENTATIVE_COUNTRY_BY_CURRENCY: Readonly<Record<string, string>> = {
  AUD: 'AU',
  CHF: 'CH',
  EUR: 'DE',
  GBP: 'GB',
  ILS: 'IL',
  USD: 'US',
  XAF: 'CM',
  XCD: 'AG',
  XOF: 'SN',
};

export function countryOptionForCurrency(
  currencyCode: string,
  preferredCountryCode?: string,
): CountryCurrencyOption | undefined {
  const matchingOptions = COUNTRY_CURRENCY_OPTIONS.filter(
    (option) => option.currencyCode === currencyCode,
  );
  if (matchingOptions.length === 0) return undefined;

  const preferredOption = matchingOptions.find(
    (option) => option.countryCode === preferredCountryCode,
  );
  if (preferredOption) return preferredOption;

  const representativeCountry = REPRESENTATIVE_COUNTRY_BY_CURRENCY[currencyCode];
  return (
    matchingOptions.find((option) => option.countryCode === representativeCountry) ??
    matchingOptions.find((option) => option.countryCode === currencyCode.slice(0, 2)) ??
    matchingOptions[0]
  );
}

export function currencyLabel(currencyCode: string): string {
  return currencyNames?.of(currencyCode) ?? currencyCode;
}

export function currencySymbol(currencyCode: string, countryCode = 'US'): string {
  try {
    const part = new Intl.NumberFormat(countryCode === 'IN' ? 'en-IN' : `en-${countryCode}`, {
      style: 'currency',
      currency: currencyCode,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    })
      .formatToParts(0)
      .find((item) => item.type === 'currency')?.value;
    return part && part !== currencyCode ? part : currencyCode;
  } catch {
    return currencyCode;
  }
}

function createDisplayNames(type: 'region' | 'currency'): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames(['en'], { type });
  } catch {
    return null;
  }
}
