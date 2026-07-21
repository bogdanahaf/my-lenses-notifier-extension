"use strict";

importScripts("common.js");

const Shared = globalThis.MyLensesNotify;
const K = Shared.STORAGE_KEYS;
const WATCHER_PARAM = "__mln_watcher";
const OWNED_TABS_SESSION_KEY = "myLensesOwnedWatcherTabsV2";
const startLocks = new Map();
const tabLocks = new Map();
const completionLocks = new Set();
let pollPromise = null;
let watchMutationQueue = Promise.resolve();
let audioDocumentPromise = null;
let initializationPromise = null;
let ownedTabMutationQueue = Promise.resolve();

function iconPaths(kind) {
  const prefix =
    kind === "watching"
      ? "icons/icon-watching"
      : kind === "done"
        ? "icons/icon-done"
        : "icons/icon";
  return {
    16: `${prefix}-16.png`,
    32: `${prefix}-32.png`,
    48: `${prefix}-48.png`,
    128: `${prefix}-128.png`,
  };
}

async function settings() {
  const data = await chrome.storage.local.get({
    [K.email]: "",
    [K.keepAwake]: true,
    [K.watches]: {},
    [K.emailActivated]: false,
    [K.emailLog]: [],
    [K.pollLog]: [],
    [K.lastDesktopAlert]: null,
    [K.lastHeartbeatAt]: null,
    [K.lastHeartbeatReason]: null,
    [K.lastPollAt]: 0,
  });
  return {
    email: String(data[K.email] || "").trim(),
    keepAwake: data[K.keepAwake] !== false,
    watches: data[K.watches] || {},
    emailActivated: Boolean(data[K.emailActivated]),
    emailLog: data[K.emailLog] || [],
    pollLog: data[K.pollLog] || [],
    lastDesktopAlert: data[K.lastDesktopAlert] || null,
    lastHeartbeatAt: data[K.lastHeartbeatAt] || null,
    lastHeartbeatReason: data[K.lastHeartbeatReason] || null,
    lastPollAt: Number(data[K.lastPollAt] || 0),
  };
}

async function mutateWatches(mutator) {
  const task = watchMutationQueue
    .catch(() => {})
    .then(async () => {
      const current = await settings();
      const watches = { ...current.watches };
      const outcome = (await mutator(watches, current)) || {};
      if (outcome.changed) {
        await chrome.storage.local.set({ [K.watches]: watches });
      }
      return outcome.value;
    });
  watchMutationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function patchWatch(lensId, patch) {
  return mutateWatches((watches) => {
    const watch = watches[lensId];
    if (!watch) {
      return { changed: false, value: null };
    }
    watches[lensId] = { ...watch, ...patch };
    return { changed: true, value: watches[lensId] };
  });
}

async function appendLog(key, entry, limit) {
  const data = await chrome.storage.local.get({ [key]: [] });
  const next = [
    { at: new Date().toISOString(), ...entry },
    ...(data[key] || []),
  ].slice(0, limit);
  await chrome.storage.local.set({ [key]: next });
}

function appendPollLog(entry) {
  return appendLog(K.pollLog, entry, 30);
}

function appendEmailLog(entry) {
  return appendLog(K.emailLog, entry, 12);
}

async function withKeyLock(map, key, task) {
  const previous = map.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const chain = previous.catch(() => {}).then(() => gate);
  map.set(key, chain);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (map.get(key) === chain) {
      map.delete(key);
    }
  }
}

