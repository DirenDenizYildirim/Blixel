// Opened in the Escape tests view by going to another page, this page tries
// to take and use a port meant for the page it replaced: first by waiting for
// the app to hand one over, then, if one comes, by guessing the key and
// making a call. Both should fail.

const result = document.getElementById("result");
let taken = null;

function show(status, text) {
  result.dataset.status = status;
  result.textContent = `${status}: ${text}`;
}

addEventListener("message", (event) => {
  if (taken || !event.ports || !event.ports[0]) return;
  const port = event.ports[0];
  taken = port;
  port.onmessage = (e) => {
    if (e.data && e.data.t === "result") show("LEAKED", "the app answered a call on a port this page took.");
  };
  port.postMessage({ t: "hello", k: "0".repeat(32) });
  port.postMessage({ t: "call", id: 1, method: "theme.tokens", params: [] });
  result.textContent = "A port arrived; waiting to see whether the app answers on it…";
  setTimeout(() => {
    if (result.dataset.status !== "LEAKED") show("blocked", "a port arrived, but the app did not answer on it (the key check held).");
  }, 3000);
});

setTimeout(() => {
  if (!taken) show("blocked", "no connection was offered to this page.");
}, 3000);
