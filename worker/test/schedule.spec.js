import { describe, it, expect } from "vitest";
import { REGIONS, REGION_BY_ID, scheduleFor, dueReminders, londonDate, longDate, addDays, FINAL_DEADLINE } from "../src/regions.js";
import { reminderEmail, confirmationEmail } from "../src/emails.js";

// Copied verbatim from fact-check.md, section 2 "Regional rollout - full windows"
// (Housing Hub FAQ table + legislation.gov.uk SI, checked 19 October 2026).
const FACT_CHECK_TABLE = `
| West Midlands | 15 December 2026 | 14 March 2027 |
| East of England | 15 January 2027 | 14 April 2027 |
| East Midlands | 15 February 2027 | 14 May 2027 |
| South East | 15 March 2027 | 14 June 2027 |
| Yorkshire and Humber | 15 April 2027 | 14 July 2027 |
| North West | 15 May 2027 | 14 August 2027 |
| North East | 15 June 2027 | 14 September 2027 |
| London | 15 July 2027 | 14 October 2027 |
| South West | 15 August 2027 | 14 November 2027 |`;
const M = { January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8, September: 9, October: 10, November: 11, December: 12 };
const toIso = (s) => { const [d, m, y] = s.trim().split(" "); return `${y}-${String(M[m]).padStart(2, "0")}-${d.padStart(2, "0")}`; };
const FACTS = FACT_CHECK_TABLE.trim().split("\n").map((l) => { const [, name, o, d] = l.split("|"); return { name: name.trim(), opens: toIso(o), deadline: toIso(d) }; });

// Expected send dates, worked out by hand from the table (7 days before opening, opening day,
// 30 days and 7 days before the deadline).
const EXPECTED = {
  "west-midlands": ["2026-12-08", "2026-12-15", "2027-02-12", "2027-03-07"],
  "east-of-england": ["2027-01-08", "2027-01-15", "2027-03-15", "2027-04-07"],
  "east-midlands": ["2027-02-08", "2027-02-15", "2027-04-14", "2027-05-07"],
  "south-east": ["2027-03-08", "2027-03-15", "2027-05-15", "2027-06-07"],
  "yorkshire-and-humber": ["2027-04-08", "2027-04-15", "2027-06-14", "2027-07-07"],
  "north-west": ["2027-05-08", "2027-05-15", "2027-07-15", "2027-08-07"],
  "north-east": ["2027-06-08", "2027-06-15", "2027-08-15", "2027-09-07"],
  "london": ["2027-07-08", "2027-07-15", "2027-09-14", "2027-10-07"],
  "south-west": ["2027-08-08", "2027-08-15", "2027-10-15", "2027-11-07"],
};

describe("region config matches fact-check.md", () => {
  it("has exactly the 9 regions, in rollout order, with the fact-checked dates", () => {
    expect(REGIONS.map(({ name, opens, deadline }) => ({ name, opens, deadline }))).toEqual(FACTS);
  });
  it("final England-wide date is 14 November 2027 (the South West deadline)", () => {
    expect(FINAL_DEADLINE).toBe("2027-11-14");
    expect(REGIONS.at(-1).deadline).toBe(FINAL_DEADLINE);
  });
  it("region ids match the website's region page slugs", () => {
    expect(Object.keys(EXPECTED)).toEqual(REGIONS.map((r) => r.id));
  });
  it("config is frozen", () => {
    expect(Object.isFrozen(REGIONS)).toBe(true);
    expect(Object.isFrozen(REGIONS[0])).toBe(true);
  });
});

describe("reminder schedule per region", () => {
  for (const r of REGIONS) {
    it(`${r.name}: ${EXPECTED[r.id].join(", ")}`, () => {
      const s = scheduleFor(r.id);
      expect(s.map((x) => x.key)).toEqual(["opens-7", "opens-0", "deadline-30", "deadline-7"]);
      expect(s.map((x) => x.date)).toEqual(EXPECTED[r.id]);
      // All points fall on or before the deadline, in order.
      for (let i = 1; i < s.length; i++) expect(s[i].date > s[i - 1].date).toBe(true);
      expect(s.at(-1).date < r.deadline).toBe(true);
    });
    it(`${r.name}: every reminder is due exactly on its date (+2 catch-up days) and never after the deadline`, () => {
      const due = new Map();
      for (let d = addDays(r.opens, -60); d <= addDays(r.deadline, 5); d = addDays(d, 1)) {
        for (const x of dueReminders(r.id, d)) (due.get(x.key) || due.set(x.key, []).get(x.key)).push(d);
      }
      for (const x of scheduleFor(r.id)) {
        expect(due.get(x.key)).toEqual([x.date, addDays(x.date, 1), addDays(x.date, 2)].filter((d) => d <= r.deadline));
      }
    });
    it(`${r.name}: emails state the fact-checked dates`, () => {
      const unsubUrl = "https://reminders.test/unsubscribe?token=t";
      for (const key of ["opens-7", "opens-0", "deadline-30", "deadline-7"]) {
        const m = reminderEmail({ regionId: r.id, key, unsubUrl });
        expect(m.text).toContain(r.name);
        expect(m.text).toContain(longDate(r.deadline));
        expect(m.text).not.toMatch(/\bin \d+ days\b|\btoday\b|\btomorrow\b/i); // absolute dates only
      }
      const c = confirmationEmail({ regionId: r.id, confirmUrl: "https://reminders.test/confirm?token=c", unsubUrl });
      expect(c.text).toContain(longDate(r.opens));
      expect(c.text).toContain(longDate(r.deadline));
    });
  }
});

describe("email copy: no advice, no other figures", () => {
  it("does not mention fees, penalties or tell people what they must do legally", () => {
    const all = REGIONS.flatMap((r) => ["opens-7", "opens-0", "deadline-30", "deadline-7"].map((key) => reminderEmail({ regionId: r.id, key, unsubUrl: "u" }).text));
    for (const t of all) {
      expect(t).not.toMatch(/£|\bfine\b|penalt|you must|you should|legally required/i);
    }
  });
  it("HTML escapes and links", () => {
    const m = reminderEmail({ regionId: "london", key: "opens-7", unsubUrl: "https://x.test/unsubscribe?token=a&b" });
    expect(m.html).toContain("token=a&amp;b");
    expect(m.html).not.toContain("<script");
  });
});

describe("date helpers", () => {
  it("londonDate uses UK time across BST/GMT", () => {
    expect(londonDate(Date.parse("2027-07-07T23:30:00Z"))).toBe("2027-07-08"); // BST: 00:30 on the 8th
    expect(londonDate(Date.parse("2026-12-07T23:30:00Z"))).toBe("2026-12-07"); // GMT
    expect(londonDate(Date.parse("2027-03-28T00:30:00Z"))).toBe("2027-03-28"); // clocks change day
  });
  it("addDays crosses months and years", () => {
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2027-03-14", -30)).toBe("2027-02-12");
  });
  it("longDate", () => expect(longDate("2026-12-15")).toBe("15 December 2026"));
  it("unknown region throws", () => expect(() => scheduleFor("wales")).toThrow());
  it("lookup has no prototype keys", () => { expect(REGION_BY_ID["__proto__"]).toBeUndefined(); expect(REGION_BY_ID["constructor"]).toBeUndefined(); });
});
