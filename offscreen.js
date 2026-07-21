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

  return false;
});