async function ensureTickAlarm() {
  const existing = await chrome.alarms.get(Shared.TICK_ALARM);
  if (existing) {
    return;
  }
  try {
    await chrome.alarms.create(Shared.TICK_ALARM, {
      delayInMinutes: Shared.TICK_MINUTES,
      periodInMinutes: Shared.TICK_MINUTES,
    });
  } catch {
    await chrome.alarms.create(Shared.TICK_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  }
}

async function syncPresence() {
  const current = await settings();
  const count = Object.keys(current.watches).length;

  if (count > 0) {
    await chrome.action.setIcon({ path: iconPaths("watching") });
    await chrome.action.setBadgeText({ text: String(count) });
    await chrome.action.setBadgeBackgroundColor({ color: "#e64632" });
    await chrome.action.setTitle({
      title: `Watching ${count} Lens${count === 1 ? "" : "es"}`,
    });
    await ensureTickAlarm();
    if (current.keepAwake) {
      try {
        chrome.power.requestKeepAwake("display");
      } catch {
        try {
          chrome.power.requestKeepAwake("system");
        } catch {
          /* unsupported */
        }
      }
    } else {
      try {
        chrome.power.releaseKeepAwake();
      } catch {
        /* unsupported */
      }
    }
    return;
  }

  await chrome.action.setIcon({ path: iconPaths("idle") });
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle({ title: "My Lenses Notify" });
  await chrome.alarms.clear(Shared.TICK_ALARM);
  try {
    chrome.power.releaseKeepAwake();
  } catch {
    /* unsupported */
  }
}

async function flashDoneIcon() {
  await chrome.action.setIcon({ path: iconPaths("done") });
  setTimeout(() => {
    syncPresence().catch(() => {});
  }, 4000);
}

async function tabOrNull(tabId) {
  if (tabId == null) {
    return null;
  }
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

function tabMatchesWatch(tab, watch) {
  if (!tab || !watch?.watcherToken) {
    return false;
  }
  for (const candidate of [tab.pendingUrl, tab.url]) {
    if (!candidate) {
      continue;
    }
    try {
      const url = new URL(candidate);
      if (
        url.origin === "https://my-lenses.snapchat.com" &&
        url.pathname.includes(`/lenses/${watch.lensId}`) &&
        url.searchParams.get(WATCHER_PARAM) === watch.watcherToken
      ) {
        return true;
      }
    } catch {
      /* try the next candidate URL */
    }
  }
  return false;
}

function watcherUrl(watch) {
  const url = new URL(watch.url);
  url.searchParams.set(WATCHER_PARAM, watch.watcherToken);
  return url.href;
}

async function mutateOwnedTabSessions(mutator) {
  const task = ownedTabMutationQueue
    .catch(() => {})
    .then(async () => {
      const data = await chrome.storage.session.get({
        [OWNED_TABS_SESSION_KEY]: {},
      });
      const owned = { ...(data[OWNED_TABS_SESSION_KEY] || {}) };
      const result = mutator(owned);
      await chrome.storage.session.set({ [OWNED_TABS_SESSION_KEY]: owned });
      return result;
    });
  ownedTabMutationQueue = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

function rememberOwnedTab(tabId, watcherToken) {
  return mutateOwnedTabSessions((owned) => {
    owned[String(tabId)] = watcherToken;
  });
}

function forgetOwnedTab(tabId) {
  return mutateOwnedTabSessions((owned) => {
    delete owned[String(tabId)];
  });
}

async function tabIsOwned(tab, watch) {
  if (tabMatchesWatch(tab, watch)) {
    return true;
  }
  if (tab?.id == null || !watch?.watcherToken) {
    return false;
  }
  const data = await chrome.storage.session.get({
    [OWNED_TABS_SESSION_KEY]: {},
  });
  return data[OWNED_TABS_SESSION_KEY]?.[String(tab.id)] === watch.watcherToken;
}

async function findOwnedWatcherTabs(watch) {
  const tabs = await chrome.tabs.query({});
  const owned = [];
  for (const tab of tabs) {
    if (tab?.id != null && (await tabIsOwned(tab, watch))) {
      owned.push(tab);
    }
  }
  return owned;
}

async function closeDuplicateOwnedTabs(watch, keepTabId) {
  for (const tab of await findOwnedWatcherTabs(watch)) {
    if (tab.id === keepTabId) {
      continue;
    }
    await chrome.tabs.remove(tab.id);
    await forgetOwnedTab(tab.id);
  }
}

async function closeOwnedWatcherTab(watch) {
  const owned = await findOwnedWatcherTabs(watch);
  if (!owned.length) {
    return false;
  }
  for (const tab of owned) {
    await chrome.tabs.remove(tab.id);
    await forgetOwnedTab(tab.id);
  }
  return true;
}

async function waitForTabComplete(tabId, timeoutMs = 25_000) {
  const tab = await tabOrNull(tabId);
  if (!tab || tab.status === "complete") {
    return;
  }

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Timed out waiting for watcher tab"));
    }, timeoutMs);

    function listener(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function ensureWatcherTab(lensId) {
  return withKeyLock(tabLocks, lensId, async () => {
    const current = await settings();
    const watch = current.watches[lensId];
    if (!watch) {
      throw new Error("Watch no longer exists");
    }

    const existing = await tabOrNull(watch.ownedTabId);
    if (await tabIsOwned(existing, watch)) {
      await chrome.tabs.update(existing.id, {
        pinned: true,
        autoDiscardable: false,
      });
      await closeDuplicateOwnedTabs(watch, existing.id);
      return { tabId: existing.id, created: false };
    }

    // Safely recover an extension-marked tab after a browser session restart.
    const marked = await findOwnedWatcherTabs(watch);
    if (marked[0]?.id != null) {
      await chrome.tabs.update(marked[0].id, {
        pinned: true,
        autoDiscardable: false,
      });
      await rememberOwnedTab(marked[0].id, watch.watcherToken);
      await patchWatch(lensId, { ownedTabId: marked[0].id });
      await closeDuplicateOwnedTabs(watch, marked[0].id);
      return { tabId: marked[0].id, created: false };
    }

    // Never adopt, reload, pin, or activate the user's normal My Lenses tab.
    const created = await chrome.tabs.create({
      url: watcherUrl(watch),
      active: false,
      pinned: true,
    });
    await chrome.tabs.update(created.id, {
      pinned: true,
      autoDiscardable: false,
    });
    await rememberOwnedTab(created.id, watch.watcherToken);
    await patchWatch(lensId, { ownedTabId: created.id });
    return { tabId: created.id, created: true };
  });
}

async function scrapeStatus(tabId) {
  const [{ result } = {}] = await chrome.scripting.executeScript({
    target: { tabId },
    args: [Shared.KNOWN_STATUSES],
    func: (knownStatuses) => {
      const normalize = (value) =>
        String(value || "")
          .replace(/\s+/g, " ")
          .trim();
      const statuses = new Map(
        knownStatuses.map((status) => [status.toLowerCase(), status]),
      );

      const isHidden = (element) => {
        for (
          let current = element;
          current && current !== document.documentElement;
          current = current.parentElement
        ) {
          if (
            current.hidden ||
            current.getAttribute("aria-hidden") === "true"
          ) {
            return true;
          }
          const style = getComputedStyle(current);
          if (style.display === "none" || style.visibility === "hidden") {
            return true;
          }
        }
        return false;
      };

      const candidates = [];
      for (const element of document.querySelectorAll("body *")) {
        const text = normalize(element.textContent);
        const status = statuses.get(text.toLowerCase());
        if (!status || isHidden(element)) {
          continue;
        }
        candidates.push({
          status,
          childCount: element.childElementCount,
        });
      }
      candidates.sort((a, b) => a.childCount - b.childCount);

      let status = candidates[0]?.status || null;
      const bodyText = document.body?.innerText || "";
      if (!status) {
        for (const line of bodyText.split(/\n+/)) {
          const candidate = statuses.get(normalize(line).toLowerCase());
          if (candidate) {
            status = candidate;
            break;
          }
        }
      }

      let lensName = null;
      const nameMatch = bodyText.match(/Lens Name\s*\n\s*([^\n]+)/i);
      if (nameMatch?.[1]) {
        lensName = normalize(nameMatch[1]);
      }
      if (!lensName) {
        lensName =
          [...document.querySelectorAll("h1, h2, h3")]
            .map((element) => normalize(element.textContent))
            .find(
              (value) =>
                value &&
                !["lenses", "my lenses", "untitled"].includes(
                  value.toLowerCase(),
                ),
            ) || null;
      }

      return {
        status,
        lensName,
        hasLensId: /Lens ID:/i.test(bodyText),
        readyState: document.readyState,
        href: location.href,
      };
    },
  });
  return result || null;
}

async function scrapeUntilReady(tabId, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let latest = null;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await scrapeStatus(tabId);
    if (latest?.status) {
      return latest;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return latest;
}

function goodLensName(name) {
  const value = Shared.normalize(name);
  return Boolean(
    value && !["untitled", "lenses", "my lenses"].includes(value.toLowerCase()),
  );
}

async function pollWatch(watch, reason, reload = true, knownOwnedTabId = null) {
  const startedAt = Date.now();
  const result = {
    lensId: watch.lensId,
    reason,
    ok: false,
    status: null,
    error: null,
    parseOk: false,
    parsedLensId: null,
    hasLensIdText: false,
    pageReadyState: null,
    reloaded: false,
    tabId: null,
  };

  try {
    const knownTab = await tabOrNull(knownOwnedTabId);
    const owned =
      knownTab && (await tabIsOwned(knownTab, watch))
        ? { tabId: knownTab.id, created: false }
        : await ensureWatcherTab(watch.lensId);
    result.tabId = owned.tabId;
    if (reload) {
      await chrome.tabs.reload(owned.tabId);
      result.reloaded = true;
    }
    await waitForTabComplete(owned.tabId).catch(() => {});
    const scraped = await scrapeUntilReady(owned.tabId);
    result.parsedLensId = Shared.lensIdFromUrl(scraped?.href);
    result.hasLensIdText = Boolean(scraped?.hasLensId);
    result.pageReadyState = scraped?.readyState || null;
    if (!scraped?.status) {
      result.error = "Status not found after page reload";
      result.scrape = scraped;
      return result;
    }
    if (
      !scraped.hasLensId ||
      Shared.lensIdFromUrl(scraped.href) !== watch.lensId
    ) {
      result.error = "Watcher tab is not on the expected Lens page";
      result.scrape = scraped;
      return result;
    }

    result.parseOk = true;
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
    result.error = error?.message || String(error);
    return result;
  } finally {
    result.durationMs = Date.now() - startedAt;
  }
}

async function maybePoll(reason) {
  const current = await settings();
  if (!Object.keys(current.watches).length) {
    return { ok: true, skipped: "no-watches" };
  }
  if (
    current.lastPollAt &&
    Date.now() - current.lastPollAt < Shared.POLL_DUE_AFTER_MS
  ) {
    return { ok: true, skipped: "not-due" };
  }
  return pollWatches(reason);
}

async function pollWatches(reason, force = false) {
  if (pollPromise) {
    return pollPromise;
  }

  pollPromise = (async () => {
    const current = await settings();
    const entries = Object.values(current.watches);
    if (!entries.length) {
      await syncPresence();
      return { ok: true, count: 0, results: [] };
    }
    if (
      !force &&
      current.lastPollAt &&
      Date.now() - current.lastPollAt < Shared.POLL_DUE_AFTER_MS
    ) {
      return { ok: true, skipped: "not-due", count: 0, results: [] };
    }

    const now = Date.now();
    await chrome.storage.local.set({
      [K.lastPollAt]: now,
      [K.lastHeartbeatAt]: new Date(now).toISOString(),
      [K.lastHeartbeatReason]: reason,
    });

    const results = [];
    for (const watch of entries) {
      const result = await pollWatch(watch, reason, true);
      results.push(result);
      await appendPollLog(result);
    }
    return { ok: true, count: results.length, results };
  })();

  try {
    return await pollPromise;
  } finally {
    pollPromise = null;
  }
}

async function applyStatus(lensId, statusValue, lensName) {
  const status = Shared.canonicalStatus(statusValue);
  if (!status) {
    return { ok: false, error: "Unknown status" };
  }

  const current = await settings();
  const watch = current.watches[lensId];
  if (!watch) {
    return { ok: true, watching: false };
  }

  const name = goodLensName(lensName)
    ? Shared.normalize(lensName)
    : watch.lensName;
  const changed =
    status.toLowerCase() !== String(watch.initialStatus || "").toLowerCase();

  if (watch.phase && watch.phase !== "watching") {
    const deliveryRetryDue =
      watch.phase === "delivery-failed" &&
      Date.now() >= Number(watch.retryDeliveryAt || 0);
    const staleCompletion =
      watch.phase === "completing" &&
      Date.now() - Number(watch.completionStartedAt || 0) >= 120_000;
    if (deliveryRetryDue || staleCompletion) {
      return completeWatch(lensId, watch.completionStatus || status);
    }
    return {
      ok: true,
      watching: true,
      completing: true,
      status,
      phase: watch.phase,
    };
  }

  if (changed || !Shared.isPending(status)) {
    return completeWatch(lensId, status);
  }

  await patchWatch(lensId, {
    lensName: name,
    lastStatus: status,
    lastSeenAt: new Date().toISOString(),
  });
  return { ok: true, watching: true, completed: false, status };
}

async function startWatch(message) {
  const lensId = message.lensId || Shared.lensIdFromUrl(message.url);
  if (!lensId) {
    return { ok: false, error: "Could not read Lens ID from this page." };
  }
  const initialStatus = Shared.canonicalStatus(message.status);
  if (!initialStatus || !Shared.isPending(initialStatus)) {
    return { ok: false, error: "This Lens is not Processing / In Review." };
  }

  return withKeyLock(startLocks, lensId, async () => {
    const current = await settings();
    if (!current.email) {
      return {
        ok: false,
        error: "Add your email in the extension popup first.",
      };
    }

    const created = await mutateWatches((watches) => {
      if (watches[lensId]) {
        return {
          changed: false,
          value: { watch: watches[lensId], created: false },
        };
      }
      const watch = {
        lensId,
        lensName: goodLensName(message.lensName)
          ? Shared.normalize(message.lensName)
          : `Lens ${lensId.slice(0, 8)}`,
        url: message.url,
        watcherToken: crypto.randomUUID(),
        initialStatus,
        lastStatus: initialStatus,
        startedAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString(),
        ownedTabId: null,
        phase: "watching",
      };
      watches[lensId] = watch;
      return { changed: true, value: { watch, created: true } };
    });
    let watch = created.watch;
    if (created.created) {
      await syncPresence();
    }

    const owned = await ensureWatcherTab(lensId);
    watch = (await settings()).watches[lensId];
    await broadcastUiRefresh();

    const first = await pollWatch(watch, "start", false, owned.tabId);
    await appendPollLog({ event: "start", ...first });
    await chrome.storage.local.set({ [K.lastPollAt]: Date.now() });

    await notifyDesktop(
      "Watching started",
      `${watch.lensName} is ${initialStatus}. Keep Chrome running in the background.`,
      { playSound: false, showWindow: false },
    );

    return {
      ok: true,
      watch: { ...watch, ownedTabId: owned.tabId },
      email: current.email,
      firstPoll: first,
    };
  });
}

async function stopWatch(lensId, options = {}) {
  const { closeOwnedTab = true } = options;
  const watch = await mutateWatches((watches) => {
    const existing = watches[lensId];
    if (!existing) {
      return { changed: false, value: null };
    }
    delete watches[lensId];
    return { changed: true, value: existing };
  });
  if (!watch) {
    return { ok: true, alreadyStopped: true };
  }

  await syncPresence();
  await broadcastUiRefresh();

  if (closeOwnedTab) {
    try {
      await closeOwnedWatcherTab(watch);
    } catch {
      /* already closed */
    }
  }
  return { ok: true, watch };
}

async function completeWatch(lensId, currentStatus) {
  if (completionLocks.has(lensId)) {
    return { ok: true, skipped: "already-completing" };
  }
  completionLocks.add(lensId);

  let watch = null;
  let delivered = false;
  try {
    const claim = await mutateWatches((watches) => {
      const existing = watches[lensId];
      if (!existing) {
        return {
          changed: false,
          value: { skipped: "missing-watch", watch: null },
        };
      }
      if (
        currentStatus.toLowerCase() ===
        String(existing.initialStatus || "").toLowerCase()
      ) {
        return {
          changed: false,
          value: { skipped: "same-status", watch: existing },
        };
      }

      const completionAge =
        Date.now() - Number(existing.completionStartedAt || 0);
      if (
        existing.phase === "completing" &&
        existing.completionStatus === currentStatus &&
        completionAge < 120_000
      ) {
        return {
          changed: false,
          value: { skipped: "already-completing", watch: existing },
        };
      }

      const claimed = {
        ...existing,
        phase: "completing",
        completionStatus: currentStatus,
        completionStartedAt: Date.now(),
      };
      watches[lensId] = claimed;
      return {
        changed: true,
        value: {
          skipped: null,
          watch: claimed,
          shouldAlert: !existing.completionAlertSent,
        },
      };
    });

    watch = claim.watch;
    if (claim.skipped) {
      return { ok: true, skipped: claim.skipped };
    }

    const subject = `Lens ready: ${watch.lensName}`;
    const transition = `${watch.initialStatus} → ${currentStatus}`;
    if (claim.shouldAlert) {
      await notifyDesktop(
        subject,
        `${transition}\nOpen My Lenses if you need to continue publishing.`,
        { playSound: true, showWindow: true },
      );
      await patchWatch(lensId, { completionAlertSent: true });
    }

    const emailBody = [
      watch.lensName,
      transition,
      "",
      watch.url,
      "",
      "Sent by My Lenses Notify.",
    ].join("\n");

    let emailError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const current = await settings();
        const response = await sendEmail(
          current.email,
          subject,
          emailBody,
          watch.ownedTabId,
        );
        if (response?.needsActivation) {
          const activationError = new Error(
            "FormSubmit activation is required before the status email can be delivered.",
          );
          activationError.activationRequired = true;
          throw activationError;
        }
        emailError = null;
        break;
      } catch (error) {
        emailError = error;
        if (error?.activationRequired) {
          break;
        }
        if (attempt < 3) {
          await new Promise((resolve) => setTimeout(resolve, attempt * 800));
        }
      }
    }

    if (emailError) {
      const firstDeliveryFailure = !watch.deliveryFailureAlertSent;
      await patchWatch(lensId, {
        phase: "delivery-failed",
        lastDeliveryError: emailError.message,
        retryDeliveryAt: Date.now() + 5 * 60_000,
        deliveryFailureAlertSent: true,
      });
      if (firstDeliveryFailure) {
        await notifyDesktop(
          "Email failed",
          `${watch.lensName} changed to ${currentStatus}, but email failed: ${emailError.message}`,
          { playSound: false, showWindow: false },
        );
      }
      return {
        ok: false,
        completed: false,
        deliveryFailed: true,
        error: emailError.message,
      };
    }

    await mutateWatches((watches) => {
      const existing = watches[lensId];
      if (!existing || existing.watcherToken !== watch.watcherToken) {
        return { changed: false, value: null };
      }
      delete watches[lensId];
      return { changed: true, value: existing };
    });
    delivered = true;
    await syncPresence();
    await flashDoneIcon();
    await broadcastUiRefresh();
    return { ok: true, completed: true, status: currentStatus };
  } finally {
    if (delivered && watch) {
      try {
        await closeOwnedWatcherTab(watch);
      } catch {
        /* already closed */
      }
    }
    completionLocks.delete(lensId);
  }
}

async function broadcastUiRefresh() {
  const tabs = await chrome.tabs.query({
    url: "https://my-lenses.snapchat.com/*",
  });
  for (const tab of tabs) {
    if (tab.id == null) {
      continue;
    }
    chrome.tabs.sendMessage(tab.id, { type: "REFRESH_UI" }).catch(() => {});
  }
}

async function injectIntoOpenTabs() {
  const tabs = await chrome.tabs.query({
    url: "https://my-lenses.snapchat.com/*",
  });
  for (const tab of tabs) {
    if (tab.id == null) {
      continue;
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["common.js", "page.js"],
      });
    } catch {
      /* tab may still be loading */
    }
  }
}

