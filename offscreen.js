chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "OFFSCREEN_PLAY_SOUND") {
    const audio = new Audio(
      chrome.runtime.getURL(message.src || "sounds/soft-click.wav"),
    );
    audio.volume = typeof message.volume === "number" ? message.volume : 0.35;
    audio
      .play()
      .then(() => sendResponse({ ok: true }))
      .catch((error) =>
        sendResponse({ ok: false, error: error.message || String(error) }),
      );
    return true;
  }

  if (message?.type === "OFFSCREEN_SHOW_NOTIFICATION") {
    try {
      if (!("Notification" in self)) {
        sendResponse({ ok: false, error: "Notification API unavailable" });
        return false;
      }

      const show = () => {
        const n = new Notification(message.title || "My Lenses Notify", {
          body: message.message || "",
          icon: message.iconUrl || chrome.runtime.getURL("icons/icon-128.png"),
          silent: true,
          requireInteraction: false,
        });
        // Auto-close soft fallback after a bit.
        setTimeout(() => n.close(), 12000);
        sendResponse({ ok: true, via: "Notification" });
      };

      if (Notification.permission === "granted") {
        show();
        return true;
      }

      Notification.requestPermission()
        .then((permission) => {
          if (permission !== "granted") {
            sendResponse({
              ok: false,
              error: `Notification permission: ${permission}`,
            });
            return;
          }
          show();
        })
        .catch((error) =>
          sendResponse({ ok: false, error: error.message || String(error) }),
        );
      return true;
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
      return false;
    }
  }

  return false;
});
