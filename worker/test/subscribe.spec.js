import { env } from "cloudflare:workers";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { call, subscribeReq, mockResend, resetDb, rows, freshIp, ORIGIN } from "./helpers.js";
import { normaliseEmail } from "../src/lib.js";

const valid = { email: "Landlord@Example.co.uk", region: "london", consent: true, website: "" };

describe("POST /subscribe: validation", () => {
  let mail;
  beforeEach(async () => { await resetDb(); mail = mockResend(); vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.parse("2026-10-20T12:00:00Z")); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("accepts a valid sign-up, stores it as pending and sends one confirmation email", async () => {
    const res = await call(subscribeReq(valid));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
    const [r] = await rows();
    expect(r).toMatchObject({ email: "landlord@example.co.uk", region: "london", status: "pending", confirmed_at: null });
    expect(r.confirm_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.unsub_token.length).toBeGreaterThanOrEqual(40);
    // Only these columns exist: email, region, status, tokens, timestamps.
    expect(Object.keys(r).sort()).toEqual(["confirm_sent_at", "confirm_token_hash", "confirmed_at", "created_at", "email", "id", "region", "status", "unsub_token"]);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["landlord@example.co.uk"]);
  });

  it.each([
    ["missing email", { ...valid, email: undefined }, "email"],
    ["bad email", { ...valid, email: "not-an-email" }, "email"],
    ["email with spaces", { ...valid, email: "a b@example.com" }, "email"],
    ["email without TLD", { ...valid, email: "a@localhost" }, "email"],
    ["very long email", { ...valid, email: "a".repeat(250) + "@x.com" }, "email"],
    ["unknown region", { ...valid, region: "scotland" }, "region"],
    ["region as wrong type", { ...valid, region: 7 }, "region"],
    ["region prototype key", { ...valid, region: "__proto__" }, "region"],
    ["consent missing", { ...valid, consent: undefined }, "consent"],
    ["consent false", { ...valid, consent: false }, "consent"],
  ])("rejects %s", async (_n, body, field) => {
    const res = await call(subscribeReq(body));
    expect(res.status).toBe(400);
    const j = await res.json();
    expect(j.ok).toBe(false);
    expect(j.fields).toHaveProperty(field);
    expect(await rows()).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("rejects non-JSON, malformed JSON, arrays and oversized bodies", async () => {
    expect((await call(subscribeReq("email=a@b.com", { contentType: "application/x-www-form-urlencoded" }))).status).toBe(415);
    expect((await call(subscribeReq("{not json"))).status).toBe(400);
    expect((await call(subscribeReq([valid]))).status).toBe(400);
    expect((await call(subscribeReq({ ...valid, pad: "x".repeat(3000) }))).status).toBe(413);
    expect(await rows()).toHaveLength(0);
  });

  it("accepts all 9 regions", async () => {
    for (const region of ["west-midlands", "east-of-england", "east-midlands", "south-east", "yorkshire-and-humber", "north-west", "north-east", "london", "south-west"]) {
      expect((await call(subscribeReq({ ...valid, region }))).status).toBe(200);
    }
    expect(await rows()).toHaveLength(9);
  });

  it("refuses a region whose deadline has passed", async () => {
    vi.setSystemTime(Date.parse("2027-03-15T12:00:00Z"));
    const res = await call(subscribeReq({ ...valid, region: "west-midlands" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("deadline_passed");
  });

  it("normaliseEmail lower-cases and trims", () => {
    expect(normaliseEmail("  A.B+tag@Sub.Example.COM ")).toBe("a.b+tag@sub.example.com");
    expect(normaliseEmail("a..b@example.com")).toBeNull();
    expect(normaliseEmail(".a@example.com")).toBeNull();
  });
});

describe("POST /subscribe: honeypot, kill switch, CORS", () => {
  let mail;
  beforeEach(async () => { await resetDb(); mail = mockResend(); });
  afterEach(() => vi.restoreAllMocks());

  it("honeypot filled: answers like success but stores and sends nothing", async () => {
    const res = await call(subscribeReq({ ...valid, website: "https://spam.example" }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(await rows()).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("honeypot with a non-string value is also treated as a bot", async () => {
    await call(subscribeReq({ ...valid, website: 1 }));
    expect(await rows()).toHaveLength(0);
  });

  it("kill switch off (REMINDERS_LIVE=false, the wrangler.toml default): 503 and nothing stored", async () => {
    const res = await call(subscribeReq(valid), { ...env, REMINDERS_LIVE: "false" });
    expect(res.status).toBe(503);
    expect(await rows()).toHaveLength(0);
    expect(mail.sent).toHaveLength(0);
  });

  it("only the site's origin may call it", async () => {
    expect((await call(subscribeReq(valid, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await call(subscribeReq(valid, { origin: null }))).status).toBe(403);
    expect((await call(subscribeReq(valid, { origin: "https://aleborini.github.io.evil.example" }))).status).toBe(403);
    expect(await rows()).toHaveLength(0);
  });

  it("CORS headers name only the site's origin; preflight works", async () => {
    const pre = await call(new Request("https://reminders.test/subscribe", { method: "OPTIONS", headers: { Origin: ORIGIN, "Access-Control-Request-Method": "POST" } }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toBe("POST, OPTIONS");
    const res = await call(subscribeReq(valid));
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(ORIGIN);
    expect(res.headers.get("Vary")).toBe("Origin");
  });

  it("GET /subscribe is not allowed", async () => {
    expect((await call(subscribeReq(null, { method: "GET", contentType: null }))).status).toBe(405);
  });

  it("unknown paths are 404", async () => {
    expect((await call(new Request("https://reminders.test/admin"))).status).toBe(404);
  });
});

describe("POST /subscribe: rate limits", () => {
  let mail;
  beforeEach(async () => { await resetDb(); mail = mockResend(); });
  afterEach(() => vi.restoreAllMocks());

  it("limits each IP to 5 requests a minute", async () => {
    const ip = freshIp();
    const statuses = [];
    for (let i = 0; i < 7; i++) statuses.push((await call(subscribeReq({ ...valid, email: `rl${i}@example.com` }, { ip }))).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
    // A different IP is unaffected.
    expect((await call(subscribeReq({ ...valid, email: "other@example.com" }))).status).toBe(200);
  });

  it("does not resend a confirmation to the same address within 10 minutes, and gives the same answer", async () => {
    const a = await call(subscribeReq(valid));
    const b = await call(subscribeReq(valid));
    expect(await a.json()).toEqual(await b.json());
    expect(mail.sent).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });

  it("an already-confirmed subscriber gets the same answer and no new email", async () => {
    await call(subscribeReq(valid));
    await env.DB.prepare("UPDATE subscribers SET status='confirmed', confirm_token_hash=NULL, confirm_sent_at=0").run();
    const res = await call(subscribeReq(valid));
    expect((await res.json()).ok).toBe(true);
    expect(mail.sent).toHaveLength(1);
  });

  it("stops sending confirmations once the daily cap is reached", async () => {
    const e = { ...env, DAILY_CONFIRM_CAP: "2" };
    expect((await call(subscribeReq({ ...valid, email: "c1@example.com" }), e)).status).toBe(200);
    expect((await call(subscribeReq({ ...valid, email: "c2@example.com" }), e)).status).toBe(200);
    expect((await call(subscribeReq({ ...valid, email: "c3@example.com" }), e)).status).toBe(429);
    expect(mail.sent).toHaveLength(2);
    expect(await rows()).toHaveLength(2);
  });

  it("if Resend fails, the new sign-up is not kept", async () => {
    mail.fail(1);
    const res = await call(subscribeReq(valid));
    expect(res.status).toBe(502);
    expect(await rows()).toHaveLength(0);
  });
});
