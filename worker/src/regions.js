// Registration windows for the England PRS Database ("Register your rental property").
//
// SOURCE (the only source for these dates): fact-check.md, section 2 "Regional rollout - full windows",
// checked 19 October 2026 against:
//   - Housing Hub, Get ready to register (FAQ table):
//     https://housinghub.campaign.gov.uk/renting-is-changing/get-ready-to-register/
//   - The Private Rented Sector Database Regulations 2026 (commencement table):
//     https://www.legislation.gov.uk/ukdsi/2026/9780348286861
//   - GOV.UK news, 9 September 2026 (launch 15 December 2026, final date 14 November 2027):
//     https://www.gov.uk/government/news/stronger-protections-and-greater-confidence-for-renters
//
// The regulations were still a draft before Parliament when checked. Re-check these dates against
// gov.uk before switching reminders on and whenever the government updates its guidance.
// Do NOT edit a date here without updating fact-check.md and its source first.

export const DATES_CHECKED = "19 October 2026";

// id = the slug used on the website (regions/<id>/). Dates are calendar dates in England (Europe/London).
export const REGIONS = Object.freeze([
  { id: "west-midlands", name: "West Midlands", opens: "2026-12-15", deadline: "2027-03-14" },
  { id: "east-of-england", name: "East of England", opens: "2027-01-15", deadline: "2027-04-14" },
  { id: "east-midlands", name: "East Midlands", opens: "2027-02-15", deadline: "2027-05-14" },
  { id: "south-east", name: "South East", opens: "2027-03-15", deadline: "2027-06-14" },
  { id: "yorkshire-and-humber", name: "Yorkshire and Humber", opens: "2027-04-15", deadline: "2027-07-14" },
  { id: "north-west", name: "North West", opens: "2027-05-15", deadline: "2027-08-14" },
  { id: "north-east", name: "North East", opens: "2027-06-15", deadline: "2027-09-14" },
  { id: "london", name: "London", opens: "2027-07-15", deadline: "2027-10-14" },
  { id: "south-west", name: "South West", opens: "2027-08-15", deadline: "2027-11-14" },
].map(Object.freeze));

// England-wide date by which all landlords actively letting property need to have registered (GOV.UK news).
export const FINAL_DEADLINE = "2027-11-14";

// Null prototype, so keys like "__proto__" or "constructor" are never treated as regions.
export const REGION_BY_ID = Object.freeze(Object.assign(Object.create(null), Object.fromEntries(REGIONS.map((r) => [r.id, r]))));

// Fixed reminder points. Each is sent once per subscriber, on its due date (London time).
// `daysFrom` is relative to the anchor date (negative = before).
export const REMINDER_POINTS = Object.freeze([
  { key: "opens-7", anchor: "opens", daysFrom: -7 },
  { key: "opens-0", anchor: "opens", daysFrom: 0 },
  { key: "deadline-30", anchor: "deadline", daysFrom: -30 },
  { key: "deadline-7", anchor: "deadline", daysFrom: -7 },
].map(Object.freeze));

// If a daily run is missed (outage), a reminder can still go out up to this many days after its due date.
// Every email uses absolute dates, so a late send is still accurate. It is never sent after the deadline.
export const CATCH_UP_DAYS = 2;

// ---- date helpers (pure, UTC-based arithmetic on calendar dates) ----
export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** Calendar date (YYYY-MM-DD) in England for a timestamp in ms. */
export function londonDate(ms) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
/** "2026-12-15" -> "15 December 2026" */
export function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** The full schedule for one region: [{key, date}] in send order. */
export function scheduleFor(regionId) {
  const r = REGION_BY_ID[regionId];
  if (!r) throw new Error(`unknown region ${regionId}`);
  return REMINDER_POINTS.map((p) => ({ key: p.key, date: addDays(r[p.anchor], p.daysFrom) }));
}

/** Reminders that are due today (including the catch-up allowance) for a region. */
export function dueReminders(regionId, today) {
  const r = REGION_BY_ID[regionId];
  return scheduleFor(regionId).filter(
    (s) => s.date <= today && today <= addDays(s.date, CATCH_UP_DAYS) && today <= r.deadline,
  );
}
