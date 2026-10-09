// Escape attempts from a mod's view (a sandboxed frame), shown next to the
// results the logic sends. Every attempt should be blocked.

const OTHER_MOD = "example.word-count";
const modBase = `${location.protocol}//${location.host}`;

const rows = document.getElementById("rows");
const summary = document.getElementById("summary");
const manual = document.getElementById("manual-result");

const blocked = (detail) => ({ status: "blocked", detail: String(detail || "") });
const leaked = (detail) => ({ status: "LEAKED", detail: String(detail || "") });
const errorText = (e) => (e && e.message ? `${e.name}: ${e.message}` : String(e));

async function rejects(start, ms = 3000) {
  try {
    const value = await Promise.race([start(), new Promise((_, no) => setTimeout(() => no(new Error("no answer")), ms))]);
    return leaked(value && value.status !== undefined ? `answered with status ${value.status}` : "it answered");
  } catch (e) {
    return blocked(errorText(e));
  }
}

function throws(run) {
  try {
    const value = run();
    return leaked(`no error (${typeof value})`);
  } catch (e) {
    return blocked(errorText(e));
  }
}

/** Loads an image or script: refused by the page's policy or failing is blocked, loading is LEAKED. */
function loads(kind, url) {
  return new Promise((done) => {
    const el = kind === "img" ? new Image() : document.createElement("script");
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      document.removeEventListener("securitypolicyviolation", onViolation);
      clearTimeout(timer);
      el.remove();
      done(result);
    };
    const onViolation = (e) => {
      if (e.blockedURI && url.startsWith(e.blockedURI)) finish(blocked(`refused by ${e.violatedDirective}`));
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    const timer = setTimeout(() => finish(blocked("no answer")), 3000);
    el.onload = () => setTimeout(() => finish(leaked("loaded")), 50);
    // Give a policy report the chance to arrive first, for the better detail.
    el.onerror = () => setTimeout(() => finish(blocked("did not load")), 300);
    el.src = url;
    if (kind === "script") document.head.appendChild(el);
  });
}

function connects(open, ms = 3000) {
  return new Promise((done) => {
    let socket;
    try {
      socket = open();
    } catch (e) {
      done(blocked(errorText(e)));
      return;
    }
    const timer = setTimeout(() => done(blocked("no connection")), ms);
    socket.onopen = () => {
      clearTimeout(timer);
      done(leaked("connected"));
      socket.close();
    };
    socket.onerror = () => {
      clearTimeout(timer);
      done(blocked("error event"));
      socket.close();
    };
  });
}

/**
 * A resource hint the page cannot watch: whether the webview acted on it
 * shows only on the network (the page's resource timing does not list hints).
 */
function hint(rel, hostName) {
  const link = document.createElement("link");
  link.rel = rel;
  link.href = `https://${hostName}/`;
  document.head.append(link);
  return {
    status: "manual",
    detail: `A page cannot see whether this went out. Watch the network while the tests run, for example with "sudo tcpdump -n -i any port 53 or host ${hostName}": a lookup of or a connection to ${hostName} is a leak.`,
  };
}

/** A call sent to the app's window instead of through the port: the app must not answer. */
function messageToApp() {
  return new Promise((done) => {
    const id = 424242;
    const onMessage = (e) => {
      if (e.source === parent && e.data && e.data.id === id) {
        removeEventListener("message", onMessage);
        done(leaked("the app answered"));
      }
    };
    addEventListener("message", onMessage);
    parent.postMessage({ t: "call", id, method: "files.list", params: [] }, "*");
    setTimeout(() => {
      removeEventListener("message", onMessage);
      done(blocked("no answer"));
    }, 1500);
  });
}

function ipcHandler() {
  const handler = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ipc;
  if (!handler) return blocked("not reachable");
  try {
    handler.postMessage(JSON.stringify({ cmd: "plugin:app|version", callback: 0, error: 0, payload: {}, options: {} }));
  } catch (e) {
    return blocked(errorText(e));
  }
  return {
    status: "reachable",
    detail: "A message can be posted, but the core ignores calls without the invoke key, which frames never get. Its log should show this one refused.",
  };
}

