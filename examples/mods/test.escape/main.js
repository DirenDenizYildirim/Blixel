// Escape attempts from a mod's logic, which runs in a worker started inside a
// sandboxed frame. Every attempt should be blocked; the results go to the
// view, which shows them next to its own. Nothing here is meant as an example
// of how to write a mod.

const OTHER_MOD = "example.word-count";

// The raw port to the app, taken the way any mod's code could: by listening
// for the message that hands it to this worker. Only the by-hand flood below
// uses it; everything else goes through `host`.
let rawPort = null;
self.addEventListener("message", (event) => {
  if (!rawPort && event.ports && event.ports[0]) rawPort = event.ports[0];
});

/** Where mod files are served from: the custom scheme, or http://mod.localhost on Windows. */
function modBase() {
  return /Windows/i.test(navigator.userAgent) ? "http://mod.localhost" : "mod://localhost";
}

const blocked = (detail) => ({ status: "blocked", detail: String(detail || "") });
const leaked = (detail) => ({ status: "LEAKED", detail: String(detail || "") });
const errorText = (e) => (e && e.message ? `${e.name}: ${e.message}` : String(e));

/** Blocked if the promise rejects (or never settles), LEAKED if it resolves. */
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

/** For connections that report by events: open is LEAKED, error or close is blocked. */
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

const TESTS = [
  ["The app's internals (__TAURI_INTERNALS__)", () => (typeof self.__TAURI_INTERNALS__ === "undefined" ? blocked("undefined") : leaked("defined"))],
  ["WebKit message handlers", () => (typeof self.webkit === "undefined" ? blocked("undefined") : leaked("self.webkit is defined"))],
  ["fetch ipc://localhost", () => rejects(() => fetch("ipc://localhost/plugin%3Aapp%7Cversion", { method: "POST", body: "{}" }))],
  ["fetch http://ipc.localhost", () => rejects(() => fetch("http://ipc.localhost/plugin%3Aapp%7Cversion", { method: "POST", body: "{}" }))],
  ["fetch https://example.com", () => rejects(() => fetch("https://example.com/", { mode: "no-cors" }))],
  ["fetch another mod's file", () => rejects(() => fetch(`${modBase()}/${OTHER_MOD}/mod.json`))],
  ["fetch this mod's own file", () => rejects(() => fetch(`${modBase()}/test.escape/mod.json`))],
  ["XMLHttpRequest to https://example.com", () =>
    new Promise((done) => {
      try {
        const xhr = new XMLHttpRequest();
        xhr.open("GET", "https://example.com/");
        xhr.onload = () => done(leaked(`status ${xhr.status}`));
        xhr.onerror = () => done(blocked("error event"));
        xhr.send();
      } catch (e) {
        done(blocked(errorText(e)));
      }
    })],
  ["WebSocket to wss://example.com", () => connects(() => new WebSocket("wss://example.com/"))],
  ["EventSource from https://example.com", () => connects(() => new EventSource("https://example.com/"))],
  ["importScripts from https://example.com", () => throws(() => importScripts("https://example.com/x.js"))],
  ["importScripts another mod's file", () => throws(() => importScripts(`${modBase()}/${OTHER_MOD}/main.js`))],
  ["host.files.list without files:read", () => rejects(() => host.files.list())],
  ["host.agents.list without agents:read", () => rejects(() => host.agents.list())],
  ["Run another mod's command", () => rejects(() => host.commands.run(`mod:${OTHER_MOD}:count`))],
  ["Run a built-in command (mods.open)", () => rejects(() => host.commands.run("mods.open"))],
  ["Store a value over 1 MB", () => rejects(() => host.storage.set("big", "x".repeat(1_100_000)))],
  ["postMessage from the worker to its page", () => throws(() => postMessage({ t: "call", id: 1, method: "files.list", params: [] }))],
];

let results = [];

async function runAll() {
  results = TESTS.map(([name]) => ({ name, where: "logic", status: "waiting", detail: "" }));
  host.views.post("report", results);
  await Promise.all(
    TESTS.map(async ([, test], i) => {
      let outcome;
      try {
        outcome = await test();
      } catch (e) {
        outcome = { status: "blocked", detail: errorText(e) };
      }
      results[i] = { ...results[i], ...outcome };
    }),
  );
  host.views.post("report", results);
}

/**
 * Answers to checks the app never made, 1000 a second for 6 seconds, straight
 * on the raw port. Each one is a failure, so the app should turn this mod off
 * within a few seconds.
 */
function floodAnswers() {
  if (!rawPort) return;
  let rounds = 0;
  const timer = setInterval(() => {
    for (let i = 0; i < 100; i++) rawPort.postMessage({ t: "pong", n: -1 });
    if (++rounds >= 60) clearInterval(timer);
  }, 100);
}

host.commands.register("run", () => void runAll());
host.views.onMessage("report", (message) => {
  if (message === "hello") host.views.post("report", results);
  if (message === "run") void runAll();
  if (message === "flood-answers") floodAnswers();
});

void runAll();
