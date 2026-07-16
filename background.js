importScripts("shared.js");

const Shared = globalThis.MyLensesNotifyShared;
const { STORAGE_KEYS, ALARM_NAME, CHECK_MINUTES } = Shared;

/** Prevents duplicate completion emails when poll + content script race. */
const completingLocks = new Set();

async function getSettings() {
  const data = await chrome.storage.local.get({
    [STORAGE_KEYS.email]: "",
    [STORAGE_KEYS.keepAwake]: true,
    [STORAGE_KEYS.watches]: {},
    [STORAGE_KEYS.emailActivated]: false,
    emailLog: [],
    pollLog: [],
  });
  return {
    email: String(data[STORAGE_KEYS.email] || "").trim(),
    keepAwake: Boolean(data[STORAGE_KEYS.keepAwake]),
    watches: data[STORAGE_KEYS.watches] || {},
    emailActivated: Boolean(data[STORAGE_KEYS.emailActivated]),
    emailLog: data.emailLog || [],
    pollLog: data.pollLog || [],
  };
}

async function setWatches(watches) {
  await chrome.storage.local.set({ [STORAGE_KEYS.watches]: watches });
  await syncPresence();
}

async function appendPollLog(entry) {
  const { pollLog } = await getSettings();
  const next = [{ at: new Date().toISOString(), ...entry }, ...pollLog].slice(
    0,
    20,
  );
  await chrome.storage.local.set({ pollLog: next });
}

function watchingIconPaths() {
  return {
    16: "icons/icon-watching-16.png",
    32: "icons/icon-watching-32.png",
    48: "icons/icon-watching-48.png",
    128: "icons/icon-watching-128.png",
  };
}

function idleIconPaths() {
  return {
    16: "icons/icon-16.png",
    32: "icons/icon-32.png",
    48: "icons/icon-48.png",
    128: "icons/icon-128.png",
  };
}

function doneIconPaths() {
  return {
    16: "icons/icon-done-16.png",
    32: "icons/icon-done-32.png",
    48: "icons/icon-done-48.png",
    128: "icons/icon-done-128.png",
  };
}

function isWeakLensName(name) {
  const value = Shared.normalize(name || "").toLowerCase();
  return (
    !value ||
    value === "untitled" ||
    value === "lenses" ||
    value === "my lenses" ||
    value.startsWith("lens ")
  );
}

async function syncPresence() {
  const { watches, keepAwake } = await getSettings();
  const count = Object.keys(watches).length;

  if (count > 0) {
    await chrome.action.setIcon({ path: watchingIconPaths() });
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: "#E64632" });
    await chrome.action.setTitle({
      title: `Watching ${count} Lens${count === 1 ? "" : "es"} — keep Chrome open; do not sleep the laptop`,
    });
    if (keepAwake) {
      try {
        // "display" also keeps the system awake and tries to prevent screen sleep.
        chrome.power.requestKeepAwake("display");
      } catch (error) {
        try {
          chrome.power.requestKeepAwake("system");
        } catch (inner) {
          console.warn("[My Lenses Notify] keep-awake failed", error, inner);
        }
      }
    } else {
      try {
        chrome.power.releaseKeepAwake();
      } catch {
        /* ignore */
      }
    }
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: CHECK_MINUTES,
      delayInMinutes: CHECK_MINUTES,
    });
  } else {
    await chrome.action.setIcon({ path: idleIconPaths() });
    await chrome.action.setBadgeText({ text: "" });
    await chrome.action.setTitle({
      title: "My Lenses Notify — not watching anything",
    });
    try {
      chrome.power.releaseKeepAwake();
    } catch {
      /* ignore */
    }
    await chrome.alarms.clear(ALARM_NAME);
  }
}

async function flashDoneIcon() {
  await chrome.action.setIcon({ path: doneIconPaths() });
  setTimeout(() => {
    syncPresence().catch(() => {});
  }, 4000);
}

async function logEmailAttempt(entry) {
  const prev = await chrome.storage.local.get({ emailLog: [] });
  const emailLog = [
    { at: new Date().toISOString(), ...entry },
    ...(prev.emailLog || []),
  ].slice(0, 10);
  await chrome.storage.local.set({ emailLog });
}