const TESTS = [
  ["The app's internals (__TAURI_INTERNALS__)", () => (typeof window.__TAURI_INTERNALS__ === "undefined" ? blocked("undefined") : leaked("defined"))],
  ["The app's API (__TAURI__)", () => (typeof window.__TAURI__ === "undefined" ? blocked("undefined") : leaked("defined"))],
  ["webkit.messageHandlers.ipc.postMessage", ipcHandler],
  ["window.ipc.postMessage", () => (window.ipc && typeof window.ipc.postMessage === "function" ? leaked("defined") : blocked("undefined"))],
  ["fetch ipc://localhost", () => rejects(() => fetch("ipc://localhost/plugin%3Aapp%7Cversion", { method: "POST", body: "{}" }))],
  ["fetch http://ipc.localhost", () => rejects(() => fetch("http://ipc.localhost/plugin%3Aapp%7Cversion", { method: "POST", body: "{}" }))],
  ["fetch https://example.com", () => rejects(() => fetch("https://example.com/", { mode: "no-cors" }))],
  ["fetch another mod's file", () => rejects(() => fetch(`${modBase}/${OTHER_MOD}/mod.json`))],
  // sendBeacon answers true when it queues the request, even when the content
  // policy then drops it, so only the network can tell. (A live check on
  // WebKitGTK 2.52 saw no connection.)
  ["sendBeacon to https://example.com", () => {
    try {
      return navigator.sendBeacon("https://example.com/", "x")
        ? { status: "manual", detail: "queued; watch the network: nothing should leave" }
        : blocked("refused");
    } catch (e) {
      return blocked(errorText(e));
    }
  }],
  ["WebSocket to wss://example.com", () => connects(() => new WebSocket("wss://example.com/"))],
  ["The app's page (parent.document)", () => throws(() => parent.document.body)],
  ["The app's address (top.location.href)", () => throws(() => top.location.href)],
  ["window.open https://example.com", () => {
    let opened = null;
    try {
      opened = window.open("https://example.com/");
    } catch (e) {
      return blocked(errorText(e));
    }
    if (!opened) return blocked("no window");
    try {
      opened.close();
    } catch {}
    return leaked("a window opened");
  }],
  ["Storage shared with the app (localStorage)", () => {
    try {
      return localStorage.length === 0 ? blocked("empty: storage of its own") : leaked(`holds ${localStorage.length} keys`);
    } catch (e) {
      return blocked(errorText(e));
    }
  }],
  ["Cookies (document.cookie)", () => {
    try {
      return document.cookie === "" ? blocked("empty") : leaked("cookies visible");
    } catch (e) {
      return blocked(errorText(e));
    }
  }],
  ["Script from another mod", () => loads("script", `${modBase}/${OTHER_MOD}/main.js`)],
  ["Image from another mod", () => loads("img", `${modBase}/${OTHER_MOD}/mod.json`)],
  ["Script from https://example.com", () => loads("script", "https://example.com/x.js")],
  ["Image from https://example.com", () => loads("img", "https://example.com/favicon.ico")],
  ["A call sent to the app's window", messageToApp],
  ["host.files.read without files:read", () => rejects(() => host.files.read("README.md"))],
  ["host.agents.list without agents:read", () => rejects(() => host.agents.list())],
  ["<link rel=\"preconnect\"> to another host", () => hint("preconnect", "preconnect-test.example.com")],
  ["<link rel=\"dns-prefetch\"> to another host", () => hint("dns-prefetch", "dns-prefetch-test.example.com")],
];

let viewResults = [];
let logicResults = [];

function render() {
  const all = [...viewResults, ...logicResults];
  rows.replaceChildren(
    ...all.map((r) => {
      const tr = document.createElement("tr");
      for (const [cls, text] of [["where", r.where], ["name", r.name], ["status", r.status], ["detail", r.detail]]) {
        const td = document.createElement("td");
        td.className = cls;
        td.textContent = text;
        if (cls === "status") td.dataset.status = r.status;
        tr.append(td);
      }
      return tr;
    }),
  );
  const leaks = all.filter((r) => r.status === "LEAKED").length;
  const waiting = all.filter((r) => r.status === "waiting").length;
  const manual = all.filter((r) => r.status === "manual").length;
  const byHand = manual ? ` ${manual} can only be checked by watching the network.` : "";
  if (!logicResults.length) summary.textContent = "Waiting for the logic's results…";
  else if (waiting) summary.textContent = `Running… ${all.length - waiting} of ${all.length} done.`;
  else if (leaks) summary.textContent = `${leaks} of ${all.length} attempts LEAKED.${byHand}`;
  else summary.textContent = `All ${all.length - manual} other attempts were blocked or guarded.${byHand}`;
  summary.dataset.status = leaks ? "LEAKED" : waiting ? "waiting" : "blocked";
}