async function migrateLegacyWatches() {
  return mutateWatches((watches) => {
    let changed = false;
    let migratedCount = 0;
    for (const [lensId, watch] of Object.entries(watches)) {
      if (!watch.watcherToken) {
        // Legacy versions could accidentally adopt a user's tab. Do not trust
        // or mutate that tab ID. Continue the watch in a newly marked tab.
        const migrated = {
          ...watch,
          watcherToken: crypto.randomUUID(),
          ownedTabId: null,
          phase: "watching",
        };
        delete migrated.tabId;
        delete migrated.ownedTab;
        delete migrated.failStreak;
        watches[lensId] = migrated;
        changed = true;
        migratedCount += 1;
        continue;
      }
      if (!watch.phase) {
        watches[lensId] = { ...watch, phase: "watching" };
        changed = true;
      }
    }
    return { changed, value: migratedCount };
  });
}

async function initialize() {
  const migratedCount = await migrateLegacyWatches();
  await syncPresence();
  const current = await settings();
  for (const lensId of Object.keys(current.watches)) {
    await ensureWatcherTab(lensId);
  }
  await injectIntoOpenTabs();
  if (migratedCount > 0) {
    await notifyDesktop(
      "Watcher upgraded safely",
      "Monitoring continues in a new marked pinned tab. You can close any old watcher tabs left by the previous version.",
      { playSound: false, showWindow: false },
    );
  }
}

