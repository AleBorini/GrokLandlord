import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { vi } from "vitest";
import worker from "../src/index.js";

export const ORIGIN = "https://aleborini.github.io";
let ipCounter = 0;
export const freshIp = () => `203.0.113.${(ipCounter++ % 250) + 1}`;

/** Mock Resend. Returns the list of captured email payloads. `fail()` makes the next N sends fail. */
export function mockResend() {
  const sent = [];
  let failures = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input.url;
    if (!url.startsWith(env.RESEND_API_URL)) throw new Error(`unexpected outbound fetch to ${url}`);
    if (failures > 0) { failures--; return new Response('{"message":"boom"}', { status: 500 }); }
    const payload = JSON.parse(init.body);
    sent.push({ ...payload, _headers: init.headers });
    return new Response(JSON.stringify({ id: `mock-${sent.length}` }), { status: 200 });
  });
  return { sent, spy, fail: (n = 1) => { failures = n; } };
}

export async function call(request, e = env) {
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, e, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export function subscribeReq(body, { ip = freshIp(), origin = ORIGIN, contentType = "application/json", method = "POST" } = {}) {
  const headers = { "CF-Connecting-IP": ip };
  if (origin) headers.Origin = origin;
  if (contentType) headers["Content-Type"] = contentType;
  return new Request("https://reminders.test/subscribe", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

export const linkFrom = (text, path) => {
  const m = text.match(new RegExp(`https://reminders\\.test${path}\\?token=([A-Za-z0-9_-]+)`));
  return m ? m[0] : null;
};

export async function resetDb() {
  await env.DB.batch([env.DB.prepare("DELETE FROM sends"), env.DB.prepare("DELETE FROM subscribers")]);
}

export const rows = async () => (await env.DB.prepare("SELECT * FROM subscribers ORDER BY id").all()).results;
export const sendRows = async () => (await env.DB.prepare("SELECT * FROM sends ORDER BY subscriber_id, reminder_key").all()).results;

/** ms timestamp for 09:00 UTC on a London calendar date. */
export const at = (iso, hourUtc = 9) => Date.parse(`${iso}T${String(hourUtc).padStart(2, "0")}:00:00Z`);
