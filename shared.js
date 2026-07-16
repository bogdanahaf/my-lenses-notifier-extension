(() => {
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

  const api = {
    PENDING_STATUSES,
    KNOWN_STATUSES,
    STORAGE_KEYS: {
      email: "notifyEmail",
      keepAwake: "keepAwakeEnabled",
      watches: "watches",
      emailActivated: "emailActivated",
    },
    ALARM_NAME: "my-lenses-poll",
    CHECK_MINUTES: 1,
    normalize(value) {
      return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
    },
    isPending(status) {
      return PENDING_STATUSES.some(
        (item) => item.toLowerCase() === String(status || "").toLowerCase(),
      );
    },
    lensIdFromUrl(url) {
      try {
        return new URL(url).pathname.match(/\/lenses\/([^/?#]+)/)?.[1] || null;
      } catch {
        return null;
      }
    },
  };

  if (typeof globalThis !== "undefined") {
    globalThis.MyLensesNotifyShared = api;
  }
  if (typeof window !== "undefined") {
    window.MyLensesNotifyShared = api;
  }
})();
