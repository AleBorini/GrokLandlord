// Email reminders sign-up form. Only shipped when the site is built with REMINDERS_ENABLED=1.
// Sends JSON to <data-endpoint>/subscribe. The page's CSP connect-src allows that URL only.
(function () {
  "use strict";
  var form = document.getElementById("rm-form");
  if (!form || !window.fetch) return;
  var endpoint = (form.getAttribute("data-endpoint") || "").replace(/\/+$/, "") + "/subscribe";
  var email = document.getElementById("rm-email");
  var region = document.getElementById("rm-region");
  var consent = document.getElementById("rm-consent");
  var hp = document.getElementById("rm-website");
  var status = document.getElementById("rm-status");
  var submit = document.getElementById("rm-submit");
  var fields = { email: email, region: region, consent: consent };
  var EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function setErr(name, msg) {
    var el = fields[name];
    var out = document.getElementById("rm-" + name + "-err");
    if (msg) el.setAttribute("aria-invalid", "true"); else el.removeAttribute("aria-invalid");
    if (out) out.textContent = msg || "";
  }
  function setStatus(msg, ok) {
    status.textContent = msg;
    status.className = "rm-status " + (ok ? "ok" : "bad");
  }
  function validate() {
    var errs = {};
    if (!EMAIL_RE.test(email.value.trim())) errs.email = "Enter a valid email address.";
    if (!region.value) errs.region = "Choose your property's region.";
    if (!consent.checked) errs.consent = "Tick the box to agree to receive the reminder emails.";
    return errs;
  }
  function show(errs) {
    ["email", "region", "consent"].forEach(function (k) { setErr(k, errs[k]); });
    var first = ["email", "region", "consent"].filter(function (k) { return errs[k]; })[0];
    if (first) fields[first].focus();
    return !first;
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    setStatus("", true);
    if (!show(validate())) return;
    submit.disabled = true;
    setStatus("Sending…", true);
    fetch(endpoint, {
      method: "POST",
      mode: "cors",
      credentials: "omit",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.value.trim(), region: region.value, consent: consent.checked, website: hp ? hp.value : "" }),
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (j) { return { res: res, j: j }; });
      })
      .then(function (r) {
        if (r.res.ok && r.j.ok) {
          setStatus(r.j.message || "Thanks. Check your inbox and click the link to confirm your reminders.", true);
          form.reset();
          if (form.getAttribute("data-region")) region.value = form.getAttribute("data-region");
          return;
        }
        if (r.j.fields) show(r.j.fields);
        setStatus(r.j.message || "Something went wrong. Please try again later.", false);
      })
      .catch(function () {
        setStatus("We couldn't reach the reminder service. Please try again later.", false);
      })
      .then(function () { submit.disabled = false; });
  });
})();
