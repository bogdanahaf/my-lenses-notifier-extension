(() => {
  "use strict";

  const PENDING_STATUSES = [
    "Processing",
    "In Review",
    "Reviewing",
    "Under Review",
  ];

  const KNOWN_STATUSES = [
    ...PENDING_STATUSES,
    "Ready to Publish",
    "Ready for Publishing",
    "Ready to Publishing",
    "Action Needed",
    "Approved",
    "Complete",
    "Completed",
    "Failed",
    "Invalid",
    "Live",
    "Needs Attention",
    "Offline",
    "Published",
    "Rejected",
    "Awaiting Product Tagging",
  ];

  const normalize = (value) =>
    String(value || "")
      .replace(/\s+/g, " ")
      .trim();

  const statusByKey = new Map(
    KNOWN_STATUSES.map((status) => [status.toLowerCase(), status]),
  );

  const api = Object.freeze({
    VERSION: "2.0.0",
    PENDING_STATUSES: Object.freeze(PENDING_STATUSES),
    KNOWN_STATUSES: Object.freeze(KNOWN_STATUSES),
    STORAGE_KEYS: Object.freeze({
      email: "notifyEmail",
      keepAwake: "keepAwakeEnabled",
      watches: "watches",
      emailActivated: "emailActivated",
      emailLog: "emailLog",
      pollLog: "pollLog",
      lastDesktopAlert: "lastDesktopAlert",
      lastHeartbeatAt: "lastHeartbeatAt",
      lastHeartbeatReason: "lastHeartbeatReason",
      lastPollAt: "lastPollAt",
    }),
    TICK_ALARM: "my-lenses-notifier-tick-v2",
    TICK_MINUTES: 0.5,
    POLL_INTERVAL_MS: 60_000,
    POLL_DUE_AFTER_MS: 55_000,
    PAGE_TICK_MS: 30_000,
    normalize,
    canonicalStatus(value) {
      return statusByKey.get(normalize(value).toLowerCase()) || null;
    },
    isPending(value) {
      const status = statusByKey.get(normalize(value).toLowerCase());
      return Boolean(status && PENDING_STATUSES.includes(status));
    },
    lensIdFromUrl(value) {
      try {
        return (
          new URL(value).pathname.match(/\/lenses\/([^/?#]+)/)?.[1] || null
        );
      } catch {
        return null;
      }
    },
  });

  globalThis.MyLensesNotify = api;
})();