function ensureInitialized() {
  if (!initializationPromise) {
    initializationPromise = initialize().catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }
  return initializationPromise;
}

async function ensureAudioDocument() {
  if (audioDocumentPromise) {
    return audioDocumentPromise;
  }
  audioDocumentPromise = (async () => {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("offscreen.html")],
    });
    if (contexts.length) {
      return;
    }
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK"],
      justification: "Play a short sound when a watched Lens changes status",
    });
  })();
  try {
    return await audioDocumentPromise;
  } finally {
    audioDocumentPromise = null;
  }
}

async function playSoftClick() {
  try {
    await ensureAudioDocument();
    return await chrome.runtime.sendMessage({
      type: "OFFSCREEN_PLAY_SOUND",
      src: "sounds/soft-click.wav",
      volume: 0.35,
    });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

async function showAlertWindow(title, message) {
  const width = 420;
  const height = 240;
  const url =
    chrome.runtime.getURL("alert.html") +
    `?title=${encodeURIComponent(title)}` +
    `&message=${encodeURIComponent(message)}`;

  let left = 100;
  let top = 100;
  try {
    const current = await chrome.windows.getLastFocused();
    if (current?.width && current?.height) {
      left = Math.max(
        20,
        Math.round((current.left || 0) + (current.width - width) / 2),
      );
      top = Math.max(
        20,
        Math.round((current.top || 0) + (current.height - height) / 3),
      );
    }
  } catch {
    /* defaults */
  }

  const created = await chrome.windows.create({
    url,
    type: "popup",
    focused: true,
    state: "normal",
    width,
    height,
    left,
    top,
  });
  if (created?.id != null) {
    await chrome.windows
      .update(created.id, {
        state: "normal",
        width,
        height,
        left,
        top,
        focused: true,
      })
      .catch(() => {});
  }
  return created?.id ?? null;
}

async function notifyDesktop(title, message, options = {}) {
  const { playSound = true, showWindow = true } = options;
  let notificationId = null;
  let apiError = null;

  try {
    notificationId = await chrome.notifications.create("", {
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon-128.png"),
      title: String(title || "My Lenses Notify"),
      message: String(message || ""),
      priority: 2,
      silent: true,
    });
  } catch (error) {
    apiError = error?.message || String(error);
  }

  let windowId = null;
  if (showWindow) {
    try {
      windowId = await showAlertWindow(title, message);
    } catch (error) {
      apiError ||= error?.message || String(error);
    }
  }

  if (playSound) {
    await playSoftClick();
  }

  const result = {
    at: new Date().toISOString(),
    title,
    message,
    notificationId,
    windowId,
    apiError,
  };
  await chrome.storage.local.set({ [K.lastDesktopAlert]: result });
  return result;
}

async function emailRelayTab(preferredTabId) {
  const preferred = await tabOrNull(preferredTabId);
  if (preferred?.url?.startsWith("https://my-lenses.snapchat.com/")) {
    return { tab: preferred, created: false };
  }

  const existing = await chrome.tabs.query({
    url: "https://my-lenses.snapchat.com/*",
  });
  if (existing[0]) {
    return { tab: existing[0], created: false };
  }

  const created = await chrome.tabs.create({
    url: "https://my-lenses.snapchat.com/",
    active: false,
    pinned: false,
  });
  await waitForTabComplete(created.id).catch(() => {});
  return { tab: created, created: true };
}

async function sendMessageToPage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["common.js", "page.js"],
    });
    return chrome.tabs.sendMessage(tabId, message);
  }
}

