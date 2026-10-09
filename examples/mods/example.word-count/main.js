// The logic of the word count. It runs in a worker with the global `host`
// (see docs/host-api.d.ts). The count lives here rather than in the view,
// because a view reloads whenever it is moved.

/** The last count: { path, words, lines } or { path, error }; null when no file is open. */
let current = null;
let poll = null;

function countWords(text) {
  const words = text.match(/[\p{L}\p{N}_'’-]+/gu);
  return words ? words.length : 0;
}

/** Counts the saved text of `path`, or of the active file, and shows it in the view. */
async function recount(path) {
  try {
    if (path === undefined) {
      const active = await host.files.active();
      path = active ? active.path : null;
    }
    if (!path) current = null;
    else {
      const text = await host.files.read(path);
      current = { path, words: countWords(text), lines: text ? text.split("\n").length : 0 };
    }
  } catch (error) {
    // Too large, binary or gone: say so instead of failing.
    current = { path, error: error.message };
  }
  host.views.post("count", current);
  return current;
}

// The command (Ctrl+Alt+W, or the palette): count now and say so in a notice.
host.commands.register("count", async () => {
  const count = await recount();
  if (!count) host.notify("No file is open.");
  else if (count.error) host.notify(`Could not count ${count.path}: ${count.error}`);
  else host.notify(`${count.path.split("/").pop()} has ${count.words.toLocaleString()} words.`);
});

// Saving the counted file, or the active one, updates the count.
host.files.onSaved(async (path) => {
  const active = await host.files.active();
  if ((current && path === current.path) || (active && path === active.path)) await recount(path);
});

// While the view is shown, notice when another file becomes active. There is
// no event for that, so ask every two seconds; a file is read only on a change.
host.views.onShown("count", (shown) => {
  clearInterval(poll);
  poll = null;
  if (!shown) return;
  void recount();
  poll = setInterval(async () => {
    const active = await host.files.active();
    const path = active ? active.path : null;
    if (path !== (current ? current.path : null)) await recount(path);
  }, 2000);
});

// A view that has just loaded asks for what is known so far.
host.views.onMessage("count", (message) => {
  if (message === "hello") host.views.post("count", current);
});

host.workspace.onChange(() => void recount());
