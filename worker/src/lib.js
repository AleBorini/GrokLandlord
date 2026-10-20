// Request handlers and cron logic for the reminders Worker (src/index.js only routes).
// Kept separate because a Worker's main module may only export handlers.
import { REGION_BY_ID, REGIONS, dueReminders, londonDate } from "./regions.js";
import { confirmationEmail, reminderEmail } from "./emails.js";

const DAY = 86_400_000;
export const PENDING_TTL_MS = 7 * DAY; // unconfirmed sign-ups are deleted after 7 days
export const RESEND_COOLDOWN_MS = 10 * 60_000; // at most one confirmation email per address+region per 10 minutes
const MAX_BODY = 2048;

// ---------- helpers ----------
const bool = (v) => v === true || v === "true" || v === "on" || v === "1" || v === 1;
const num = (v, d) => (Number.isFinite(Number(v)) && v !== undefined && v !== "" ? Number(v) : d);

export function normaliseEmail(raw) {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length < 6 || e.length > 254) return null;
  const at = e.lastIndexOf("@");
  if (at < 1 || at > 64) return null;
  const re = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  if (!re.test(e)) return null;
  const local = e.slice(0, at);
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return e;
}

function randomToken() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256(s) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

export function corsHeaders(env, origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

export function json(status, body, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...extra,
    },
  });
}

function page(status, title, message, env) {
  const site = env.SITE_URL || "/";
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const html = `<!DOCTYPE html><html lang="en-GB"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title></head>
<body style="font-family:system-ui,Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;line-height:1.5;color:#14213d">
<h1 style="font-size:1.5rem">${esc(title)}</h1><p>${esc(message)}</p>
<p><a href="${esc(site)}">Back to the landlord register deadline checker</a></p>
<p style="font-size:.85rem;color:#4a5873">Independent tool, not affiliated with the UK government. Register only at <a href="https://www.gov.uk/government/news/stronger-protections-and-greater-confidence-for-renters">gov.uk</a>.</p>
</body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
      "X-Robots-Tag": "noindex",
    },
  });
}

function links(env, unsubToken, confirmToken) {
  const base = String(env.PUBLIC_URL || "").replace(/\/+$/, "");
  const out = { unsubUrl: `${base}/unsubscribe?token=${encodeURIComponent(unsubToken)}` };
  if (confirmToken) out.confirmUrl = `${base}/confirm?token=${encodeURIComponent(confirmToken)}`;
  return out;
}

/** Send one email through Resend's HTTP API. Throws on failure. */
export async function sendEmail(env, { to, subject, text, html, unsubUrl, idempotencyKey }) {
  if (!env.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not set");
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" };
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const res = await fetch(env.RESEND_API_URL || "https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: env.FROM_EMAIL,
      to: [to],
      ...(env.REPLY_TO ? { reply_to: env.REPLY_TO } : {}),
      subject,
      text,
      html,
      headers: {
        "List-Unsubscribe": `<${unsubUrl}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    }),
  });
  if (!res.ok) throw new Error(`Resend responded ${res.status}`);
  return true;
}

// ---------- POST /subscribe ----------
const OK_MESSAGE = "Thanks. Check your inbox and click the link to confirm your reminders.";