async function waitForTabComplete(tabId, timeoutMs = 25000) {
  try {
    const existing = await chrome.tabs.get(tabId);
    if (existing.status === "complete") {
      return;
    }
  } catch {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for tab load"));
    }, timeoutMs);

    function listener(updatedTabId, info) {
      if (updatedTabId === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function hardenWatcherTab(tabId) {
  try {
    await chrome.tabs.update(tabId, {
      autoDiscardable: false,
      pinned: true,
      active: false,
    });
  } catch {
    /* ignore */
  }
}

/**
 * Briefly activate a background tab so the My Lenses SPA can paint/hydrate,
 * then restore the user's previous tab. Only used when a cold scrape fails.
 */
async function withBriefTabFocus(tabId, fn) {
  let previousTabId = null;
  try {
    const [active] = await chrome.tabs.query({
      active: true,
      lastFocusedWindow: true,
    });
    previousTabId = active?.id ?? null;
    if (previousTabId !== tabId) {
      await chrome.tabs.update(tabId, { active: true });
      await new Promise((r) => setTimeout(r, 1200));
    }
    return await fn();
  } finally {
    if (previousTabId != null && previousTabId !== tabId) {
      try {
        await chrome.tabs.update(previousTabId, { active: true });
      } catch {
        /* ignore */
      }
    }
    await hardenWatcherTab(tabId);
  }
}

async function createOwnedWatcherTab(url) {
  const tab = await chrome.tabs.create({
    url,
    active: false,
    pinned: true,
  });
  await hardenWatcherTab(tab.id);
  await waitForTabComplete(tab.id).catch(() => {});
  // SPA needs a beat after "complete".
  await new Promise((r) => setTimeout(r, 1500));
  return tab.id;
}

async function ensureOwnedWatcherTab(watch) {
  if (watch.tabId != null && watch.ownedTab) {
    try {
      const tab = await chrome.tabs.get(watch.tabId);
      if (tab.url && tab.url.includes(`/lenses/${watch.lensId}`)) {
        await hardenWatcherTab(tab.id);
        return { tabId: tab.id, created: false };
      }
    } catch {
      /* recreate below */
    }
  }

  const tabId = await createOwnedWatcherTab(watch.url);
  return { tabId, created: true };
}

async function getEmailRelayTab() {
  const tabs = await chrome.tabs.query({
    url: "https://my-lenses.snapchat.com/*",
  });
  if (tabs.length) {
    return { tab: tabs[0], created: false };
  }
  const tab = await chrome.tabs.create({
    url: "https://my-lenses.snapchat.com/",
    active: false,
    pinned: true,
  });
  await waitForTabComplete(tab.id);
  await new Promise((r) => setTimeout(r, 800));
  return { tab, created: true };
}

async function sendEmail(email, subject, message) {
  const { tab, created } = await getEmailRelayTab();
  let response;
  try {
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "SEND_FORM_EMAIL",
      email,
      subject,
      message,
    });
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["shared.js", "content.js"],
    });
    await new Promise((r) => setTimeout(r, 400));
    response = await chrome.tabs.sendMessage(tab.id, {
      type: "SEND_FORM_EMAIL",
      email,
      subject,
      message,
    });
  } finally {
    if (created) {
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* ignore */
      }
    }
  }

  await logEmailAttempt({
    email,
    subject,
    ok: Boolean(response?.ok),
    error: response?.error || null,
    httpStatus: response?.httpStatus ?? response?.payload?.httpStatus ?? null,
    body: response?.body || response?.payload?.body || null,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "FormSubmit request failed");
  }

  if (
    response.needsActivation ||
    /activation|activate form/i.test(
      String(response.message || response?.json?.message || ""),
    )
  ) {
    return {
      ...response,
      needsActivation: true,
      message:
        response.message ||
        response?.json?.message ||
        "FormSubmit activation email sent",
    };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.emailActivated]: true });
  return response;
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) {
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) {
    return true;
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Play a soft click when a Lens status changes",
  });
  return true;
}

async function playSoftClick() {
  try {
    const ready = await ensureOffscreenDocument();
    if (!ready) {
      return { ok: false, error: "offscreen unavailable" };
    }
    const response = await chrome.runtime.sendMessage({
      type: "OFFSCREEN_PLAY_SOUND",
      src: "sounds/soft-click.wav",
      volume: 0.35,
    });
    return response || { ok: true };
  } catch (error) {
    console.warn("[My Lenses Notify] sound failed", error);
    return { ok: false, error: error.message || String(error) };
  }
}

