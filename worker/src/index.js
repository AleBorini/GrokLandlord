// Landlord register reminders: Cloudflare Worker (D1 + Cron Trigger + Resend HTTP API).
// Endpoints: POST /subscribe, GET /confirm?token=, GET|POST /unsubscribe?token=. Cron: scheduled().
import { subscribe, confirm, unsubscribe, corsHeaders, json, runCron } from "./lib.js";

// ---------- router ----------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const allowed = String(env.ALLOWED_ORIGIN || "");

    if (url.pathname === "/subscribe") {
      if (!origin || origin !== allowed) return json(403, { ok: false, error: "origin", message: "Forbidden." });
      const cors = corsHeaders(env, origin);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
      if (request.method !== "POST") return json(405, { ok: false, error: "method", message: "Use POST." }, { ...cors, Allow: "POST, OPTIONS" });
      try {
        return await subscribe(request, env, cors);
      } catch (e) {
        console.error("subscribe error", e.message);
        return json(500, { ok: false, error: "server", message: "Something went wrong. Please try again later." }, cors);
      }
    }
    if (url.pathname === "/confirm" && request.method === "GET") return confirm(url, env);
    // GET = the link in the email; POST = RFC 8058 one-click unsubscribe from the mail app.
    if (url.pathname === "/unsubscribe" && (request.method === "GET" || request.method === "POST")) return unsubscribe(url, env);
    return json(404, { ok: false, error: "not_found" });
  },

  async scheduled(controller, env, ctx) {
    const stats = await runCron(env, controller.scheduledTime);
    console.log("cron", JSON.stringify(stats));
  },
};