async function sendEmail(email, subject, message, preferredTabId = null) {
  const relay = await emailRelayTab(preferredTabId);
  let response = null;
  try {
    response = await sendMessageToPage(relay.tab.id, {
      type: "SEND_FORM_EMAIL",
      email,
      subject,
      message,
    });
  } finally {
    if (relay.created) {
      chrome.tabs.remove(relay.tab.id).catch(() => {});
    }
  }

  await appendEmailLog({
    email,
    subject,
    ok: Boolean(response?.ok),
    error: response?.error || null,
    httpStatus: response?.httpStatus ?? null,
    body: response?.body || null,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "FormSubmit request failed");
  }
  if (response.needsActivation) {
    return response;
  }
  await chrome.storage.local.set({ [K.emailActivated]: true });
  return response;
}

chrome.runtime.onInstalled.addListener(() => {
  ensureInitialized().catch((error) => {
    console.warn("[My Lenses Notify] install initialization failed", error);
  });
});

chrome.runtime.onStartup.addListener(() => {
  migrateLegacyWatches()
    .then(syncPresence)
    .then(() => maybePoll("startup"))
    .catch((error) => {
      console.warn("[My Lenses Notify] startup failed", error);
    });
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== Shared.TICK_ALARM) {
    return;
  }
  chrome.storage.local
    .set({
      [K.lastHeartbeatAt]: new Date().toISOString(),
      [K.lastHeartbeatReason]: "alarm",
    })
    .then(() => maybePoll("alarm"))
    .catch((error) => {
      console.warn("[My Lenses Notify] scheduled poll failed", error);
    });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  forgetOwnedTab(tabId).catch(() => {});
  mutateWatches((watches) => {
    let changed = false;
    for (const [lensId, watch] of Object.entries(watches)) {
      if (watch.ownedTabId === tabId) {
        watches[lensId] = { ...watch, ownedTabId: null };
        changed = true;
      }
    }
    return { changed, value: changed };
  })
    .then((changed) => (changed ? ensureTickAlarm() : null))
    .catch(() => {});
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[K.watches]) {
    return;
  }
  const before = Object.keys(changes[K.watches].oldValue || {}).length;
  const after = Object.keys(changes[K.watches].newValue || {}).length;
  if (before !== after) {
    syncPresence().catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_PLAY_SOUND") {
    return false;
  }

  (async () => {
    await ensureInitialized();
    switch (message?.type) {
      case "GET_STATE":
        return { ok: true, ...(await settings()) };

      case "SAVE_EMAIL": {
        const email = String(message.email || "").trim();
        await chrome.storage.local.set({ [K.email]: email });
        return { ok: true, email };
      }

      case "SET_KEEP_AWAKE":
        await chrome.storage.local.set({
          [K.keepAwake]: Boolean(message.enabled),
        });
        await syncPresence();
        return { ok: true };

      case "START_WATCH":
        return startWatch(message);

      case "STOP_WATCH":
        return stopWatch(message.lensId, { closeOwnedTab: true });

      case "IS_WATCHING": {
        const current = await settings();
        return {
          ok: true,
          watching: Boolean(current.watches[message.lensId]),
          watch: current.watches[message.lensId] || null,
          email: current.email,
        };
      }

      case "STATUS_REPORT":
        return applyStatus(message.lensId, message.status, message.lensName);

      case "PAGE_TICK": {
        const current = await settings();
        const watch = current.watches[message.lensId];
        const isOwnedSender =
          Boolean(watch) && sender.tab?.id === watch.ownedTabId;
        if (isOwnedSender) {
          await chrome.storage.local.set({
            [K.lastHeartbeatAt]: new Date().toISOString(),
            [K.lastHeartbeatReason]: "watcher-tab",
          });
          return maybePoll("watcher-tab");
        }
        return { ok: true, skipped: "not-owned-watcher" };
      }

      case "POLL_NOW":
        return pollWatches("manual", true);

      case "SEND_TEST_EMAIL": {
        const current = await settings();
        if (!current.email) {
          return { ok: false, error: "Save an email first." };
        }
        try {
          const result = await sendEmail(
            current.email,
            "My Lenses Notify — test email",
            "If you received this, email delivery works.",
          );
          return {
            ok: true,
            needsActivation: Boolean(result?.needsActivation),
            message: result?.message || null,
          };
        } catch (error) {
          return { ok: false, error: error?.message || String(error) };
        }
      }

      default:
        return { ok: false, error: "Unknown message" };
    }
  })()
    .then(sendResponse)
    .catch((error) =>
      sendResponse({ ok: false, error: error?.message || String(error) }),
    );
  return true;
});

ensureInitialized().catch(() => {});