async function showAlertWindow(title, message) {
  const url =
    chrome.runtime.getURL("alert.html") +
    `?title=${encodeURIComponent(title || "My Lenses Notify")}` +
    `&message=${encodeURIComponent(message || "")}`;

  const width = 420;
  const height = 240;
  let left = 120;
  let top = 120;
  try {
    const current = await chrome.windows.getLastFocused();
    if (current?.width && current?.height) {
      left = Math.max(
        40,
        Math.round((current.left || 0) + (current.width - width) / 2),
      );
      top = Math.max(
        40,
        Math.round((current.top || 0) + (current.height - height) / 3),
      );
    }
  } catch {
    /* use defaults */
  }

  // Small focused popup — works even when macOS blocks Chrome banners.
  // Explicit left/top/state avoids fullscreen / Stage Manager blow-ups on macOS.
  const win = await chrome.windows.create({
    url,
    type: "popup",
    focused: true,
    state: "normal",
    width,
    height,
    left,
    top,
  });

  if (win?.id != null) {
    try {
      await chrome.windows.update(win.id, {
        state: "normal",
        width,
        height,
        left,
        top,
        focused: true,
      });
    } catch {
      /* ignore */
    }
  }
  return { ok: true, windowId: win?.id ?? null };
}

async function notifyDesktop(title, message, options = {}) {
  const { playSound = true, forceWindow = true } = options;
  const result = {
    ok: false,
    permission: null,
    notificationId: null,
    apiError: null,
    fallbackUsed: false,
    windowId: null,
  };

  try {
    if (chrome.notifications?.getPermissionLevel) {
      result.permission = await chrome.notifications.getPermissionLevel();
    }
  } catch {
    /* ignore */
  }

  const iconUrl = chrome.runtime.getURL("icons/icon-128.png");

  try {
    if (result.permission === "denied") {
      result.apiError = "Chrome notification permission is denied";
    } else {
      const notificationId = await chrome.notifications.create("", {
        type: "basic",
        iconUrl,
        title: String(title || "My Lenses Notify"),
        message: String(message || ""),
        priority: 2,
        requireInteraction: false,
        silent: true,
      });
      result.notificationId = notificationId || null;
      result.ok = Boolean(notificationId);
      if (chrome.runtime.lastError) {
        result.apiError = chrome.runtime.lastError.message;
        result.ok = false;
      }
    }
  } catch (error) {
    result.apiError = error.message || String(error);
  }

  // Reliable visible alert: focused popup window (independent of macOS banners).
  if (forceWindow || !result.ok) {
    try {
      const win = await showAlertWindow(title, message);
      result.windowId = win.windowId;
      result.fallbackUsed = true;
      result.ok = true;
    } catch (error) {
      result.apiError =
        result.apiError || error.message || String(error);
    }
  }

  await chrome.storage.local.set({
    lastDesktopAlert: {
      at: new Date().toISOString(),
      title,
      message,
      ...result,
    },
  });

  if (playSound) {
    await playSoftClick();
  }

  return result;
}

/**
 * Scrape status directly in the tab. Works even if the content-script
 * message channel is dead (frozen/discarded background tabs).
 */
async function scrapeStatusInTab(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [Shared.KNOWN_STATUSES],
    func: (knownStatuses) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();

      // Background tabs often report empty getClientRects() even for live DOM.
      // Prefer painted nodes when available; otherwise fall back to CSS visibility.
      const isCssVisible = (element) => {
        if (element.hidden || element.getAttribute("aria-hidden") === "true") {
          return false;
        }
        const style = getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0"
        );
      };

      const hasLayoutBox = (element) => element.getClientRects().length > 0;

      const statusByLowercase = new Map(
        knownStatuses.map((status) => [status.toLowerCase(), status]),
      );

      const candidates = [];
      for (const element of document.querySelectorAll("body *")) {
        if (element.children.length > 0 || !isCssVisible(element)) {
          continue;
        }
        const text = normalize(element.textContent || "");
        const status = statusByLowercase.get(text.toLowerCase());
        if (!status) {
          continue;
        }
        const rect = element.getBoundingClientRect();
        candidates.push({
          status,
          painted: hasLayoutBox(element),
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
      const status = (painted.length ? painted : candidates)[0]?.status || null;

      let lensName = null;
      const bodyText = document.body?.innerText || "";
      const nameMatch = bodyText.match(/Lens Name\s*\n\s*([^\n]+)/i);
      if (nameMatch?.[1]) {
        lensName = normalize(nameMatch[1]);
      }
      if (!lensName) {
        const heading = [...document.querySelectorAll("h1, h2, h3")]
          .filter(isCssVisible)
          .map((el) => normalize(el.textContent || ""))
          .find(
            (text) =>
              text &&
              !["lenses", "my lenses", "untitled"].includes(text.toLowerCase()),
          );
        lensName = heading || null;
      }

      return {
        status,
        lensName,
        hasLensIdText: /Lens ID:/i.test(bodyText),
        title: document.title || "",
        href: location.href,
        candidateCount: candidates.length,
        usedBackgroundFallback: Boolean(status) && painted.length === 0,
      };
    },
  });

  return result || null;
}

