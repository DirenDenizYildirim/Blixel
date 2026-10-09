// The background page of a mod with code. The app serves it as
// __host/logic.html, with the mod's main script in base64 in <script id="main">,
// inside a sandboxed frame that cannot reach the app. Once the app hands over
// a port, this page sends back the key from its address, starts the mod's
// script in a worker with the global `host` defined in front of it, and gives
// the port to the worker. From then on the worker and the app talk directly:
// this page passes nothing on, so a busy worker cannot keep it (and the
// window's thread) busy. It reports errors from before the worker's script
// ran (a script that does not load or parse); the worker reports the rest.
//
// Plain browser JavaScript, served as is. Nothing here is trusted by the app;
// it checks every message on its side.

(function () {
  "use strict";

  // The key the app put in this page's address (#k=...); the first message on the port sends it back.
  const keyMatch = /^#k=([0-9a-f]{32})$/.exec(location.hash);
  const key = keyMatch ? keyMatch[1] : "";

  // The client behind `host`, shared with views (see view.js).
  const client = document.createElement("script");
  client.src = "view.js";
  client.dataset.role = "client";
  document.head.appendChild(client);

  /**
   * Runs first in the worker, before the mod's code: defines `host`, takes
   * the port from the page, answers the app's checks and reports errors and
   * promises nobody handled. Like createHost it is turned into source text,
   * so it uses nothing from outside its body.
   */
  function bootstrap(createHost, info) {
    "use strict";
    let port = null;
    const queue = [];
    // Until the port arrives, messages wait; copying now throws at once for data that cannot be sent.
    const client = createHost(
      (message) => {
        if (port) port.postMessage(message);
        else queue.push(structuredClone(message));
      },
      info,
      "logic",
    );
    self.host = client.host;
    client.markReady();

    function takePort(event) {
      if (!event.ports || !event.ports[0]) return;
      self.removeEventListener("message", takePort);
      const taken = event.ports[0];
      port = taken;
      taken.onmessage = (e) => {
        const m = e.data;
        if (m && m.t === "ping") taken.postMessage({ t: "pong", n: m.n });
        else client.receive(m);
      };
      for (const message of queue.splice(0)) taken.postMessage(message);
    }
    self.addEventListener("message", takePort);

    self.addEventListener("error", (event) => {
      event.preventDefault();
      const line = event.lineno > info.offset ? " (line " + (event.lineno - info.offset) + ")" : "";
      client.fail((event.message || "An error") + line);
    });
    self.addEventListener("unhandledrejection", (event) => {
      client.fail("Unhandled rejection: " + client.describe(event.reason));
    });

    // The page passes nothing on: the worker's own postMessage is not a way to
    // the app, and a message that reaches the page anyway stops the worker.
    const toPage = self.postMessage.bind(self);
    self.postMessage = function () {
      throw new TypeError("postMessage does not reach the app. Use host.views.post and the other parts of host.");
    };
    toPage("up");
  }

  function decodeBase64(text) {
    const binary = atob(text.replace(/\s+/g, ""));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function start(port, init) {
    const fail = (text) => port.postMessage({ t: "event", name: "error", data: text });
    const createHost = window.__hostClient;
    if (typeof createHost !== "function") {
      fail("The mod runtime could not load.");
      return;
    }
    // The worker's script: the client and bootstrap first, then the mod's code
    // as it is. Error lines are counted from the start of the mod's code.
    const head = "(" + bootstrap + ")(" + createHost + ", ";
    const info = {
      mod: { id: String(init.mod.id), granted: Array.isArray(init.mod.granted) ? init.mod.granted.map(String) : [] },
      api: { major: Number(init.api.major), minor: Number(init.api.minor) },
      offset: head.split("\n").length,
    };
    let worker;
    try {
      const code = decodeBase64(document.getElementById("main").textContent || "");
      const url = URL.createObjectURL(new Blob([head, JSON.stringify(info), ");\n", code], { type: "text/javascript" }));
      worker = new Worker(url, { name: info.mod.id });
    } catch (error) {
      fail("Its code could not start: " + (error && error.message ? error.message : String(error)));
      return;
    }
    let handed = false;
    worker.onmessage = (event) => {
      if (handed) {
        worker.onmessage = null;
        worker.terminate();
        return;
      }
      if (event.data !== "up") return;
      handed = true;
      worker.postMessage(null, [port]);
    };
    worker.onerror = (event) => {
      event.preventDefault();
      // Errors the worker handles itself never come here.
      if (handed) return;
      const line = event.lineno > info.offset ? " (line " + (event.lineno - info.offset) + ")" : "";
      fail((event.message || "An error") + line);
    };
  }

  let started = false;
  addEventListener("message", (event) => {
    const data = event.data;
    if (started || event.source !== parent || !data || data.t !== "init" || data.kind !== "logic") return;
    if (!event.ports || !event.ports[0] || !data.mod || !data.api) return;
    started = true;
    const port = event.ports[0];
    // The key first, so the app trusts this port.
    port.postMessage({ t: "hello", k: key });
    // The app connects after this page has loaded, so the client is normally here already.
    if (typeof window.__hostClient === "function") start(port, data);
    else {
      client.addEventListener("load", () => start(port, data));
      client.addEventListener("error", () => start(port, data));
    }
  });
})();
