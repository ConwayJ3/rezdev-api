// Working-day calendar for schedules.
//
// Phase durations count WORK days: a 10-day phase spans 10 working days and
// skips weekends and observed holidays, so it lands where it really would on
// site. Each company sets its own work days and holidays in Settings.

// Every holiday is computed per year, so no list needs maintaining.
const HOLIDAY_DEFS = {
  new_years:        { label: "New Year's Day",        rule: y => new Date(Date.UTC(y, 0, 1)) },
  memorial_day:     { label: 'Memorial Day',          rule: y => lastWeekdayOfMonth(y, 4, 1) },
  independence_day: { label: 'Independence Day',      rule: y => new Date(Date.UTC(y, 6, 4)) },
  labor_day:        { label: 'Labor Day',             rule: y => nthWeekdayOfMonth(y, 8, 1, 1) },
  thanksgiving:     { label: 'Thanksgiving',          rule: y => nthWeekdayOfMonth(y, 10, 4, 4) },
  day_after_thanksgiving: { label: 'Day after Thanksgiving',
                            rule: y => addDays(nthWeekdayOfMonth(y, 10, 4, 4), 1) },
  christmas_eve:    { label: 'Christmas Eve',         rule: y => new Date(Date.UTC(y, 11, 24)) },
  christmas:        { label: 'Christmas Day',         rule: y => new Date(Date.UTC(y, 11, 25)) },
  new_years_eve:    { label: "New Year's Eve",        rule: y => new Date(Date.UTC(y, 11, 31)) },
};

// What a company gets before it changes anything: Mon-Fri, and the holidays
// most residential builders observe.
const DEFAULT_WORK_DAYS = [1, 2, 3, 4, 5];   // 0 = Sunday
const DEFAULT_HOLIDAYS = [
  'new_years', 'memorial_day', 'independence_day', 'labor_day',
  'thanksgiving', 'day_after_thanksgiving',
  'christmas_eve', 'christmas', 'new_years_eve',
];

function addDays(d, n){ const x = new Date(d); x.setUTCDate(x.getUTCDate() + n); return x; }
function iso(d){ return d.toISOString().slice(0, 10); }

// nth (1-based) given weekday of a month; month is 0-based.
function nthWeekdayOfMonth(year, month, weekday, nth){
  const first = new Date(Date.UTC(year, month, 1));
  const shift = (weekday - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, month, 1 + shift + (nth - 1) * 7));
}

function lastWeekdayOfMonth(year, month, weekday){
  const last = new Date(Date.UTC(year, month + 1, 0));
  const shift = (last.getUTCDay() - weekday + 7) % 7;
  return new Date(Date.UTC(year, month + 1, 0 - shift));
}

// Read the calendar out of companies.settings, falling back to the defaults.
function calendarFromSettings(settings){
  const s = (settings && settings.schedule) || {};
  const workDays = Array.isArray(s.work_days) && s.work_days.length
    ? s.work_days.map(Number).filter(d => d >= 0 && d <= 6)
    : DEFAULT_WORK_DAYS.slice();
  const holidays = Array.isArray(s.holidays) ? s.holidays.slice() : DEFAULT_HOLIDAYS.slice();
  return {
    workDays: workDays.length ? workDays : DEFAULT_WORK_DAYS.slice(),
    holidays,
  };
}

// Holiday dates for a span of years, as a Set of yyyy-mm-dd.
function holidayDates(keys, fromYear, toYear){
  const out = new Set();
  (keys || []).forEach(function(k){
    const def = HOLIDAY_DEFS[k];
    if(!def) return;
    for(let y = fromYear; y <= toYear; y++){
      try { out.add(iso(def.rule(y))); } catch(e){ /* skip a bad rule */ }
    }
  });
  return out;
}

// A working day is one of the company's work days and not a holiday.
function makeIsWorkDay(calendar, fromYear, toYear){
  const days = new Set(calendar.workDays);
  const hols = holidayDates(calendar.holidays, fromYear - 1, toYear + 2);
  return function(d){ return days.has(d.getUTCDay()) && !hols.has(iso(d)); };
}

module.exports = {
  HOLIDAY_DEFS, DEFAULT_WORK_DAYS, DEFAULT_HOLIDAYS,
  addDays, iso, calendarFromSettings, holidayDates, makeIsWorkDay,
};