async function startWatch(payload) {
  const settings = await getSettings();
  if (!settings.email) {
    return {
      ok: false,
      error: "Add your email in the extension popup first.",
    };
  }

  const lensId = payload.lensId || Shared.lensIdFromUrl(payload.url);
  if (!lensId) {
    return { ok: false, error: "Could not read Lens ID from this page." };
  }

  const watches = { ...settings.watches };
  const watch = {
    lensId,
    lensName: isWeakLensName(payload.lensName)
      ? `Lens ${lensId.slice(0, 8)}`
      : payload.lensName,
    url: payload.url,
    initialStatus: payload.status,
    startedAt: new Date().toISOString(),
    lastStatus: payload.status,
    lastSeenAt: new Date().toISOString(),
    tabId: null,
    ownedTab: true,
  };

  const ensured = await ensureOwnedWatcherTab(watch);
  watch.tabId = ensured.tabId;
  watches[lensId] = watch;
  await setWatches(watches);

  // Immediate first scrape so we know the watcher is alive.
  const first = await pollOneWatch(watch, { forceReload: false });
  await appendPollLog({ event: "start", lensId, ...first });

  await notifyDesktop(
    "Watching started",
    `${watch.lensName} is ${watch.initialStatus}. Keep Chrome running in the background.`,
    { playSound: false, forceWindow: false },
  );

  return { ok: true, watch, email: settings.email, firstPoll: first };
}

async function stopWatch(lensId, options = {}) {
  const { closeOwnedTab = false } = options;
  const settings = await getSettings();
  const watches = { ...settings.watches };
  const watch = watches[lensId];
  if (!watch) {
    return { ok: false };
  }
  delete watches[lensId];
  await setWatches(watches);

  if (closeOwnedTab && watch.ownedTab && watch.tabId != null) {
    try {
      await chrome.tabs.remove(watch.tabId);
    } catch {
      /* ignore */
    }
  }
  return { ok: true, watch };
}

async function completeWatch(lensId, currentStatus) {
  if (completingLocks.has(lensId)) {
    return { ok: false, skipped: "already-completing" };
  }
  completingLocks.add(lensId);

  try {
    const settings = await getSettings();
    const watch = settings.watches[lensId];
    if (!watch) {
      return { ok: false, skipped: "missing-watch" };
    }
    if (
      currentStatus &&
      watch.initialStatus &&
      currentStatus.toLowerCase() === watch.initialStatus.toLowerCase()
    ) {
      return { ok: false, skipped: "same-status" };
    }

    // Claim completion first so a parallel poll/content report cannot double-send.
    // This does NOT reduce the chance of the first email — it only blocks duplicates.
    await stopWatch(lensId, { closeOwnedTab: true });
    await flashDoneIcon();

    const subject = `Lens ready: ${watch.lensName}`;
    const statusLine = `${watch.initialStatus} → ${currentStatus || "updated"}`;
    const body = [
      watch.lensName,
      statusLine,
      "",
      watch.url,
      "",
      "Sent by My Lenses Notify.",
    ].join("\n");

    await notifyDesktop(
      subject,
      `${statusLine}\nOpen My Lenses if you need to continue publishing.`,
      { playSound: true, forceWindow: true },
    );

    // Retry email a few times — failproof delivery matters more than one extra attempt.
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await sendEmail(settings.email, subject, body);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        console.warn(
          `[My Lenses Notify] email attempt ${attempt}/3 failed`,
          error,
        );
        if (attempt < 3) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
        }
      }
    }

    if (lastError) {
      console.error("[My Lenses Notify] email failed after retries", lastError);
      await notifyDesktop(
        "Email failed",
        `“${watch.lensName}” changed to ${currentStatus || "a new status"}, but the email could not be sent: ${lastError.message}`,
        { playSound: true, forceWindow: true },
      );
      await logEmailAttempt({
        email: settings.email,
        subject,
        ok: false,
        error: lastError.message || String(lastError),
        retriesExhausted: true,
      });
      return { ok: false, error: lastError.message || String(lastError) };
    }
    return { ok: true };
  } finally {
    completingLocks.delete(lensId);
  }
}

