// Email copy. Plain, factual, no legal advice. Every email carries the "independent / not affiliated /
// register only at gov.uk" line and an unsubscribe link. All dates are absolute (never "in 7 days"),
// so an email is still accurate if it goes out a day late.
import { REGION_BY_ID, REMINDER_POINTS, longDate, DATES_CHECKED } from "./regions.js";

export const GOV_UK_URL = "https://www.gov.uk/government/news/stronger-protections-and-greater-confidence-for-renters";
export const HOUSING_HUB_URL = "https://housinghub.campaign.gov.uk/renting-is-changing/get-ready-to-register/";

export const DISCLAIMER =
  "This is an independent reminder service. It is not affiliated with the UK government and it is not the official register. " +
  "You can only register at gov.uk:";

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function footerText(unsubUrl) {
  return [
    "--",
    `${DISCLAIMER} ${GOV_UK_URL}`,
    "General information only, not legal advice. Dates checked against gov.uk on " + DATES_CHECKED + "; always check gov.uk before acting.",
    "",
    `Unsubscribe (deletes your email address straight away): ${unsubUrl}`,
  ].join("\n");
}

function footerHtml(unsubUrl) {
  return `<hr style="border:0;border-top:1px solid #d4d9e2;margin:24px 0 12px">
<p style="font-size:13px;color:#4a5873;margin:0 0 8px">${esc(DISCLAIMER)} <a href="${esc(GOV_UK_URL)}">gov.uk</a>.</p>
<p style="font-size:13px;color:#4a5873;margin:0 0 8px">General information only, not legal advice. Dates checked against gov.uk on ${esc(DATES_CHECKED)}; always check gov.uk before acting.</p>
<p style="font-size:13px;color:#4a5873;margin:0"><a href="${esc(unsubUrl)}">Unsubscribe</a> (deletes your email address straight away).</p>`;
}

function wrapHtml(paragraphs, unsubUrl) {
  const body = paragraphs
    .map((p) => (p.href ? `<p style="margin:0 0 14px"><a href="${esc(p.href)}">${esc(p.text)}</a></p>` : `<p style="margin:0 0 14px">${esc(p)}</p>`))
    .join("\n");
  return `<!DOCTYPE html><html lang="en-GB"><body style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#14213d;max-width:560px;margin:0 auto;padding:16px">
${body}
${footerHtml(unsubUrl)}
</body></html>`;
}

function asText(paragraphs, unsubUrl) {
  return paragraphs.map((p) => (p.href ? `${p.text}: ${p.href}` : p)).join("\n\n") + "\n\n" + footerText(unsubUrl) + "\n";
}

/** Double opt-in confirmation email. */
export function confirmationEmail({ regionId, confirmUrl, unsubUrl }) {
  const r = REGION_BY_ID[regionId];
  const subject = `Confirm your ${r.name} landlord register reminders`;
  const paras = [
    `Someone (hopefully you) asked for free email reminders about the landlord register window for rental properties in ${r.name}.`,
    { text: "Confirm your reminders", href: confirmUrl },
    `If you confirm, you will get up to four short emails: a week before the ${r.name} window opens on ${longDate(r.opens)}, ` +
      `when it opens, and 30 days and 7 days before the ${r.name} deadline on ${longDate(r.deadline)}. ` +
      `After the deadline we delete your email address.`,
    "If you did not ask for this, ignore this email. Nothing will be sent and this address will be deleted within 7 days.",
  ];
  return { subject, text: asText(paras, unsubUrl), html: wrapHtml(paras, unsubUrl) };
}

/** Reminder email for one of the fixed REMINDER_POINTS. */
export function reminderEmail({ regionId, key, unsubUrl }) {
  const r = REGION_BY_ID[regionId];
  if (!REMINDER_POINTS.some((p) => p.key === key)) throw new Error(`unknown reminder ${key}`);
  const opens = longDate(r.opens);
  const deadline = longDate(r.deadline);
  const window = `The registration window for rental properties in ${r.name} runs from ${opens} to ${deadline}.`;
  const where = "The deadline follows where the rental property is, not where you live.";
  const official = { text: "Official guidance on registering and what you will be asked for (Housing Hub)", href: HOUSING_HUB_URL };
  let subject;
  let paras;
  switch (key) {
    case "opens-7":
      subject = `${r.name}: the landlord register opens on ${opens}`;
      paras = [`The landlord register window for ${r.name} opens on ${opens}.`, window, where, official];
      break;
    case "opens-0":
      subject = `${r.name}: the landlord register window is now open`;
      paras = [`The landlord register window for ${r.name} opened on ${opens}. The deadline to register is ${deadline}.`, where, official];
      break;
    case "deadline-30":
      subject = `Reminder: the ${r.name} landlord register deadline is ${deadline}`;
      paras = [`The deadline to register rental properties in ${r.name} is ${deadline}.`, window, where, official];
      break;
    case "deadline-7":
      subject = `Last reminder: the ${r.name} landlord register deadline is ${deadline}`;
      paras = [
        `The deadline to register rental properties in ${r.name} is ${deadline}.`,
        where,
        official,
        "This is the last reminder for this region. We will delete your email address after the deadline.",
      ];
      break;
  }
  return { subject, text: asText(paras, unsubUrl), html: wrapHtml(paras, unsubUrl) };
}