async function runAll() {
  viewResults = TESTS.map(([name]) => ({ name, where: "view", status: "waiting", detail: "" }));
  render();
  await Promise.all(
    TESTS.map(async ([, test], i) => {
      let outcome;
      try {
        outcome = await test();
      } catch (e) {
        outcome = blocked(errorText(e));
      }
      viewResults[i] = { ...viewResults[i], ...outcome };
      render();
    }),
  );
}

host.logic.onMessage((results) => {
  logicResults = Array.isArray(results) ? results : [];
  render();
});

document.getElementById("run").addEventListener("click", () => {
  host.logic.post("run");
  void runAll();
});

// ---- By hand ----

const say = (text) => (manual.textContent = text);

document.getElementById("nav-self").addEventListener("click", () => {
  say("Asked to open example.com here. If this page is still shown, it was refused.");
  location.href = "https://example.com/";
});

document.getElementById("nav-other").addEventListener("click", () => {
  say("Asked to open another mod's page here.");
  // It may show, but the app connects only a frame's first page: it stays
  // unconnected, and this mod gets a failure ("went to another page").
  location.href = `${modBase}/${OTHER_MOD}/view.html`;
});

document.getElementById("hijack").addEventListener("click", () => {
  say("Opening a page of this mod that waits for a connection and tries to use it.");
  // Expected there: "blocked", and a failure for this mod on the Mods page.
  location.href = "hijack.html";
});

/** Tries to send the whole app window somewhere; a sandboxed frame may not. */
function sendTop(url) {
  try {
    top.location.href = url;
    say("No error. If the app window left, that is a leak.");
  } catch (e) {
    say(`blocked: ${errorText(e)}`);
  }
}

document.getElementById("nav-top").addEventListener("click", () => sendTop("https://example.com/"));
document.getElementById("nav-top-mod").addEventListener("click", () => sendTop(`${modBase}/${OTHER_MOD}/view.html`));

document.getElementById("form").addEventListener("click", () => {
  const form = document.createElement("form");
  form.action = "https://example.com/";
  form.method = "get";
  document.body.append(form);
  try {
    form.submit();
    say("Submitted. If this page is still shown, it was refused.");
  } catch (e) {
    say(`blocked: ${errorText(e)}`);
  }
  form.remove();
});

/** Makes `count` calls at once and says how many were answered, refused or never answered within `ms`. */
async function burst(count, ms, expected) {
  say(`Making ${count} calls…`);
  const outcomes = await Promise.all(
    Array.from({ length: count }, () =>
      Promise.race([
        host.theme.tokens().then(() => "answered", () => "refused"),
        new Promise((done) => setTimeout(() => done("unanswered"), ms)),
      ]),
    ),
  );
  const n = (kind) => outcomes.filter((o) => o === kind).length;
  say(`${n("answered")} answered, ${n("refused")} refused, ${n("unanswered")} not answered within ${ms / 1000} s. Expected: ${expected}`);
}

document.getElementById("burst").addEventListener("click", () =>
  burst(300, 5000, "all 300 answered within about a second (the app reads 200 a second; the rest wait), and no failure."),
);

document.getElementById("flood").addEventListener("click", () =>
  burst(
    5000,
    15_000,
    "about 2200 answered (200 at once, 2000 that waited their turn), the rest never answered, and one failure for this mod on the Mods page.",
  ),
);

document.getElementById("answers").addEventListener("click", () => {
  say("The logic is sending answers to checks the app never made, 1000 a second. Expected: within a few seconds this mod is turned off (this view goes away), and the Mods page lists \"It answered a check the app did not make.\" Turn it on again afterwards.");
  host.logic.post("flood-answers");
});

host.logic.post("hello");
void runAll();
