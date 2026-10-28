import { execFileSync } from 'node:child_process';

// Run the actual helper bodies in an isolated Node process. An Intl mock cannot change Date getters.
const calendarProbe = String.raw`
const fs = require('node:fs');
const ts = require('typescript');
const vm = require('node:vm');
function methods(file, names) {
  const text = fs.readFileSync(file, 'utf8');
  const ast = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const cls = ast.statements.find(ts.isClassDeclaration);
  return cls.members.filter(member => member.name && names.includes(member.name.getText(ast)))
    .map(member => member.getText(ast)).join('\n');
}
const source = 'class StoreCalendar {' + methods('src/app/core/services/card-nest-store.ts', ['nextRecurringDate', 'nextLegacyNonCardRecurringDate']) +
  '} class EditorCalendar {' + methods('src/app/features/transactions/transactions.ts', ['nextMonthlyOccurrence', 'nextNonCardMonthlyOccurrence', 'emiStartDate']) +
  '} globalThis.store = new StoreCalendar(); globalThis.editor = new EditorCalendar();';
const context = {};
vm.createContext(context);
vm.runInContext(ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
function probe() {
  const next = (startDate, occurrence, frequency = 'MONTHLY', interval) => context.store.nextRecurringDate({ startDate, frequency, interval }, occurrence);
  const results = [
    next('2026-01-31', '2026-01-31'),
    next('2028-01-31', '2028-01-31'),
    next('2026-02-28', '2026-02-28'),
    next('2026-01-31', '2026-02-28'),
    next('2026-12-31', '2026-12-31'),
    next('2026-12-31', '2026-12-31', 'YEARLY'),
    next('2028-02-29', '2028-02-29', 'YEARLY'),
    next('2026-03-07', '2026-03-07', 'DAILY'),
    next('2026-03-01', '2026-03-01', 'WEEKLY'),
    next('2026-10-25', '2026-10-25', 'BIWEEKLY'),
    next('2026-01-31', '2026-01-31', 'BIMONTHLY'),
    next('2026-10-31', '2026-10-31', 'QUARTERLY'),
    next('2026-08-31', '2026-08-31', 'HALF_YEARLY'),
    next('2026-01-31', '2026-01-31', 'MONTHLY', 2),
    context.editor.nextMonthlyOccurrence('2026-01-31'),
    context.editor.nextMonthlyOccurrence('2028-01-31'),
    context.editor.emiStartDate('2026-08-07', 'THIS_MONTH', ''),
    context.editor.emiStartDate('2026-12-31', 'NEXT_MONTH', ''),
    context.editor.emiStartDate('2026-08-07', 'CUSTOM', '2027-02'),
  ];
  const legacy = new Date('2026-01-31T12:00:00');
  legacy.setDate(1); legacy.setMonth(legacy.getMonth()+1);
  legacy.setDate(Math.min(31, new Date(legacy.getFullYear(),legacy.getMonth()+1,0).getDate()));
  return { offset: new Date('2026-01-31T12:00:00').getTimezoneOffset(), results,
    legacyExpected: legacy.toISOString().slice(0,10),
    legacyActual: context.editor.nextMonthlyOccurrence('2026-01-31', true),
    legacyStoreActual: context.store.nextLegacyNonCardRecurringDate({ startDate: '2026-01-31', frequency: 'MONTHLY' }, '2026-01-31') };
}
const zones = process.argv[1] === 'session' ? ['Asia/Kolkata','UTC','America/New_York','America/Los_Angeles','Pacific/Kiritimati','Pacific/Auckland'] : [process.env.TZ];
process.stdout.write(JSON.stringify(zones.map(zone => { process.env.TZ=zone; return probe(); })));
`;

interface CalendarResult {
  offset: number;
  results: string[];
  legacyExpected: string;
  legacyActual: string;
  legacyStoreActual: string;
}

const expected = [
  '2026-02-28',
  '2028-02-29',
  '2026-03-28',
  '2026-03-31',
  '2027-01-31',
  '2027-12-31',
  '2029-03-01',
  '2026-03-08',
  '2026-03-08',
  '2026-11-08',
  '2026-03-31',
  '2027-01-31',
  '2027-02-28',
  '2026-03-31',
  '2026-02-28',
  '2028-02-29',
  '2026-08-01',
  '2027-01-01',
  '2027-02-01',
];

describe('recurrence and EMI date-only arithmetic in actual process timezones', () => {
  it.each([
    ['Asia/Kolkata', -330],
    ['UTC', 0],
    ['America/New_York', 300],
    ['America/Los_Angeles', 480],
    ['Pacific/Kiritimati', -840],
    ['Pacific/Auckland', -780],
  ] as const)(
    'keeps calendar dates and legacy source behavior in %s',
    (zone, offset) => {
      const [result] = JSON.parse(
        execFileSync(process.execPath, ['-e', calendarProbe], {
          cwd: process.cwd(),
          env: { ...process.env, TZ: zone },
          encoding: 'utf8',
        }),
      ) as CalendarResult[];
      expect(result.offset).toBe(offset);
      expect(result.results).toEqual(expected);
      expect(result.legacyActual).toBe(result.legacyExpected);
      expect(result.legacyStoreActual).toBe(result.legacyExpected);
    },
    20_000,
  );

  it('keeps identical date-only results when the process timezone changes within one session', () => {
    const results = JSON.parse(
      execFileSync(process.execPath, ['-e', calendarProbe, 'session'], {
        cwd: process.cwd(),
        env: { ...process.env, TZ: 'UTC' },
        encoding: 'utf8',
      }),
    ) as CalendarResult[];
    expect(results.map((result) => result.offset)).toEqual([-330, 0, 300, 480, -840, -780]);
    for (const result of results) expect(result.results).toEqual(expected);
  }, 20_000);
});
