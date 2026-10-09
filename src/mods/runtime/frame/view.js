// Runs first in every page of a mod (the app inserts it at the top of <head>).
// It defines the global `host` for views, connects it to the app when the app
// hands over a port after the page has loaded (proving with the key in the
// page's address that it is the page the app opened), keeps the page in the
// current theme as CSS variables, and reports uncaught errors.
//
// The same file holds the client behind `host` for a mod's logic too:
// logic.js loads it with data-role="client" and runs createHost in the mod's
// worker, so both kinds of frame share one client.
//
// Plain browser JavaScript, served as is. Nothing here is trusted by the app;
// it checks every message on its side.

(function () {
  "use strict";

  /**
   * The `host` object, over `post`, which sends one message to the app.
   * It must use nothing from outside its own body but standard globals:
   * logic.js turns it into source text for the worker.
   */
  function createHost(post, info, flavour) {
    "use strict";
    let nextId = 1;
    const pending = new Map();
    const listeners = new Map();
    const commands = new Map();
    let markReady;
    const ready = new Promise((resolve) => (markReady = resolve));

    const describe = (error) =>
      error instanceof Error ? error.name + ": " + error.message : typeof error === "string" ? error : String(error);

    /** Tells the app about an error in the mod's code; it counts as a failure. */
    function fail(text) {
      try {
        post({ t: "event", name: "error", data: String(text).slice(0, 1000) });
      } catch (e) {
        // Nothing more to do; the console has it.
      }
    }

    function report(error) {
      console.error(error);
      fail(describe(error));
    }

    // A mistake in how the API was used: the console says so, it is not a failure.
    const warn = (error) => console.warn("host: " + describe(error));

    function call(method, params) {
      return new Promise((resolve, reject) => {
        const id = nextId++;
        pending.set(id, { resolve, reject });
        try {
          post({ t: "call", id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(new TypeError(method + ": the arguments are not plain data (" + describe(error) + ")"));
        }
      });
    }

    /** Adds a listener; `subscription` names an event the app sends only while someone listens. */
    function listen(name, listener, subscription) {
      if (typeof listener !== "function") throw new TypeError("A listener must be a function.");
      let set = listeners.get(name);
      if (!set) listeners.set(name, (set = new Set()));
      if (subscription && set.size === 0) call("subscribe", [subscription]).catch(warn);
      set.add(listener);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        set.delete(listener);
        if (subscription && set.size === 0) call("unsubscribe", [subscription]).catch(() => {});
      };
    }

    function emit(name, value) {
      const set = listeners.get(name);
      if (!set) return;
      for (const listener of Array.from(set)) {
        try {
          listener(value);
        } catch (error) {
          report(error);
        }
      }
    }

    /** One message from the app. */
    function receive(m) {
      if (!m || typeof m !== "object") return;
      if (m.t === "result") {
        const waiting = pending.get(m.id);
        if (!waiting) return;
        pending.delete(m.id);
        if (m.ok) waiting.resolve(m.value === undefined ? null : m.value);
        else waiting.reject(new Error(m.error || "The app refused this."));
        return;
      }
      if (m.t !== "event") return;
      const d = m.data;
      switch (m.name) {
        case "command": {
          const run = d && commands.get(d.id);
          if (!run) return;
          try {
            run(d.arg === null ? undefined : d.arg);
          } catch (error) {
            report(error);
          }
          return;
        }
        case "post":
          if (flavour === "view") emit("post", d);
          else if (d && typeof d.view === "string") emit("post:" + d.view, d.message);
          return;
        case "shown":
          if (d && typeof d.view === "string") emit("shown:" + d.view, Boolean(d.shown));
          return;
        case "theme":
          emit("theme");
          return;
        case "workspace":
          emit("workspace");
          return;
        case "saved":
          emit("saved", d);
          return;
        case "agents":
          emit("agents", d);
          return;
      }
    }

    const host = {
      api: info.api,
      mod: info.mod,
      ready,
      commands: {
        register(id, run) {
          if (typeof id !== "string" || typeof run !== "function") {
            throw new TypeError("commands.register takes a command id from mod.json and a function.");
          }
          commands.set(id, run);
          call("commands.register", [id]).catch((error) => {
            if (commands.get(id) === run) commands.delete(id);
            warn(error);
          });
          let active = true;
          return () => {
            if (!active) return;
            active = false;
            if (commands.get(id) !== run) return;
            commands.delete(id);
            call("commands.unregister", [id]).catch(() => {});
          };
        },
        run: (id, arg) => call("commands.run", [id, arg === undefined ? null : arg]).then(() => undefined),
      },
      notify(text) {
        call("notify", [String(text)]).catch(warn);
      },
      storage: {
        get: (key) => call("storage.get", [key]).then((value) => (value === null ? undefined : value)),
        set: (key, value) => call("storage.set", [key, value === undefined ? null : value]).then(() => undefined),
      },
      theme: {
        tokens: () => call("theme.tokens", []),
        onChange: (listener) => listen("theme", listener),
      },
      workspace: {
        name: () => call("workspace.name", []),
        onChange: (listener) => listen("workspace", listener),
      },
      files: {
        list: () => call("files.list", []),
        read: (path) => call("files.read", [path]),
        active: () => call("files.active", []),
        onSaved: (listener) => listen("saved", listener, "saved"),
      },
      agents: {
        list: () => call("agents.list", []),
        onStatus: (listener) => listen("agents", listener, "agents"),
      },
    };

    if (flavour === "view") {
      host.logic = {
        post(message) {
          post({ t: "event", name: "post", data: message === undefined ? null : message });
        },
        onMessage: (listener) => listen("post", listener),
      };
    } else {
      host.views = {
        post(view, message) {
          post({ t: "event", name: "post", data: { view: String(view), message: message === undefined ? null : message } });
        },
        onMessage: (view, listener) => listen("post:" + view, listener),
        onShown: (view, listener) => listen("shown:" + view, listener),
      };
    }

    return { host, receive, fail, describe, markReady };
  }

  // Loaded by logic.js: hand over the client and do nothing else.
  const script = document.currentScript;
  if (script && script.dataset.role === "client") {
    window.__hostClient = createHost;
    return;
  }

  // ---- A view ----

  const root = document.documentElement;
  const kebab = (key) => key.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

  /** The theme's tokens as CSS variables with the app's names (--bg, --accent-ink...). */
  function applyTheme(theme) {
    if (!theme || typeof theme !== "object") return;
    const tokens = theme.tokens && typeof theme.tokens === "object" ? theme.tokens : {};
    for (const key of Object.keys(tokens)) root.style.setProperty("--" + kebab(key), String(tokens[key]));
    root.style.colorScheme = theme.light ? "light" : "dark";
    root.classList.add("host-ready");
  }
  // base.css hides the page until the theme arrives; never for longer than this.
  setTimeout(() => root.classList.add("host-ready"), 1500);

  // The key the app put in this page's address (#k=...). The first message on
  // the port sends it back: the app hands the port to whatever page is in the
  // frame, and reads nothing from it until the key matches. It leaves the
  // address at once, so the page's own scripts see a clean one.
  const keyMatch = /^#k=([0-9a-f]{32})$/.exec(location.hash);
  const key = keyMatch ? keyMatch[1] : "";
  if (keyMatch) {
    try {
      history.replaceState(history.state, "", location.pathname + location.search);
    } catch (e) {
      // The address keeps it; the page's own scripts can live with that.
    }
  }

  // The mod this page belongs to, from its address: /<mod id>/<path>.
  const modId = decodeURIComponent(location.pathname.split("/")[1] || "");
  const info = { mod: { id: modId, granted: [] }, api: { major: 1, minor: 0 } };
  let port = null;
  const queue = [];
  const copy = typeof structuredClone === "function" ? structuredClone : (value) => value;

  // Messages sent before the app has connected wait here; copying now throws at once for data that cannot be sent.
  const client = createHost(
    (message) => {
      if (port) port.postMessage(message);
      else queue.push(copy(message));
    },
    info,
    "view",
  );
  window.host = client.host;

  addEventListener("message", (event) => {
    const data = event.data;
    if (port || event.source !== parent || !data || data.t !== "init" || data.kind !== "view") return;
    if (!event.ports || !event.ports[0]) return;
    port = event.ports[0];
    // The key first. A page the app did not open here has none, and the app closes its port.
    port.postMessage({ t: "hello", k: key });
    const granted = data.mod && Array.isArray(data.mod.granted) ? data.mod.granted : [];
    for (const capability of granted) info.mod.granted.push(String(capability));
    info.api.minor = (data.api && data.api.minor) || 0;
    applyTheme(data.theme);
    port.onmessage = (e) => {
      const m = e.data;
      // The variables change before any listener runs, so listeners see the new colours.
      if (m && m.t === "event" && m.name === "theme") applyTheme(m.data);
      client.receive(m);
    };
    for (const message of queue.splice(0)) port.postMessage(message);
    client.markReady();
  });

  addEventListener("error", (event) => {
    const where = event.filename ? " (" + event.filename.split("/").pop() + (event.lineno ? ":" + event.lineno : "") + ")" : "";
    client.fail((event.message || "An error") + where);
  });
  addEventListener("unhandledrejection", (event) => {
    client.fail("Unhandled rejection: " + client.describe(event.reason));
  });
})();