async function applyStatus(lensId, status, lensName) {
  const settings = await getSettings();
  const watch = settings.watches[lensId];
  if (!watch || !status) {
    return { ok: true, watching: Boolean(watch), completed: false };
  }

  const nextName =
    lensName && !isWeakLensName(lensName) ? lensName : watch.lensName;

  const watches = { ...settings.watches };
  watches[lensId] = {
    ...watch,
    lastStatus: status,
    lastSeenAt: new Date().toISOString(),
    lensName: nextName,
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.watches]: watches });

  const statusChanged =
    watch.initialStatus &&
    status.toLowerCase() !== watch.initialStatus.toLowerCase();

  if (statusChanged || !Shared.isPending(status)) {
    await completeWatch(lensId, status);
    return { ok: true, watching: false, completed: true, status };
  }

  return { ok: true, watching: true, completed: false, status };
}

async function pollOneWatch(watch, options = {}) {
  const { forceReload = true } = options;
  const result = {
    lensId: watch.lensId,
    ok: false,
    status: null,
    error: null,
    reloaded: false,
    tabId: watch.tabId,
  };

  try {
    const ensured = await ensureOwnedWatcherTab(watch);
    result.tabId = ensured.tabId;

    // Persist owned tab id.
    const settings = await getSettings();
    if (settings.watches[watch.lensId]) {
      settings.watches[watch.lensId] = {
        ...settings.watches[watch.lensId],
        tabId: ensured.tabId,
        ownedTab: true,
      };
      await chrome.storage.local.set({
        [STORAGE_KEYS.watches]: settings.watches,
      });
    }

    if (forceReload) {
      await chrome.tabs.reload(ensured.tabId);
      result.reloaded = true;
      await waitForTabComplete(ensured.tabId).catch(() => {});
      // Background tabs need more time for the My Lenses SPA to hydrate.
      await new Promise((r) => setTimeout(r, 3500));
    }

    let scraped = null;
    try {
      scraped = await scrapeStatusInTab(ensured.tabId);
    } catch (error) {
      // Inject content scripts and retry scrape once.
      await chrome.scripting.executeScript({
        target: { tabId: ensured.tabId },
        files: ["shared.js", "content.js"],
      });
      await new Promise((r) => setTimeout(r, 500));
      scraped = await scrapeStatusInTab(ensured.tabId);
      result.injected = true;
    }

    if (!scraped?.status) {
      // One more reload + brief focus — SPA often will not paint in a
      // never-focused background tab (Window-in-Window / heavy throttling).
      await chrome.tabs.reload(ensured.tabId);
      result.reloaded = true;
      await waitForTabComplete(ensured.tabId).catch(() => {});
      scraped = await withBriefTabFocus(ensured.tabId, async () => {
        await new Promise((r) => setTimeout(r, 2000));
        return scrapeStatusInTab(ensured.tabId);
      });
      result.focusedNudge = true;
    }

    if (!scraped?.status) {
      result.error = "Status not found on page yet";
      result.scrape = scraped;
      return result;
    }

    result.ok = true;
    result.status = scraped.status;
    result.lensName = scraped.lensName;
    const applied = await applyStatus(
      watch.lensId,
      scraped.status,
      scraped.lensName,
    );
    result.completed = Boolean(applied.completed);
    return result;
  } catch (error) {
    result.error = error.message || String(error);
    return result;
  }
}

async function pollWatches(options = {}) {
  const { forceReload = true } = options;
  const { watches } = await getSettings();
  const entries = Object.values(watches);
  if (!entries.length) {
    await syncPresence();
    return { ok: true, results: [], count: 0 };
  }

  const results = [];
  for (const watch of entries) {
    const one = await pollOneWatch(watch, { forceReload });
    results.push(one);
    await appendPollLog({ event: "poll", ...one });
  }

  await syncPresence();
  return { ok: true, results, count: results.length };
}

