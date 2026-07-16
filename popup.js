const emailInput = document.getElementById("email");
const saveEmailBtn = document.getElementById("saveEmail");
const testEmailBtn = document.getElementById("testEmail");
const keepAwakeInput = document.getElementById("keepAwake");
const watchList = document.getElementById("watchList");
const pollNowBtn = document.getElementById("pollNow");
const statusEl = document.getElementById("status");
const awakeHint = document.getElementById("awakeHint");
const emailLogEl = document.getElementById("emailLog");
const pollLogEl = document.getElementById("pollLog");
const desktopLogEl = document.getElementById("desktopLog");

function setStatus(text, isError = false) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function renderLog(el, log, emptyText) {
  const latest = Array.isArray(log) && log.length ? log[0] : null;
  el.textContent = latest ? JSON.stringify(latest, null, 2) : emptyText;
}

function renderWatches(watches) {
  const entries = Object.values(watches || {});
  awakeHint.hidden = entries.length === 0;

  if (!entries.length) {
    watchList.innerHTML =
      '<p class="empty">Nothing watching yet. Open a Processing Lens and click Notify me.</p>';
    return;
  }

  watchList.innerHTML = "";
  for (const watch of entries.sort((a, b) =>
    String(a.startedAt).localeCompare(String(b.startedAt)),
  )) {
    const item = document.createElement("div");
    item.className = "watch-item";
    item.innerHTML = `
      <strong></strong>
      <div class="meta"></div>
      <button type="button" class="danger">Stop</button>
    `;
    item.querySelector("strong").textContent = watch.lensName || watch.lensId;
    item.querySelector(".meta").textContent =
      `${watch.lastStatus || watch.initialStatus || "?"} · last seen ${
        watch.lastSeenAt
          ? new Date(watch.lastSeenAt).toLocaleTimeString()
          : "?"
      }`;
    item.querySelector("button").addEventListener("click", async () => {
      await chrome.runtime.sendMessage({
        type: "STOP_WATCH",
        lensId: watch.lensId,
        closeTab: true,
      });
      setStatus("Stopped watching.");
      await refresh();
    });
    watchList.appendChild(item);
  }
}

async function refresh() {
  const state = await chrome.runtime.sendMessage({ type: "GET_STATE" });
  if (!state?.ok) {
    setStatus(state?.error || "Could not load state.", true);
    return;
  }
  emailInput.value = state.email || "";
  keepAwakeInput.checked = state.keepAwake !== false;
  renderWatches(state.watches);
  renderLog(emailLogEl, state.emailLog, "No attempts yet.");
  renderLog(pollLogEl, state.pollLog, "No polls yet.");
  desktopLogEl.textContent = state.lastDesktopAlert
    ? JSON.stringify(state.lastDesktopAlert, null, 2)
    : "No desktop alerts yet.";
}

saveEmailBtn.addEventListener("click", async () => {
  const email = emailInput.value.trim();
  if (!email || !email.includes("@")) {
    setStatus("Enter a valid email.", true);
    return;
  }
  const result = await chrome.runtime.sendMessage({
    type: "SAVE_EMAIL",
    email,
  });
  if (!result?.ok) {
    setStatus(result?.error || "Save failed.", true);
    return;
  }
  setStatus("Email saved.");
});

testEmailBtn.addEventListener("click", async () => {
  setStatus("Sending test email…");
  const result = await chrome.runtime.sendMessage({ type: "SEND_TEST_EMAIL" });
  await refresh();
  if (!result?.ok) {
    setStatus(result?.error || "Test email failed.", true);
    return;
  }
  if (result.needsActivation) {
    setStatus(
      "FormSubmit sent an activation email. Open it, click Activate Form, then test again.",
    );
    return;
  }
  setStatus("Test accepted by FormSubmit. Check inbox + spam.");
});

keepAwakeInput.addEventListener("change", async () => {
  await chrome.runtime.sendMessage({
    type: "SET_KEEP_AWAKE",
    enabled: keepAwakeInput.checked,
  });
  setStatus(
    keepAwakeInput.checked
      ? "Keep-awake enabled while watching."
      : "Keep-awake disabled.",
  );
});

pollNowBtn.addEventListener("click", async () => {
  setStatus("Checking watches (reload + scrape)…");
  const result = await chrome.runtime.sendMessage({ type: "POLL_NOW" });
  await refresh();
  if (!result?.ok) {
    setStatus(result?.error || "Check failed.", true);
    return;
  }
  if (!result.count) {
    setStatus("Nothing to check — no active watches.");
    return;
  }
  const summary = (result.results || [])
    .map((item) => {
      if (item.completed) {
        return `${item.lensId.slice(0, 8)}… completed (${item.status})`;
      }
      if (item.ok) {
        return `${item.lensId.slice(0, 8)}… still ${item.status}`;
      }
      return `${item.lensId.slice(0, 8)}… error: ${item.error || "unknown"}`;
    })
    .join(" | ");
  setStatus(summary || "Check finished.");
});

refresh().catch((error) => {
  setStatus(error.message || String(error), true);
});