export async function subscribe(request, env, cors) {
  if (!bool(env.REMINDERS_LIVE)) {
    return json(503, { ok: false, error: "not_live", message: "Email reminders are not switched on yet." }, cors);
  }
  const ctype = request.headers.get("Content-Type") || "";
  if (!ctype.toLowerCase().startsWith("application/json")) {
    return json(415, { ok: false, error: "content_type", message: "Send JSON." }, cors);
  }
  const raw = await request.text();
  if (raw.length > MAX_BODY) return json(413, { ok: false, error: "too_large", message: "Request too large." }, cors);
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { ok: false, error: "bad_json", message: "Invalid request." }, cors);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json(400, { ok: false, error: "bad_json", message: "Invalid request." }, cors);
  }

  // Honeypot: real people never fill the hidden "website" field. Pretend success, store and send nothing.
  if (typeof body.website === "string" ? body.website.trim() !== "" : body.website != null) {
    return json(200, { ok: true, message: OK_MESSAGE }, cors);
  }

  // Rate limit per client IP (Workers Rate Limiting binding; the IP is not stored by us).
  if (env.SUBSCRIBE_LIMITER) {
    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const { success } = await env.SUBSCRIBE_LIMITER.limit({ key: `subscribe:${ip}` });
    if (!success) return json(429, { ok: false, error: "rate_limited", message: "Too many requests. Please try again in a minute." }, { ...cors, "Retry-After": "60" });
  }

  const errors = {};
  const email = normaliseEmail(body.email);
  if (!email) errors.email = "Enter a valid email address.";
  const region = typeof body.region === "string" ? REGION_BY_ID[body.region] : undefined;
  if (!region) errors.region = "Choose your property's region.";
  if (!bool(body.consent)) errors.consent = "Tick the box to agree to receive the reminder emails.";
  if (Object.keys(errors).length) {
    return json(400, { ok: false, error: "invalid", message: "Please check the form.", fields: errors }, cors);
  }

  const now = Date.now();
  const today = londonDate(now);
  if (today > region.deadline) {
    return json(400, { ok: false, error: "deadline_passed", message: `The ${region.name} deadline has passed, so there are no reminders left to send.`, fields: { region: "This region's deadline has passed." } }, cors);
  }

  // Daily cap on confirmation emails (protects the email quota against abuse).
  const cap = num(env.DAILY_CONFIRM_CAP, 50);
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE confirm_sent_at > ?").bind(now - DAY).first();
  const existing = await env.DB.prepare("SELECT id, status, confirm_sent_at, unsub_token FROM subscribers WHERE email = ? AND region = ?")
    .bind(email, region.id).first();

  // Already confirmed, or a confirmation was sent very recently: say the same thing, send nothing.
  // (Same response either way, so the form can't be used to find out who has signed up.)
  if (existing && (existing.status === "confirmed" || now - existing.confirm_sent_at < RESEND_COOLDOWN_MS)) {
    return json(200, { ok: true, message: OK_MESSAGE }, cors);
  }
  if (recent.n >= cap) {
    return json(429, { ok: false, error: "busy", message: "We can't take more sign-ups today. Please try again tomorrow." }, cors);
  }

  const confirmToken = randomToken();
  const confirmHash = await sha256(confirmToken);
  let id;
  let unsubToken;
  if (existing) {
    // Pending sign-up asking again: new confirmation link (the old one stops working).
    id = existing.id;
    unsubToken = existing.unsub_token;
    await env.DB.prepare("UPDATE subscribers SET confirm_token_hash = ?, confirm_sent_at = ?, created_at = ? WHERE id = ?")
      .bind(confirmHash, now, now, id).run();
  } else {
    unsubToken = randomToken();
    const r = await env.DB.prepare(
      "INSERT INTO subscribers (email, region, status, confirm_token_hash, unsub_token, created_at, confirm_sent_at) VALUES (?, ?, 'pending', ?, ?, ?, ?) RETURNING id",
    ).bind(email, region.id, confirmHash, unsubToken, now, now).first();
    id = r.id;
  }

  const { confirmUrl, unsubUrl } = links(env, unsubToken, confirmToken);
  const msg = confirmationEmail({ regionId: region.id, confirmUrl, unsubUrl });
  try {
    await sendEmail(env, { to: email, ...msg, unsubUrl });
  } catch (e) {
    console.error("confirmation send failed", e.message);
    if (!existing) await env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(id).run();
    return json(502, { ok: false, error: "send_failed", message: "We couldn't send the confirmation email. Please try again later." }, cors);
  }
  return json(200, { ok: true, message: OK_MESSAGE }, cors);
}

// ---------- GET /confirm ----------
export async function confirm(url, env) {
  const token = url.searchParams.get("token") || "";
  if (token.length < 20 || token.length > 100) return page(400, "Link not valid", "This confirmation link is not valid.", env);
  const now = Date.now();
  const hash = await sha256(token);
  const row = await env.DB.prepare(
    "UPDATE subscribers SET status = 'confirmed', confirmed_at = ?, confirm_token_hash = NULL WHERE confirm_token_hash = ? AND status = 'pending' AND created_at > ? RETURNING region",
  ).bind(now, hash, now - PENDING_TTL_MS).first();
  if (!row) {
    return page(404, "Link expired or already used", "This confirmation link has expired or has already been used. If you still want reminders, sign up again on the website.", env);
  }
  const r = REGION_BY_ID[row.region];
  return page(200, "Reminders confirmed", `Thanks. You'll get email reminders for the ${r.name} registration window. Every email has a link to unsubscribe, which deletes your email address straight away.`, env);
}

