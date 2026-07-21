(() => {
  "use strict";

  const runtimeKey = "__myLensesNotifyPageV2";
  const previous = globalThis[runtimeKey];
  if (previous?.dispose) {
    try {
      previous.dispose();
    } catch {
      /* stale extension context */
    }
  }

  const Shared = globalThis.MyLensesNotify;
  if (!Shared) {
    console.warn("[My Lenses Notify] common.js was not loaded");
    return;
  }

  const BUTTON_ID = "my-lenses-notify-button";
  const BANNER_ID = "my-lenses-notify-banner";
  const timers = new Set();
  let disposed = false;
  let detectTimer = null;
  let observer = null;
  let pageTick = null;
  let currentUrl = location.href;
  let lastReportKey = "";
  let lastReportAt = 0;

  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  const state = {
    dispose,
    refresh: scheduleDetect,
  };
  globalThis[runtimeKey] = state;

  function extensionAlive() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function dispose() {
    if (disposed) {
      return;
    }
    disposed = true;
    observer?.disconnect();
    observer = null;
    if (detectTimer != null) {
      clearTimeout(detectTimer);
      detectTimer = null;
    }
    if (pageTick != null) {
      clearInterval(pageTick);
      pageTick = null;
    }
    for (const timer of timers) {
      clearTimeout(timer);
    }
    timers.clear();
    window.removeEventListener("popstate", onNavigation);
    try {
      chrome.storage?.onChanged?.removeListener(onStorageChanged);
      chrome.runtime?.onMessage?.removeListener(onRuntimeMessage);
    } catch {
      /* invalidated extension context */
    }
    if (history.pushState === patchedPushState) {
      history.pushState = originalPushState;
    }
    if (history.replaceState === patchedReplaceState) {
      history.replaceState = originalReplaceState;
    }
    removeUi();
    if (globalThis[runtimeKey] === state) {
      delete globalThis[runtimeKey];
    }
  }

  async function sendRuntime(message) {
    if (disposed || !extensionAlive()) {
      dispose();
      return null;
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (
        /extension context invalidated/i.test(String(error?.message || error))
      ) {
        dispose();
        return null;
      }
      throw error;
    }
  }

  function lensId() {
    return Shared.lensIdFromUrl(location.href);
  }

  function isCssVisible(element) {
    for (
      let current = element;
      current && current !== document.documentElement;
      current = current.parentElement
    ) {
      if (current.hidden || current.getAttribute("aria-hidden") === "true") {
        return false;
      }
      const style = getComputedStyle(current);
      if (style.display === "none" || style.visibility === "hidden") {
        return false;
      }
    }
    return true;
  }

  function elementDepth(element) {
    let depth = 0;
    for (let current = element; current; current = current.parentElement) {
      depth += 1;
    }
    return depth;
  }

  function findStatus() {
    const candidates = [];
    for (const element of document.querySelectorAll("body *")) {
      if (
        element.id === BUTTON_ID ||
        element.id === BANNER_ID ||
        element.closest(`#${BUTTON_ID}, #${BANNER_ID}`)
      ) {
        continue;
      }
      const text = Shared.normalize(element.textContent);
      const status = Shared.canonicalStatus(text);
      if (!status || !isCssVisible(element)) {
        continue;
      }
      candidates.push({
        element,
        status,
        childCount: element.childElementCount,
        depth: elementDepth(element),
      });
    }

    candidates.sort((a, b) => a.childCount - b.childCount || b.depth - a.depth);
    return candidates[0] || null;
  }

  function findLensName(currentLensId) {
    const text = document.body?.innerText || "";
    const match = text.match(/Lens Name\s*\n\s*([^\n]+)/i);
    if (match?.[1]) {
      const name = Shared.normalize(match[1]);
      if (
        name &&
        !["lenses", "my lenses", "untitled"].includes(name.toLowerCase())
      ) {
        return name;
      }
    }

    const heading = [...document.querySelectorAll("h1, h2, h3")]
      .filter(isCssVisible)
      .map((element) => Shared.normalize(element.textContent))
      .find(
        (value) =>
          value &&
          !["lenses", "my lenses", "untitled"].includes(value.toLowerCase()),
      );
    return heading || `Lens ${(currentLensId || "unknown").slice(0, 8)}`;
  }

  function removeUi() {
    document.getElementById(BUTTON_ID)?.remove();
    document.getElementById(BANNER_ID)?.remove();
  }

  function setBanner(visible) {
    let banner = document.getElementById(BANNER_ID);
    if (!visible) {
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
      "My Lenses Notify is watching this Lens. Keep Chrome open and leave the pinned watcher tab open.";
  }

  function styleButton(button, watching, status) {
    button.textContent = watching ? "Stop watching" : "Notify me";
    button.dataset.watching = String(watching);
    button.title = watching
      ? "Stop watching this submission"
      : `Email me when “${status}” changes`;
    button.style.borderColor = watching ? "#e67e22" : "#0fadff";
    button.style.color = watching ? "#e67e22" : "#0077b6";
  }

  function ensureButton(statusResult, currentLensId, watching) {
    let button = document.getElementById(BUTTON_ID);
    if (button && button.previousElementSibling !== statusResult.element) {
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
      statusResult.element.insertAdjacentElement("afterend", button);
      button.addEventListener("click", () => {
        onButtonClick(button, currentLensId, statusResult.status).catch(
          (error) => {
            alert(error?.message || String(error));
          },
        );
      });
    }

    styleButton(button, watching, statusResult.status);
    setBanner(watching);
  }

  async function onButtonClick(button, currentLensId, fallbackStatus) {
    button.disabled = true;
    try {
      const current = findStatus();
      const status = current?.status || fallbackStatus;
      const response = await sendRuntime({
        type: button.dataset.watching === "true" ? "STOP_WATCH" : "START_WATCH",
        lensId: currentLensId,
        lensName: findLensName(currentLensId),
        url: location.href,
        status,
      });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not update watch.");
      }
      await detect();
    } finally {
      button.disabled = false;
    }
  }

  async function reportStatus(currentLensId, result, force = false) {
    const key = `${currentLensId}:${result.status}`;
    const now = Date.now();
    if (!force && key === lastReportKey && now - lastReportAt < 30_000) {
      return;
    }
    lastReportKey = key;
    lastReportAt = now;
    await sendRuntime({
      type: "STATUS_REPORT",
      lensId: currentLensId,
      lensName: findLensName(currentLensId),
      status: result.status,
      url: location.href,
    });
  }

  async function detect() {
    if (disposed || !extensionAlive()) {
      dispose();
      return;
    }

    const currentLensId = lensId();
    if (!currentLensId) {
      removeUi();
      return;
    }

    const statusResult = findStatus();
    if (!statusResult) {
      document.getElementById(BUTTON_ID)?.remove();
      return;
    }

    const stateResponse = await sendRuntime({
      type: "IS_WATCHING",
      lensId: currentLensId,
    });
    if (!stateResponse) {
      return;
    }

    const watching = Boolean(stateResponse.watching);
    if (watching || Shared.isPending(statusResult.status)) {
      ensureButton(statusResult, currentLensId, watching);
    } else {
      removeUi();
    }

    if (watching) {
      await reportStatus(currentLensId, statusResult);
    }
  }

  function scheduleDetect(delay = 100) {
    if (disposed) {
      return;
    }
    if (detectTimer != null) {
      clearTimeout(detectTimer);
    }
    detectTimer = setTimeout(() => {
      detectTimer = null;
      detect().catch((error) => {
        if (
          !/extension context invalidated/i.test(
            String(error?.message || error),
          )
        ) {
          console.warn("[My Lenses Notify] page detection failed", error);
        }
      });
    }, delay);
  }

  function later(delay) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      scheduleDetect(0);
    }, delay);
    timers.add(timer);
  }

  function onNavigation() {
    if (location.href !== currentUrl) {
      currentUrl = location.href;
      removeUi();
      lastReportKey = "";
    }
    scheduleDetect(0);
    later(500);
    later(1500);
    later(4000);
  }

  function patchedPushState(...args) {
    const result = originalPushState.apply(history, args);
    onNavigation();
    return result;
  }

  function patchedReplaceState(...args) {
    const result = originalReplaceState.apply(history, args);
    onNavigation();
    return result;
  }

  function onStorageChanged(changes, area) {
    if (area === "local" && changes[Shared.STORAGE_KEYS.watches]) {
      scheduleDetect(0);
    }
  }

  async function tick() {
    if (disposed || !extensionAlive()) {
      dispose();
      return;
    }
    const currentLensId = lensId();
    if (!currentLensId) {
      return;
    }
    const result = findStatus();
    if (result) {
      await reportStatus(currentLensId, result, true);
    }
    await sendRuntime({
      type: "PAGE_TICK",
      lensId: currentLensId,
      status: result?.status || null,
      lensName: findLensName(currentLensId),
      url: location.href,
    });
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
      /* non-JSON failure response */
    }

    const success = json?.success;
    const accepted =
      success === true ||
      success === "true" ||
      success === 1 ||
      success === "1";
    const responseMessage = String(json?.message || text || "");
    const needsActivation = /activation|activate form/i.test(responseMessage);

    if (needsActivation) {
      return {
        ok: true,
        needsActivation: true,
        message: responseMessage,
        httpStatus: response.status,
        body: text,
        json,
      };
    }

    if (!response.ok || (json && success != null && !accepted)) {
      return {
        ok: false,
        error: responseMessage || `HTTP ${response.status}`,
        httpStatus: response.status,
        body: text,
        json,
      };
    }

    return {
      ok: true,
      message: responseMessage || null,
      httpStatus: response.status,
      body: text,
      json,
    };
  }

  function onRuntimeMessage(message, _sender, sendResponse) {
    if (message?.type === "REFRESH_UI") {
      scheduleDetect(0);
      sendResponse({ ok: true });
      return false;
    }

    if (message?.type === "REQUEST_STATUS") {
      const currentLensId = lensId();
      const result = findStatus();
      sendResponse({
        ok: Boolean(currentLensId && result),
        lensId: currentLensId,
        status: result?.status || null,
        lensName: currentLensId ? findLensName(currentLensId) : null,
      });
      return false;
    }

    if (message?.type === "SEND_FORM_EMAIL") {
      sendFormSubmitEmail(message)
        .then(sendResponse)
        .catch((error) =>
          sendResponse({ ok: false, error: error?.message || String(error) }),
        );
      return true;
    }

    return false;
  }

  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  chrome.storage.onChanged.addListener(onStorageChanged);
  history.pushState = patchedPushState;
  history.replaceState = patchedReplaceState;
  window.addEventListener("popstate", onNavigation);

  observer = new MutationObserver(() => scheduleDetect());
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  pageTick = setInterval(() => {
    tick().catch(() => {});
  }, Shared.PAGE_TICK_MS);

  onNavigation();
})();
