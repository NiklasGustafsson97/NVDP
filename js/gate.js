/* ══════════════════════════════════════════
   NVDP — Beta gate
   ══════════════════════════════════════════
   Moved out of an inline <script> in index.html so the page no longer
   contains executable JS in markup. Reduces the surface that requires
   `script-src 'unsafe-inline'` in CSP.

   Depends on: window.gateOpen / window.NVDP_resumeAfterGate / window.registerAction
   from app.js. Must therefore load AFTER app.js.
*/

(function () {
  const GATE_HASH = "33a2b6d3f27de37ace432551c50e254d5981bc28cb757832e30e5e0c531e3955";

  async function sha256(m) {
    const d = new TextEncoder().encode(m);
    const h = await crypto.subtle.digest("SHA-256", d);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, "0")).join("");
  }

  async function checkGate() {
    const v = document.getElementById("gate-pw").value;
    const h = await sha256(v);
    if (h === GATE_HASH) {
      document.getElementById("gate").style.display = "none";
      sessionStorage.setItem("gate_passed", "1");
      localStorage.setItem("nvdp_gate_passed", "1");
      bootApp();
      if (typeof window.NVDP_resumeAfterGate === "function") {
        await window.NVDP_resumeAfterGate();
      }
    } else {
      document.getElementById("gate-error").textContent = "Fel kod. Försök igen.";
      document.getElementById("gate-pw").value = "";
      document.getElementById("gate-pw").focus();
    }
  }

  function bootApp() {
    document.getElementById("auth-view").style.display = "flex";
  }

  // Register so markup can use data-action="gate-submit" instead of onclick.
  if (typeof window.registerAction === "function") {
    window.registerAction("gate-submit", () => { checkGate(); });
  }

  // The Enter key on the gate password input still needs to submit. We bind
  // it here in JS instead of inline onkeydown.
  document.addEventListener("DOMContentLoaded", () => {
    const pw = document.getElementById("gate-pw");
    if (pw) {
      pw.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
          ev.preventDefault();
          checkGate();
        }
      });
    }
  });

  // Skip gate if already passed OR if a Supabase session exists in localStorage.
  // Run immediately (don't wait for DOMContentLoaded — the gate element is
  // above the bottom <script> tags so it exists by the time we run).
  const hasSupabaseSession = Object.keys(localStorage).some(
    k => k.startsWith('sb-') && k.endsWith('-auth-token')
  );
  if ((typeof gateOpen === "function" && gateOpen()) || hasSupabaseSession) {
    const gateEl = document.getElementById("gate");
    if (gateEl) gateEl.style.display = "none";
    localStorage.setItem("nvdp_gate_passed", "1");
    sessionStorage.setItem("gate_passed", "1");
    bootApp();
  }

  // Expose for backwards compatibility (in case something still calls it directly).
  window.checkGate = checkGate;
  window.bootApp = bootApp;
})();