// ---------- GET|POST /unsubscribe ----------
export async function unsubscribe(url, env) {
  const token = url.searchParams.get("token") || "";
  if (token.length >= 20 && token.length <= 100) {
    const row = await env.DB.prepare("SELECT id FROM subscribers WHERE unsub_token = ?").bind(token).first();
    if (row) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sends WHERE subscriber_id = ?").bind(row.id),
        env.DB.prepare("DELETE FROM subscribers WHERE id = ?").bind(row.id),
      ]);
    }
  }
  // Same answer whether or not the token existed (idempotent; reveals nothing).
  return page(200, "You're unsubscribed", "You won't get any more reminder emails, and your email address has been deleted.", env);
}

// ---------- cron ----------
export async function runCron(env, nowMs) {
  const today = londonDate(nowMs);
  const stats = { today, expiredPending: 0, deletedAfterDeadline: 0, sent: 0, failed: 0, capped: false };

  // 1. Delete unconfirmed sign-ups older than 7 days.
  const exp = await env.DB.prepare("DELETE FROM subscribers WHERE status = 'pending' AND created_at <= ? RETURNING id")
    .bind(nowMs - PENDING_TTL_MS).all();
  stats.expiredPending = exp.results.length;

  // 2. Delete everyone whose region deadline has passed: nothing more will be sent to them.
  const past = REGIONS.filter((r) => r.deadline < today).map((r) => r.id);
  if (past.length) {
    const q = past.map(() => "?").join(",");
    await env.DB.prepare(`DELETE FROM sends WHERE subscriber_id IN (SELECT id FROM subscribers WHERE region IN (${q}))`).bind(...past).run();
    const del = await env.DB.prepare(`DELETE FROM subscribers WHERE region IN (${q}) RETURNING id`).bind(...past).all();
    stats.deletedAfterDeadline = del.results.length;
  }
  await env.DB.prepare("DELETE FROM sends WHERE subscriber_id NOT IN (SELECT id FROM subscribers)").run();

  // 3. Send due reminders, each at most once per subscriber.
  const maxSends = num(env.MAX_SENDS_PER_RUN, 40);
  const delay = num(env.SEND_DELAY_MS, 600);
  outer: for (const region of REGIONS) {
    for (const due of dueReminders(region.id, today)) {
      const remaining = maxSends - stats.sent - stats.failed;
      if (remaining <= 0) { stats.capped = true; break outer; }
      const { results } = await env.DB.prepare(
        `SELECT s.id, s.email, s.unsub_token FROM subscribers s
         WHERE s.status = 'confirmed' AND s.region = ?
           AND NOT EXISTS (SELECT 1 FROM sends x WHERE x.subscriber_id = s.id AND x.reminder_key = ?)
         ORDER BY s.id LIMIT ?`,
      ).bind(region.id, due.key, remaining).all();
      if (results.length >= remaining) stats.capped = true; // there may be more; a later run picks them up
      for (const sub of results) {
        // Claim first: if another run already claimed this (subscriber, reminder), skip it.
        const claim = await env.DB.prepare("INSERT OR IGNORE INTO sends (subscriber_id, reminder_key, sent_at) VALUES (?, ?, ?)")
          .bind(sub.id, due.key, nowMs).run();
        if (!claim.meta.changes) continue;
        const { unsubUrl } = links(env, sub.unsub_token);
        const msg = reminderEmail({ regionId: region.id, key: due.key, unsubUrl });
        try {
          await sendEmail(env, { to: sub.email, ...msg, unsubUrl, idempotencyKey: `reminder-${sub.id}-${due.key}` });
          stats.sent++;
        } catch (e) {
          // Release the claim so a later run (within the catch-up allowance) can retry.
          await env.DB.prepare("DELETE FROM sends WHERE subscriber_id = ? AND reminder_key = ?").bind(sub.id, due.key).run();
          stats.failed++;
          console.error("reminder send failed", e.message);
        }
        await sleep(delay); // Resend's default API rate limit is a few requests per second
      }
    }
  }
  return stats;
}