chrome.runtime.onInstalled.addListener(() => {
  syncPresence().catch(() => {});
  // Re-inject into already-open My Lenses tabs after Reload / update so
  // orphaned "Extension context invalidated" scripts get replaced.
  chrome.tabs
    .query({ url: "https://my-lenses.snapchat.com/*" })
    .then(async (tabs) => {
      for (const tab of tabs) {
        if (tab.id == null) {
          continue;
        }
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["shared.js", "content.js"],
          });
        } catch {
          /* tab may be restricted / still loading */
        }
      }
    })
    .catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  syncPresence().catch(() => {});
  // After laptop wake, force a full reload scrape.
  pollWatches({ forceReload: true }).catch(() => {});
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    pollWatches({ forceReload: true }).catch((error) => {
      console.warn("[My Lenses Notify] alarm poll failed", error);
    });
  }
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") {
    return;
  }
  if (changes[STORAGE_KEYS.keepAwake] || changes[STORAGE_KEYS.watches]) {
    syncPresence().catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { watches } = await getSettings();
  let changed = false;
  const next = { ...watches };
  for (const [lensId, watch] of Object.entries(watches)) {
    if (watch.tabId === tabId) {
      next[lensId] = { ...watch, tabId: null };
      changed = true;
    }
  }
  if (!changed) {
    return;
  }
  await chrome.storage.local.set({ [STORAGE_KEYS.watches]: next });
  // Recreate owned watchers immediately.
  pollWatches({ forceReload: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (
    message?.type === "OFFSCREEN_PLAY_SOUND" ||
    message?.type === "OFFSCREEN_SHOW_NOTIFICATION"
  ) {
    // Handled by offscreen.html only.
    return false;
  }
  (async () => {
    switch (message?.type) {
      case "GET_STATE": {
        const settings = await getSettings();
        const extra = await chrome.storage.local.get({
          emailLog: [],
          pollLog: [],
          lastDesktopAlert: null,
        });
        return {
          ok: true,
          ...settings,
          emailLog: extra.emailLog || settings.emailLog || [],
          pollLog: extra.pollLog || settings.pollLog || [],
          lastDesktopAlert: extra.lastDesktopAlert || null,
        };
      }
      case "SAVE_EMAIL": {
        const email = String(message.email || "").trim();
        await chrome.storage.local.set({ [STORAGE_KEYS.email]: email });
        return { ok: true, email };
      }
      case "SET_KEEP_AWAKE": {
        await chrome.storage.local.set({
          [STORAGE_KEYS.keepAwake]: Boolean(message.enabled),
        });
        await syncPresence();
        return { ok: true };
      }
      case "START_WATCH":
        return startWatch(message);
      case "STOP_WATCH":
        return stopWatch(message.lensId, {
          closeOwnedTab: Boolean(message.closeTab),
        });
      case "STATUS_REPORT": {
        // Content-script reports are informational. Never adopt the sender tab
        // as the owned watcher (that caused closing the user's work tab).
        return applyStatus(
          message.lensId,
          message.status,
          message.lensName,
        );
      }
      case "IS_WATCHING": {
        const settings = await getSettings();
        return {
          ok: true,
          watching: Boolean(settings.watches[message.lensId]),
          watch: settings.watches[message.lensId] || null,
          email: settings.email,
        };
      }
      case "SEND_TEST_EMAIL": {
        const settings = await getSettings();
        if (!settings.email) {
          return { ok: false, error: "Save an email first." };
        }
        try {
          const result = await sendEmail(
            settings.email,
            "My Lenses Notify — test email",
            "If you received this, email delivery works.\n\nIf FormSubmit asked you to Activate Form, open that email first, then send another test.",
          );
          return {
            ok: true,
            needsActivation: Boolean(result?.needsActivation),
            message: result?.message || result?.json?.message || null,
            log: result,
          };
        } catch (error) {
          return { ok: false, error: error.message || String(error) };
        }
      }
      case "POLL_NOW":
        return pollWatches({ forceReload: true });
      default:
        return { ok: false, error: "Unknown message" };
    }
  })()
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

syncPresence().catch(() => {});
