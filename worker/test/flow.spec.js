import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { call, subscribeReq, mockResend, resetDb, rows, sendRows, linkFrom, at } from "./helpers.js";
import { runCron } from "../src/lib.js";
import { GOV_UK_URL } from "../src/emails.js";

const TODAY = Date.parse("2026-10-20T12:00:00Z");

async function signUp(email, region) {
  const res = await call(subscribeReq({ email, region, consent: true, website: "" }));
  expect(res.status).toBe(200);
}

function lastMail(mail) { return mail.sent[mail.sent.length - 1]; }

function expectFooter(m) {
  for (const body of [m.text, m.html]) {
    expect(body).toContain("not affiliated with the UK government");
    expect(body).toContain("You can only register at gov.uk");
    expect(body).toContain(GOV_UK_URL);
    expect(body).toMatch(/https:\/\/reminders\.test\/unsubscribe\?token=/);
    expect(body).toContain("not legal advice");
  }
  const unsub = linkFrom(m.text, "/unsubscribe");
  expect(m.headers["List-Unsubscribe"]).toBe(`<${unsub}>`);
  expect(m.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
}

describe("subscribe -> confirm -> reminders -> unsubscribe", () => {
  let mail;
  beforeEach(async () => { await resetDb(); mail = mockResend(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(TODAY); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("full flow for West Midlands", async () => {
    vi.setSystemTime(Date.parse("2026-12-05T12:00:00Z"));
    await signUp("flow@example.com", "west-midlands");
    const conf = lastMail(mail);
    expect(conf.subject).toBe("Confirm your West Midlands landlord register reminders");
    expect(conf.from).toBe(env.FROM_EMAIL);
    expect(conf.to).toEqual(["flow@example.com"]);
    expect(conf.text).toContain("15 December 2026");
    expect(conf.text).toContain("14 March 2027");
    expectFooter(conf);

    // Pending (unconfirmed) sign-ups get no reminders.
    mail.sent.length = 0;
    expect((await runCron(env, at("2026-12-08", 8))).sent).toBe(0);
    expect(mail.sent).toHaveLength(0);

    // Confirm.
    vi.setSystemTime(at("2026-12-08", 8) + 60_000);
    const confirmUrl = linkFrom(conf.text, "/confirm");
    const c = await call(new Request(confirmUrl));
    expect(c.status).toBe(200);
    expect(c.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(c.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(await c.text()).toContain("Reminders confirmed");
    expect((await rows())[0]).toMatchObject({ status: "confirmed", confirm_token_hash: null });
    // The confirmation link only works once.
    expect((await call(new Request(confirmUrl))).status).toBe(404);

    // 7 days before opening.
    let s = await runCron(env, at("2026-12-08"));
    expect(s.sent).toBe(1);
    expect(lastMail(mail).subject).toBe("West Midlands: the landlord register opens on 15 December 2026");
    expectFooter(lastMail(mail));
    // Same day, later run: no duplicate.
    expect((await runCron(env, at("2026-12-08", 11))).sent).toBe(0);

    // Opening day, 30 days before the deadline, 7 days before the deadline.
    expect((await runCron(env, at("2026-12-15"))).sent).toBe(1);
    expect(lastMail(mail).subject).toBe("West Midlands: the landlord register window is now open");
    expect((await runCron(env, at("2027-02-12"))).sent).toBe(1);
    expect(lastMail(mail).subject).toBe("Reminder: the West Midlands landlord register deadline is 14 March 2027");
    expect((await runCron(env, at("2027-03-07"))).sent).toBe(1);
    expect(lastMail(mail).subject).toBe("Last reminder: the West Midlands landlord register deadline is 14 March 2027");
    for (const m of mail.sent) expectFooter(m);
    const keys = ["opens-7", "opens-0", "deadline-30", "deadline-7"];
    mail.sent.forEach((m, i) => expect(m._headers["Idempotency-Key"]).toMatch(new RegExp(`^reminder-\\d+-${keys[i]}$`)));
    expect((await sendRows()).map((r) => r.reminder_key).sort()).toEqual(["deadline-30", "deadline-7", "opens-0", "opens-7"]);

    // Unsubscribe deletes everything.
    const u = await call(new Request(linkFrom(lastMail(mail).text, "/unsubscribe")));
    expect(u.status).toBe(200);
    expect(await u.text()).toContain("your email address has been deleted");
    expect(await rows()).toHaveLength(0);
    expect(await sendRows()).toHaveLength(0);
  });

  it("one-click unsubscribe via POST (RFC 8058) works and is idempotent", async () => {
    await signUp("post@example.com", "london");
    const unsub = linkFrom(lastMail(mail).text, "/unsubscribe");
    const r1 = await call(new Request(unsub, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
    expect(r1.status).toBe(200);
    expect(await rows()).toHaveLength(0);
    expect((await call(new Request(unsub))).status).toBe(200);
  });

  it("unsubscribing from the confirmation email (before confirming) deletes the pending sign-up", async () => {
    await signUp("early@example.com", "london");
    await call(new Request(linkFrom(lastMail(mail).text, "/unsubscribe")));
    expect(await rows()).toHaveLength(0);
  });

  it("bad or unknown tokens do nothing", async () => {
    await signUp("keep@example.com", "london");
    expect((await call(new Request("https://reminders.test/confirm?token=short"))).status).toBe(400);
    expect((await call(new Request("https://reminders.test/confirm?token=" + "x".repeat(43)))).status).toBe(404);
    expect((await call(new Request("https://reminders.test/unsubscribe?token=" + "x".repeat(43)))).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("a second sign-up while pending (after the cooldown) sends a new link and the old link stops working", async () => {
    await signUp("again@example.com", "london");
    const first = linkFrom(lastMail(mail).text, "/confirm");
    vi.setSystemTime(TODAY + 11 * 60_000);
    await signUp("again@example.com", "london");
    const second = linkFrom(lastMail(mail).text, "/confirm");
    expect(second).not.toBe(first);
    expect((await call(new Request(first))).status).toBe(404);
    expect((await call(new Request(second))).status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("the same email can follow two regions, each with its own unsubscribe link", async () => {
    await signUp("two@example.com", "london");
    await signUp("two@example.com", "south-west");
    expect(await rows()).toHaveLength(2);
    expect(linkFrom(mail.sent[0].text, "/unsubscribe")).not.toBe(linkFrom(mail.sent[1].text, "/unsubscribe"));
  });
});

describe("cron: duplicates, failures, expiry, clean-up", () => {
  let mail;
  beforeEach(async () => { await resetDb(); mail = mockResend(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(TODAY); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  async function confirmed(email, region) {
    await signUp(email, region);
    const r = await call(new Request(linkFrom(lastMail(mail).text, "/confirm")));
    expect(r.status).toBe(200);
  }

  it("never sends the same reminder twice, across repeated and catch-up runs", async () => {
    await confirmed("a@example.com", "london");
    await confirmed("b@example.com", "london");
    mail.sent.length = 0;
    const days = ["2027-07-08", "2027-07-08", "2027-07-09", "2027-07-10", "2027-07-10"];
    let total = 0;
    for (const d of days) for (const h of [8, 9, 10, 11]) total += (await runCron(env, at(d, h))).sent;
    expect(total).toBe(2);
    expect(mail.sent.map((m) => m.to[0]).sort()).toEqual(["a@example.com", "b@example.com"]);
  });

  it("concurrent runs still send once", async () => {
    await confirmed("c@example.com", "london");
    mail.sent.length = 0;
    const r = await Promise.all([runCron(env, at("2027-07-08")), runCron(env, at("2027-07-08")), runCron(env, at("2027-07-08"))]);
    expect(r.reduce((n, s) => n + s.sent, 0)).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it("a failed send is retried on a later run, then sent only once", async () => {
    await confirmed("f@example.com", "london");
    mail.sent.length = 0;
    mail.fail(1);
    const s1 = await runCron(env, at("2027-07-08", 8));
    expect(s1).toMatchObject({ sent: 0, failed: 1 });
    expect(await sendRows()).toHaveLength(0);
    expect((await runCron(env, at("2027-07-08", 9))).sent).toBe(1);
    expect((await runCron(env, at("2027-07-08", 10))).sent).toBe(0);
    expect(mail.sent).toHaveLength(1);
  });

  it("a missed reminder is caught up for 2 days only", async () => {
    await confirmed("late@example.com", "london");
    mail.sent.length = 0;
    // opens-7 for London is 8 July 2027; first run that day happens on the 11th (3 days late): skipped.
    expect((await runCron(env, at("2027-07-11"))).sent).toBe(0);
    // A run on the 10th (2 days late) would still have sent it.
    await resetDb(); mail.sent.length = 0;
    await confirmed("late2@example.com", "london");
    mail.sent.length = 0;
    expect((await runCron(env, at("2027-07-10"))).sent).toBe(1);
  });

  it("someone who signs up after a reminder date only gets the reminders still to come", async () => {
    vi.setSystemTime(Date.parse("2027-07-20T12:00:00Z")); // London window already open
    await confirmed("mid@example.com", "london");
    mail.sent.length = 0;
    let sent = 0;
    for (let d = Date.parse("2027-07-20T09:00:00Z"); d <= Date.parse("2027-10-14T09:00:00Z"); d += 86_400_000) sent += (await runCron(env, d)).sent;
    expect(sent).toBe(2);
    expect(mail.sent.map((m) => m.subject)).toEqual([
      "Reminder: the London landlord register deadline is 14 October 2027",
      "Last reminder: the London landlord register deadline is 14 October 2027",
    ]);
  });

  it("deletes unconfirmed sign-ups after 7 days, and keeps them before that", async () => {
    await signUp("pending@example.com", "london");
    const link = linkFrom(lastMail(mail).text, "/confirm");
    expect((await runCron(env, TODAY + 7 * 86_400_000 - 60_000)).expiredPending).toBe(0);
    expect(await rows()).toHaveLength(1);
    expect((await runCron(env, TODAY + 7 * 86_400_000)).expiredPending).toBe(1);
    expect(await rows()).toHaveLength(0);
    vi.setSystemTime(TODAY + 7 * 86_400_000 + 1);
    expect((await call(new Request(link))).status).toBe(404);
  });

  it("a confirmation link older than 7 days does not work even before the clean-up runs", async () => {
    await signUp("old@example.com", "london");
    const link = linkFrom(lastMail(mail).text, "/confirm");
    vi.setSystemTime(TODAY + 7 * 86_400_000 + 1);
    expect((await call(new Request(link))).status).toBe(404);
    expect((await rows())[0].status).toBe("pending");
  });

  it("does not delete confirmed subscribers as 'expired'", async () => {
    await confirmed("conf@example.com", "london");
    await runCron(env, TODAY + 30 * 86_400_000);
    expect(await rows()).toHaveLength(1);
  });

  it("deletes a region's subscribers the day after its deadline", async () => {
    await confirmed("wm@example.com", "west-midlands");
    await confirmed("ldn@example.com", "london");
    expect((await runCron(env, at("2027-03-14"))).deletedAfterDeadline).toBe(0);
    expect((await runCron(env, at("2027-03-15"))).deletedAfterDeadline).toBe(1);
    expect((await rows()).map((r) => r.region)).toEqual(["london"]);
  });

  it("respects MAX_SENDS_PER_RUN and finishes in the next run", async () => {
    for (let i = 0; i < 5; i++) await confirmed(`m${i}@example.com`, "london");
    mail.sent.length = 0;
    const e = { ...env, MAX_SENDS_PER_RUN: "3" };
    const s1 = await runCron(e, at("2027-07-08", 8));
    expect(s1).toMatchObject({ sent: 3, capped: true });
    expect((await runCron(e, at("2027-07-08", 9))).sent).toBe(2);
    expect((await runCron(e, at("2027-07-08", 10))).sent).toBe(0);
    expect(new Set(mail.sent.map((m) => m.to[0])).size).toBe(5);
  });

  it("the scheduled() handler uses the trigger time", async () => {
    await confirmed("sch@example.com", "london");
    mail.sent.length = 0;
    const worker = (await import("../src/index.js")).default;
    await worker.scheduled({ scheduledTime: at("2027-07-08"), cron: "0 8-11 * * *" }, env, { waitUntil() {} });
    expect(mail.sent).toHaveLength(1);
  });
});
