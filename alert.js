const params = new URLSearchParams(location.search);
const title = params.get("title") || "My Lenses Notify";
const message = params.get("message") || "";

document.getElementById("title").textContent = title;
document.getElementById("message").textContent = message || "Your watched Lens left Processing / In Review.";
document.title = title;
document.getElementById("icon").src = chrome.runtime.getURL("icons/icon-128.png");

const closeBtn = document.getElementById("closeBtn");
const secEl = document.getElementById("sec");
let left = 12;

closeBtn.addEventListener("click", () => window.close());

const timer = setInterval(() => {
  left -= 1;
  secEl.textContent = String(Math.max(0, left));
  if (left <= 0) {
    clearInterval(timer);
    window.close();
  }
}, 1000);
