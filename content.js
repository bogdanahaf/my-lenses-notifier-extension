(() => {
  "use strict";

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  // After chrome://extensions Reload, old content scripts stay alive but their
  // chrome.* APIs die ("Extension context invalidated"). Tear them down so a
  // freshly injected copy can take over.
  if (typeof window.__myLensesNotifyShutdown === "function") {
    try {
      window.__myLensesNotifyShutdown();
    } catch {
      /* ignore */
    }
  } else if (
    window.__myLensesNotifyContentLoaded &&
    extensionAlive() &&
    window.__myLensesNotifyExtId === chrome.runtime.id
  ) {
    return;
  }

  window.__myLensesNotifyContentLoaded = true;
  window.__myLensesNotifyExtId = extensionAlive() ? chrome.runtime.id : null;

  const Shared = window.MyLensesNotifyShared;
  const BUTTON_ID = "subtropic-mln-notify-btn";
  const BANNER_ID = "subtropic-mln-banner";

  let currentHref = location.href;
  let lastBoundStatusKey = "";
  let detectScheduled = false;
  let stopped = false;
  const timers = new Set();
  let observer = null;
  let urlPollId = null;
  let statusPollId = null;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  function shutdown() {
    if (stopped) {
      return;
    }
    stopped = true;
    try {
      observer?.disconnect();
    } catch {
      /* ignore */
    }
    observer = null;
    if (urlPollId != null) {
      clearInterval(urlPollId);
      urlPollId = null;
    }
    if (statusPollId != null) {
      clearInterval(statusPollId);
      statusPollId = null;
    }
    for (const id of timers) {
      clearTimeout(id);
    }
    timers.clear();
    try {
      window.removeEventListener("popstate", onPossibleNavigation);
    } catch {
      /* ignore */
    }
    try {
      history.pushState = originalPushState;
      history.replaceState = originalReplaceState;
    } catch {
      /* ignore */
    }
    clearUi();
    window.__myLensesNotifyContentLoaded = false;
    window.__myLensesNotifyExtId = null;
    window.__myLensesNotifyShutdown = null;
  }

  window.__myLensesNotifyShutdown = shutdown;

  function guardOrStop() {
    if (stopped) {
      return false;
    }
    if (!extensionAlive()) {
      shutdown();
      return false;
    }
    return true;
  }

  function sendMessageSafe(payload) {
    if (!guardOrStop()) {
      return Promise.resolve(null);
    }
    try {
      return chrome.runtime.sendMessage(payload).catch((error) => {
        const text = String(error?.message || error || "");
        if (/extension context invalidated/i.test(text)) {
          shutdown();
          return null;
        }
        throw error;
      });
    } catch (error) {
      const text = String(error?.message || error || "");
      if (/extension context invalidated/i.test(text)) {
        shutdown();
        return Promise.resolve(null);
      }
      return Promise.reject(error);
    }
  }

  function currentLensId() {
    return Shared.lensIdFromUrl(location.href);
  }

  function isCssVisible(element) {
    if (element.hidden || element.getAttribute("aria-hidden") === "true") {
      return false;
    }
    const style = getComputedStyle(element);
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0"
    );
  }

  function isVisible(element) {
    return isCssVisible(element) && element.getClientRects().length > 0;
  }

  function findStatus() {
    const statusByLowercase = new Map(
      Shared.KNOWN_STATUSES.map((status) => [status.toLowerCase(), status]),
    );

    // Background watcher tabs often have empty client rects until focused.
    // Prefer painted nodes; fall back to CSS-visible matches when needed.
    const candidates = [];
    for (const element of document.querySelectorAll("body *")) {
      if (element.children.length > 0 || !isCssVisible(element)) {
        continue;
      }
      const text = Shared.normalize(element.textContent || "");
      const status = statusByLowercase.get(text.toLowerCase());
      if (!status) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      candidates.push({
        element,
        status,
        painted: element.getClientRects().length > 0,
        documentTop: rect.top + window.scrollY,
      });
    }
    candidates.sort((a, b) => {
      if (a.painted !== b.painted) {
        return a.painted ? -1 : 1;
      }
      return a.documentTop - b.documentTop;
    });
    const painted = candidates.filter((c) => c.painted);
    return (painted.length ? painted : candidates)[0] || null;
  }

  function getLensName(lensId) {
    const bodyText = document.body?.innerText || "";
    const nameMatch = bodyText.match(/Lens Name\s*\n\s*([^\n]+)/i);
    if (nameMatch?.[1]) {
      const fromLabel = Shared.normalize(nameMatch[1]);
      if (
        fromLabel &&
        !["untitled", "lenses", "my lenses"].includes(fromLabel.toLowerCase())
      ) {
        return fromLabel;
      }
    }

    const heading = [...document.querySelectorAll("h1, h2, h3")]
      .filter(isVisible)
      .map((element) => Shared.normalize(element.textContent || ""))
      .find(
        (text) =>
          text &&
          !["lenses", "my lenses", "untitled"].includes(text.toLowerCase()),
      );
    return heading || `Lens ${(lensId || "unknown").slice(0, 8)}`;
  }

  function clearUi() {
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
    lastBoundStatusKey = "";
  }

  function reportStatus(lensId, status, lensName) {
    return sendMessageSafe({
      type: "STATUS_REPORT",
      lensId,
      status,
      lensName: lensName || getLensName(lensId),
      url: location.href,
    });
  }

  function ensureBanner(watching) {
    let banner = document.getElementById(BANNER_ID);
    if (!watching) {
      banner?.remove();
      return;
    }
    if (!banner) {
      banner = document.createElement("div");
      banner.id = BANNER_ID;
      banner.style.cssText = [
        "position:fixed",
        "left:16px",
        "bottom:16px",
        "z-index:2147483646",
        "max-width:340px",
        "padding:10px 12px",
        "border-radius:10px",
        "background:#1f2a33",
        "color:#fff",
        "font:600 12px/1.4 system-ui,sans-serif",
        "box-shadow:0 8px 24px rgba(0,0,0,.25)",
      ].join(";");
      document.documentElement.appendChild(banner);
    }
    banner.textContent =
      "My Lenses Notify is watching this Lens. Keep Chrome open — do not sleep the laptop.";
  }

  function updateButton(button, watching, status) {
    button.textContent = watching ? "Stop watching" : "Notify me";
    button.dataset.watching = String(watching);
    button.title = watching
      ? "Stop watching this submission"
      : `Email me when “${status}” changes`;
    button.style.borderColor = watching ? "#E67E22" : "#0fadff";
    button.style.color = watching ? "#E67E22" : "#0077b6";
  }

  async function createButton(lensId, statusElement, status) {
    if (!guardOrStop()) {
      return null;
    }

    // If React re-rendered the status node, re-attach the button next to it.
    let button = document.getElementById(BUTTON_ID);
    if (button && button.previousElementSibling !== statusElement) {
      button.remove();
      button = null;
    }

    if (!button) {
      button = document.createElement("button");
      button.id = BUTTON_ID;
      button.type = "button";
      button.style.cssText = [
        "margin-left:10px",
        "padding:6px 10px",
        "border:1px solid #0fadff",
        "border-radius:6px",
        "background:#fff",
        "color:#0077b6",
        "font:600 13px/1.2 system-ui,sans-serif",
        "cursor:pointer",
        "vertical-align:middle",
      ].join(";");
      statusElement.insertAdjacentElement("afterend", button);

      button.addEventListener("click", async () => {
        if (!guardOrStop()) {
          return;
        }
        const activeLensId = currentLensId();
        if (!activeLensId) {
          return;
        }
        const activeStatus = findStatus()?.status || status;
        button.disabled = true;
        try {
          const state = await sendMessageSafe({
            type: "IS_WATCHING",
            lensId: activeLensId,
          });
          if (!state) {
            return;
          }
          if (state?.watching) {
            await sendMessageSafe({
              type: "STOP_WATCH",
              lensId: activeLensId,
              closeTab: false,
            });
            updateButton(button, false, activeStatus);
            ensureBanner(false);
            return;
          }

          if (!state?.email) {
            alert(
              "Open the My Lenses Notify extension icon and save your email first.",
            );
            return;
          }

          const result = await sendMessageSafe({
            type: "START_WATCH",
            lensId: activeLensId,
            lensName: getLensName(activeLensId),
            url: location.href,
            status: activeStatus,
          });

          if (!result?.ok) {
            alert(result?.error || "Could not start watching.");
            return;
          }

          updateButton(button, true, activeStatus);
          ensureBanner(true);
        } finally {
          button.disabled = false;
        }
      });
    } else if (!button.isConnected) {
      statusElement.insertAdjacentElement("afterend", button);
    }

    const state = await sendMessageSafe({
      type: "IS_WATCHING",
      lensId,
    });
    if (!state) {
      return null;
    }
    updateButton(button, Boolean(state?.watching), status);
    ensureBanner(Boolean(state?.watching));
    return button;
  }

  async function handleDetected(lensId, result) {
    const bindKey = `${lensId}:${result.status}:${location.href}`;
    const alreadyBound =
      lastBoundStatusKey === bindKey && document.getElementById(BUTTON_ID);

    await createButton(lensId, result.element, result.status);
    lastBoundStatusKey = bindKey;

    if (!alreadyBound || Shared.isPending(result.status)) {
      await reportStatus(lensId, result.status, getLensName(lensId));
    }
  }

  function detectAndBind() {
    if (!guardOrStop()) {
      return false;
    }
    const lensId = currentLensId();
    if (!lensId) {
      clearUi();
      return false;
    }

    const result = findStatus();
    if (!result) {
      // Lens route is open but SPA content not ready yet — keep waiting.
      return false;
    }

    // Only offer the button for pending statuses (or if already watching).
    sendMessageSafe({ type: "IS_WATCHING", lensId })
      .then(async (state) => {
        if (!state || !guardOrStop()) {
          return;
        }
        if (Shared.isPending(result.status) || state?.watching) {
          await handleDetected(lensId, result);
        } else {
          // Not pending and not watching — don't force a Notify button on Live pages.
          document.getElementById(BUTTON_ID)?.remove();
          ensureBanner(false);
          if (state?.watching) {
            await reportStatus(lensId, result.status, getLensName(lensId));
          }
        }
      })
      .catch((error) => {
        if (!guardOrStop()) {
          return;
        }
        console.warn("[My Lenses Notify] detect failed", error);
      });

    return true;
  }

  function scheduleDetect() {
    if (stopped || detectScheduled) {
      return;
    }
    detectScheduled = true;
    requestAnimationFrame(() => {
      detectScheduled = false;
      if (!guardOrStop()) {
        return;
      }
      detectAndBind();
    });
  }

  function later(fn, ms) {
    const id = setTimeout(() => {
      timers.delete(id);
      if (!guardOrStop()) {
        return;
      }
      fn();
    }, ms);
    timers.add(id);
    return id;
  }

  function onPossibleNavigation() {
    if (!guardOrStop()) {
      return;
    }
    if (location.href === currentHref) {
      scheduleDetect();
      return;
    }
    currentHref = location.href;
    lastBoundStatusKey = "";
    // Old button may belong to previous SPA view.
    document.getElementById(BUTTON_ID)?.remove();
    scheduleDetect();
    // SPA content often arrives a bit later.
    later(scheduleDetect, 300);
    later(scheduleDetect, 1000);
    later(scheduleDetect, 2500);
    later(scheduleDetect, 5000);
  }

  async function sendFormSubmitEmail({ email, subject, message }) {
    const response = await fetch(
      `https://formsubmit.co/ajax/${encodeURIComponent(email)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          name: "My Lenses Notify",
          _subject: subject,
          message,
          _template: "table",
          _captcha: "false",
          _url: location.href,
        }),
      },
    );

    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }

    const successFlag = json?.success;
    const okFlag =
      successFlag === true ||
      successFlag === "true" ||
      successFlag === 1 ||
      successFlag === "1";
    const messageText = String(json?.message || text || "");
    const needsActivation = /activation|activate form/i.test(messageText);

    if (needsActivation) {
      return {
        ok: true,
        needsActivation: true,
        message: messageText,
        httpStatus: response.status,
        body: text,
        json,
      };
    }

    if (!response.ok || (json && successFlag != null && !okFlag)) {
      const err = new Error(messageText || `HTTP ${response.status}`);
      err.payload = { httpStatus: response.status, body: text, json };
      throw err;
    }

    return {
      ok: true,
      httpStatus: response.status,
      body: text,
      json,
      message: messageText || null,
    };
  }

  try {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!guardOrStop()) {
        return false;
      }
      if (message?.type === "SEND_FORM_EMAIL") {
        sendFormSubmitEmail(message)
          .then((result) => sendResponse(result))
          .catch((error) =>
            sendResponse({
              ok: false,
              error: error.message || String(error),
              payload: error.payload || null,
            }),
          );
        return true;
      }

      if (message?.type === "REQUEST_STATUS") {
        const lensId = currentLensId();
        if (!lensId) {
          sendResponse({ ok: false, error: "Not a Lens detail page" });
          return false;
        }
        const result = findStatus();
        if (result) {
          reportStatus(lensId, result.status, getLensName(lensId))
            .then((response) => sendResponse(response || { ok: true }))
            .catch((error) =>
              sendResponse({ ok: false, error: error.message || String(error) }),
            );
          return true;
        }
        sendResponse({ ok: false, error: "Status not found yet" });
        return false;
      }

      return false;
    });
  } catch {
    shutdown();
    return;
  }

  // Patch history so SPA navigations are visible to the extension.
  history.pushState = function patchedPushState(...args) {
    const ret = originalPushState.apply(this, args);
    onPossibleNavigation();
    return ret;
  };
  history.replaceState = function patchedReplaceState(...args) {
    const ret = originalReplaceState.apply(this, args);
    onPossibleNavigation();
    return ret;
  };
  window.addEventListener("popstate", onPossibleNavigation);

  observer = new MutationObserver(() => {
    onPossibleNavigation();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  // Lightweight URL poll — some routers don't use pushState consistently.
  urlPollId = setInterval(() => {
    if (!guardOrStop()) {
      return;
    }
    if (location.href !== currentHref) {
      onPossibleNavigation();
      return;
    }
    if (currentLensId() && !document.getElementById(BUTTON_ID)) {
      scheduleDetect();
    }
  }, 1000);

  // Periodic status report for active watches on this page.
  statusPollId = setInterval(() => {
    if (!guardOrStop()) {
      return;
    }
    const lensId = currentLensId();
    if (!lensId) {
      return;
    }
    const result = findStatus();
    if (!result) {
      return;
    }
    if (Shared.isPending(result.status) && !document.getElementById(BUTTON_ID)) {
      scheduleDetect();
    }
    reportStatus(lensId, result.status, getLensName(lensId)).catch(() => {});
  }, 15_000);

  // Initial pass.
  onPossibleNavigation();
})();
