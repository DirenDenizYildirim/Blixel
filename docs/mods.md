# Writing mods

A mod is a folder that adds something to the app (currently named Blixel):
a colour theme, rules you can give an agent, a window layout, commands, or
views of your own with code behind them. Mods are shared as folders; the user
installs one, reads what it asks for, and turns it on.

Three working examples are in `examples/mods/`:

- `example.dusk-theme`: a theme, nothing else.
- `example.docs-only`: a rule pack for an agent that writes documentation.
- `example.word-count`: code, a view and a command with a key.

`examples/mods/test.escape` is not an example: it tries every known way out of
the sandbox and shows each result, for checking the sandbox by hand after a
change (see [Security](#security-in-plain-words)).

## Contents

- [The folder](#the-folder)
- [mod.json](#modjson)
- [The icon](#the-icon)
- [Themes](#themes)
- [Rule packs](#rule-packs)
- [Layouts](#layouts)
- [Commands and keys](#commands-and-keys)
- [Views](#views)
- [The logic (`main`)](#the-logic-main)
- [The host API](#the-host-api)
- [Permissions and approval](#permissions-and-approval)
- [Changes, hashes and dev mode](#changes-hashes-and-dev-mode)
- [Limits](#limits)
- [Installing](#installing)
- [Security in plain words](#security-in-plain-words)

## The folder

```
example.word-count/        named exactly like the mod's id
  mod.json                 the manifest: required
  main.js                  the logic, if the mod has code
  view.html                a view's page
  panel.js                 files that pages load: scripts, styles, images, fonts
```

- The folder's name must equal the `id` in `mod.json`.
- At most 2000 files, 2000 folders and 20 MB in all.
- Only plain files and folders: no links (symbolic links make the mod invalid).
- Paths in `mod.json` are relative to the folder, with `/`, and never `..`.

A mod with only themes, rule packs and layouts has **no code**: nothing of it
runs, the app only reads its `mod.json`. A mod with `main` or views **has
code**, which runs sandboxed as described below.

## mod.json

```json
{
  "id": "example.word-count",
  "name": "Word count",
  "version": "1.0.0",
  "api": 1,
  "author": "Example",
  "description": "Counts the words in the file you have open.",
  "main": "main.js",
  "permissions": ["files:read"],
  "contributes": {
    "commands": [{ "id": "count", "title": "Count words in this file", "key": "Ctrl+Alt+W" }],
    "views": [{ "id": "count", "title": "Word count", "entry": "view.html" }]
  }
}
```

| Field | Required | What it is |
| --- | --- | --- |
| `id` | yes | `"author.name"`: lower-case letters, digits and `-`, with exactly one `.`. Equal to the folder name. Ids starting with `builtin.` are kept for the app's own mods. |
| `name` | yes | The name people see: at most 40 characters, and not the app's own name. |
| `version` | yes | Semver, like `"1.2.0"` or `"2.0.0-beta.1"`. |
| `api` | yes | The major version of the mod API the mod is made for. This version runs `1`; a mod made for another is refused with a reason. |
| `author` | no | Who made it. |
| `description` | no | One or two sentences shown on the Mods page. |
| `icon` | no | Its picture on the Mods page, drawn in pixels. See [The icon](#the-icon). Without one, the app draws a picture for what the mod adds, in a colour from its id. |
| `main` | no | The logic: one script, run in a sandboxed worker. |
| `permissions` | no | What the code may see beyond its own views: `"files:read"`, `"agents:read"`. See [Permissions](#permissions-and-approval). |
| `contributes` | no | What the mod adds: `themes`, `rulePacks`, `layouts`, `commands`, `views`. Each is a list. |

Every entry in a `contributes` list has an `id` of its own: letters, digits,
`-` or `_`, at most 64 characters, used once in that list. Kinds of
contribution this version does not know are skipped, so a mod made for a
later minor version still loads what it can. Anything wrong in the manifest
keeps the whole mod from running, and the Mods page says where the problem is.

Texts people read must read as they are. The name, author, titles, labels,
descriptions and a rule pack's instructions and patterns may not contain
characters that do not show or that reorder text: control characters (a tab or line break is
allowed only in the mod's `description` and a rule pack's `instructions` and
`editArea`), zero-width characters, direction marks, embeddings, overrides
and isolates (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069 and the like), the
byte order mark and tag characters. Titles and labels (of commands, views,
themes, layouts and rule packs) are at most 60 characters.

## The icon

A mod's icon is pixel art written into `mod.json`: each row is a string,
each character one pixel, and `colors` says which colour each character is.
`.` or a space is an empty pixel.

```json
"icon": {
  "pixels": [
    "................",
    ".....oooooo.....",
    "....oddddddo....",
    "....odoooodo....",
    "....odo..odo....",
    "....odo..odo....",
    "..oooooooooooo..",
    "..ollllllllllo..",
    "..ommmmmmmmmmo..",
    "..ommmmkkmmmmo..",
    "..ommmmkkmmmmo..",
    "..ommmmkkmmmmo..",
    "..ommmmmmmmmmo..",
    "..oeeeeeeeeeeo..",
    "..oooooooooooo..",
    "................"
  ],
  "colors": { "o": "#262b36", "d": "#8a93a6", "l": "#f2cf7a", "m": "#d9a441", "e": "#a3742a", "k": "#262b36" }
}
```

- 16 by 16 pixels is the usual size; anything from 8 to 32 pixels a side
  works, as long as every row is as long as the first.
- Colours are hex only (`#rgb`, `#rrggbb` or `#rrggbbaa`), at most 16, and
  every character used in `pixels` needs one.
- It is drawn at a whole number of screen pixels per icon pixel (4 for a
  16 by 16 icon) on a tile washed with its most used colour, so a dark
  outline around the picture reads well in light and dark themes.
- `example.dusk-theme` (a moon) and `test.escape` (a padlock) have icons of
  their own; the other examples show the pictures the app draws.

## Themes

```json
"themes": [
  {
    "id": "dusk",
    "label": "Dusk",
    "light": false,
    "tokens": { "bg": "#211f2e", "fg": "#ddd8f0", "accent": "#f2a65e", "...": "every token below" }
  }
]
```

- `label`: its name in the theme menu and in Settings.
- `light`: `true` for a light theme (form controls and scrollbars follow it).
- `tokens`: every token below, no others.

Colours may be written only as `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()`,
`hsl()`/`hsla()` or `oklch()`, with plain numbers and percentages inside.
Nothing else is accepted (no names like `red`, no `var()`, no `url()`): tokens
become CSS variables, and anything more could load files or break the window.

| Token | Used for |
| --- | --- |
| `bg` | The main background. |
| `side` | The sidebar. |
| `card` | Cards and panels, chat bubbles. |
| `code` | The editor, inputs and code blocks. |
| `sel` | Hover and selection backgrounds. |
| `line` | Dividers, quiet borders, scrollbars, pressed buttons. |
| `border` | Borders of buttons and fields. |
| `fg` | Text. |
| `strong` | Headings and emphasised text. |
| `muted` | Secondary text. |
| `com` | Comments in code. |
| `accent` | The accent: primary buttons, links, focus rings. |
| `accentInk` | Text on the accent colour. |
| `dangerBg`, `dangerLine`, `dangerFg` | Background, border and text of warnings about risky actions. |
| `kw`, `str`, `type`, `fn` | Code: keywords, strings, types, function names. |
| `ok`, `warn` | Success and caution text. |
| `flagInk` | Text on an agent's colour. |
| `avL` | A **number** from 0 to 1: the lightness of agents' colours. |
| `avC` | A **number** from 0 to 0.4: the chroma of agents' colours. |

Agents keep their hue in every theme; `avL` and `avC` set how light and how
vivid those colours are, so pick values that read well on your `bg` (an agent
colour is `oklch(avL avC hue)`).

## Rule packs

A rule pack is a set of rules a user can attach to an agent in its settings,
under "Rules from mods". It has two kinds of rules, which work differently:

- **Its edit area and protected paths** are enforced by the app, like the
  agent's own settings. They only narrow what the agent may do: the agent's
  settings, its own area and protected paths hold whatever a pack says.
- **Its instructions** are text the agent's model reads. The app gives them
  to the model as guidance from a third party, below the user's own
  instructions. They cannot change what the agent is allowed to do, but a
  model may still follow them within that. So the user should read a pack
  before attaching it, and the app shows all of it in the agent's settings.

```json
"rulePacks": [
  {
    "id": "docs-only",
    "label": "Docs only",
    "description": "Edits only in docs/. Edits in docs/legal/ ask you first.",
    "instructions": "You work on the documentation in docs/ only...",
    "editArea": "docs/**",
    "protect": ["docs/legal/**"]
  }
]
```

| Field | Required | What it does |
| --- | --- | --- |
| `label` | yes | Its name in the agent's settings, at most 60 characters. |
| `description` | no | What it does, in a sentence on one line: at most 300 characters. |
| `instructions` | no | Given to the agent's model as guidance from a third party (the mod), below the user's own instructions. |
| `editArea` | no | Where the agent may edit, as `.gitignore`-style patterns, one per line. The agent may edit only where its own area **and** every attached pack's area allow. |
| `protect` | no | A list of `.gitignore`-style patterns; every edit to a matching file asks the user first. |

Patterns work like `.gitignore`: `*` stays inside one folder, `**` crosses
folders, a trailing `/` means a folder, `!` excludes, and the last matching
line wins.

The user attaches a pack; a mod never does. What the pack says is copied into
the agent's settings when attached, so a new version of the mod cannot change
an agent's rules on its own: the agent's settings show that the pack changed,
and the user decides.

## Layouts

A layout is an arrangement of the window: a row of columns, each a stack of
views. The user applies one under Layout in Settings or from the command palette
("Layout: <label>"); the sidebar's side and zen mode stay as they are.

```json
"layouts": [
  {
    "id": "count-beside",
    "label": "Word count beside the editor",
    "columns": [
      { "id": "c1", "width": 440, "slots": [{ "view": "chat", "open": true, "height": "fill" }] },
      {
        "id": "c2",
        "width": "fill",
        "slots": [
          { "view": "editor", "open": true, "height": "fill" },
          { "view": "mod:example.word-count:count", "open": true, "height": 160 }
        ]
      }
    ]
  }
]
```

- `columns`: a non-empty list. Each column has an `id` (used once), a `width`
  in pixels or `"fill"`, and `slots`. Exactly one column has `"fill"`.
- `slots`: a non-empty list. Each slot has a `view`, whether it is `open`, and
  a `height` in pixels or `"fill"`. Exactly one slot per column has `"fill"`.
- `view`: `"chat"`, `"editor"`, `"shell"`, or a mod's view as
  `"mod:<mod id>:<view id>"` (of this mod or another). A view whose mod is
  not on keeps its place, empty, until it is.

## Commands and keys

```json
"commands": [{ "id": "count", "title": "Count words in this file", "key": "Ctrl+Alt+W" }]
```

- `title`: how it reads in the command palette, at most 60 characters. The
  palette always shows the mod's name beside it.
- `key` (optional): its default key, written like `"Ctrl+Alt+O"`, `"Ctrl+Shift+F5"`
  or `"Alt+Enter"`. `Ctrl` means Cmd on macOS. When a key is taken, the app's
  own commands win over a mod's.
- Its full id is `mod:<mod id>:<command id>`.

The manifest only names a command; the code gives it its function:

```js
host.commands.register("count", (arg) => { /* ... */ });
```

Until some part of the mod has registered it (the logic, usually, or an open
view), running it shows "<name>: <title> is not ready yet."

Keys pressed while one of the mod's views has the focus stay in that view: the
view is a separate page and the app does not see them. Click outside it to use
the app's keys again.

## Views

A view is a page of your mod shown in the window, like the chat or the editor.
The user shows it from the palette ("Layout: Show <title> (<mod name>)"), and
a layout can place it.

```json
"views": [{ "id": "count", "title": "Word count", "entry": "view.html", "minWidth": 200 }]
```

- `title`: its name in the window and the palette, at most 60 characters.
- `entry`: the HTML file to show, relative to the mod's folder.
- `minWidth` (optional): the narrowest it may be drawn, in pixels; 200 if left out.

**How a view runs.** Each view is drawn in a sandboxed frame. Its page may run
scripts, but it has no address of its own (an opaque origin), so it cannot
reach the app's page or other mods' pages, and by design it has no network.
Every file of the mod is served with this policy:

```
default-src 'none'; script-src <mod>; style-src <mod> 'unsafe-inline';
img-src <mod> data: blob:; font-src <mod> data:; media-src <mod>;
worker-src blob:; connect-src 'none'; frame-src 'none';
form-action 'none'; base-uri 'none'
```

where `<mod>` is the mod's own folder. In practice:

- **No inline scripts.** `<script>` tags with code inside, and attributes like
  `onclick="..."`, do not run. Put scripts in files of the mod:
  `<script src="panel.js"></script>`. Inline `<style>` and `style=""` are fine.
- **No network, by design.** `fetch`, `XMLHttpRequest`, `WebSocket`,
  `EventSource`, `sendBeacon` and the like are blocked by the policy above,
  even for the mod's own files, and images, styles, fonts and media load only
  from the mod's folder (or `data:`/`blob:` URLs). A content policy does not
  cover everything a page can ask of the webview: `<link rel="preconnect">`
  and `<link rel="dns-prefetch">` look up a name or open a connection without
  loading anything. The app turns those off in its webview, and sends the
  webview's own network through a proxy that refuses everything (development
  builds let the dev server through). "No network" holds with these in
  place; `test.escape` (below) is how to check it.
- No nested frames, no forms that submit, no pop-up windows, and no going to
  other addresses: a view can only show the pages of mods.
- **A view keeps the page it opened with.** Only that page is connected to
  the app. If the view goes to another page (a link, a form, `location`, a
  reload), that page gets no connection and the mod gets a failure. Change
  what the page shows with script instead.
- **Window messages are not from the app.** Other mods' frames can send
  messages to your page's window with `postMessage`. Ignore `message` events
  on `window`; talk to the app and to your logic only through `host`.

**What the app adds.** The app puts two tags at the top of every HTML file of
the mod: a stylesheet and a script. The script defines the global `host` (see
[The host API](#the-host-api)); the stylesheet gives calm defaults that match
the app:

- the theme's colours as CSS variables, kept up to date when the theme
  changes: each token's name in kebab case (`--bg`, `--fg`, `--accent`,
  `--accent-ink`, `--danger-fg`, ...), plus `--av-l` and `--av-c`;
- the app's font as `--mono` (Fira Code, regular and semibold);
- defaults for text, headings, links, buttons (add `class="primary"` for the
  accent button), fields, tables and scrollbars. They are written so that any
  rule of your own wins.

The page stays hidden until the theme has arrived (at most 1.5 seconds), so it
never flashes in other colours.

**Views reload.** Moving a view, closing and reopening it, or a restart of the
mod loads its page again from scratch. Keep state in the logic, or in
`host.storage`, and send it to the view when it shows: the logic hears
`host.views.onShown(view, shown)`, and the view can ask with
`host.logic.post(...)` as soon as it starts (posts made while the logic starts
are passed on once it runs).

**Keep views light.** On Linux every view runs on the same thread as the app's
own window. A view that loops or computes for long freezes the whole window,
and the app cannot interrupt it. Do heavy work in the logic, which has a
thread of its own and is stopped if it stops answering.

**Keys stay in the view.** Keys pressed while a view has the focus go to the
view, not to the app (see [Commands and keys](#commands-and-keys)).

**Errors.** An uncaught error or an unhandled promise rejection in a view
counts as a failure of the mod (see [Limits](#limits)). The page's own
scripts count as coming from elsewhere, so the app usually learns only
"Script error."; the developer tools of a development build show the details.

## The logic (`main`)

`main` is one script that runs while the mod is on, in a worker inside a
sandboxed frame:

- It has the global `host`, and what a worker has (`setTimeout`,
  `setInterval`, `TextEncoder`, `crypto.getRandomValues`, `structuredClone`,
  `console`...), but no page, no network (the same policy as views) and no
  way to the app other than `host`.
- The worker's own `postMessage` does not reach the app: it throws. The
  logic's page passes nothing on, and a message that reaches it anyway stops
  the logic.
- It is a plain script, not a module: no `import`. Write it as one file, or
  bundle several into one.
- It starts when the mod is turned on (or the app starts with it on), and
  stops when it is turned off, changes, or the user starts without mod code.
  "Reload" on a dev mod restarts it.
- Error messages count lines from the top of your file.

Keep what the mod knows in the logic: views come and go, the logic stays.

## The host API

Both the logic and the views use the global `host`. Its full description, with
types, is [`docs/host-api.d.ts`](host-api.d.ts); copy that file into your mod
for completion in your editor.

| Part | What it does |
| --- | --- |
| `host.mod`, `host.api`, `host.ready` | The mod's id and granted permissions; the API version; a promise that resolves once connected. |
| `host.commands.register(id, run)`, `.run(id, arg)` | Give a manifest command its function; run one of the mod's commands, or a built-in command the app marks as open to mods. |
| `host.views.post`, `.onMessage`, `.onShown` | Logic only: talk to the mod's views, and hear when one is shown or hidden. |
| `host.logic.post`, `.onMessage` | Views only: talk to the logic. |
| `host.notify(text)` | A short notice at the bottom of the window, shown as "Mod <name>: <text>". |
| `host.storage.get(key)`, `.set(key, value)` | Values kept across restarts. `set` resolves once the value is written (see [Limits](#limits)). |
| `host.theme.tokens()`, `.onChange(fn)` | The current theme's tokens, and when they change. |
| `host.workspace.name()`, `.onChange(fn)` | The open project's name, and when another is opened. |
| `host.files.list()`, `.read(path)`, `.active()`, `.onSaved(fn)` | Needs `files:read`. The project's files, a file's saved text, the file in the editor with the cursor's line, and saves. |
| `host.agents.list()`, `.onStatus(fn)` | Needs `agents:read`. Each agent's id, name, colour, status and current file. |

Rules for every call:

- Arguments and messages are plain JSON data (no functions, dates or class
  instances), at most 1 MB each.
- Calls return promises. A call is refused, with a readable reason, when the
  mod lacks the permission, the arguments are wrong or the app cannot do it.
- Listener functions (`onSaved`, `onStatus`, ...) return a function that stops
  them. A listener for something the mod has no permission for is never
  called, and the console says why.
- In a view, `host` exists at once, but it connects only after the page has
  loaded: calls made earlier wait and go out then, and `host.mod.granted` is
  filled in then. `await host.ready` when you need it.

A small logic, from `example.word-count`:

```js
host.commands.register("count", async () => {
  const active = await host.files.active();
  if (!active) return host.notify("No file is open.");
  const text = await host.files.read(active.path);
  const words = (text.match(/[\p{L}\p{N}_'’-]+/gu) || []).length;
  host.notify(`${active.path} has ${words} words.`);
});

host.files.onSaved((path) => { /* count again */ });
```

## Permissions and approval

| Permission | What it allows |
| --- | --- |
| `files:read` | List and read the files of the open project, and know which file is in the editor and the cursor's line. |
| `agents:read` | See each agent's name, colour, status and the file it is in. Not chats, settings or anything typed. |

Without any permission, a mod's code can still draw its views, run its own
commands, show notices, keep storage and read the theme and the project's name.

A mod starts **off**. When the user turns it on, the app shows what it asks
for, in the words above, and grants exactly that. A new version of an
installed mod is a change (below), so it stays off until approved again; the
approval lists what it now asks for and marks what is new. A dev mod that
asks for more keeps running with only what was approved, and the Mods page
offers to approve again.

Nothing in the API lets a mod answer an agent's permission request, change an
agent's settings, see API keys, type into the message box or send messages to
agents. These are not permissions a mod can ask for.

## Changes, hashes and dev mode

When the user turns on an installed mod, the app records a hash of all its
files. If any file changes afterwards, the mod is "changed since you approved
it" and stays off until the user approves it again, so what runs is always
what was approved. Files are also checked against their recorded hashes each
time they are served, so a file changed while the app runs is refused at
once. The approval says plainly that its files changed and
shows what it now asks for.

While you write a mod, use **Load a dev folder…** on the Mods page instead. The
app then uses your folder in place, without copying it, and does not check its
hash: edit your files, then press **Reload** on the mod to load the manifest
again and restart its code and views. You still turn it on, and grant its
permissions, like any other mod.

## Limits

| What | Limit |
| --- | --- |
| Storage | 1 MB per mod in all, as JSON; keys of 1 to 200 characters. Writes are gathered: each key keeps its latest value, and a mod's storage is written at most twice a second, ten keys at a time. `set` resolves once its value is written. At most 100 keys may wait to be written; a new key beyond them is refused until they are. |
| Message size | 1 MB of JSON for each call, answer or post. Larger answers (reading a large file, say) are refused with a reason. |
| Messages | 200 a second per mod, its logic and views together, with bursts of up to 200. More wait their turn, unread. |
| Data | 4 MB a second per mod, both ways together: what it sends, the answers it gets, and the posts passed between its logic and views. A call whose answer can be large (`files.read`, `files.list`, `storage.get`) counts as 1 MB until it is answered. More waits its turn, so read large files one after another rather than all at once. |
| Waiting | Up to 2000 messages may wait their turn. More are dropped unanswered, and the mod gets a failure. |
| Notices | One every 2 seconds, shown as "Mod <name>: <text>"; others are dropped. |
| Texts | `name` at most 40 characters and not the app's name; titles and labels at most 60; a rule pack's description at most 300. No characters that do not show or that reorder text (see [mod.json](#modjson)). |
| Watchdog | The app asks the logic every 5 seconds whether it is still running. With no answer within 5 seconds, the logic is stopped (a failure) and started again 3 seconds later; one that does not load within 15 seconds counts the same. A logic whose answer waits behind its own messages is still running. After three stops in ten minutes it stays stopped until it changes or is reloaded. |
| Failures | Uncaught errors and unhandled rejections in the logic or a view; messages that did not come from `host`, such as answers to checks the app did not make; too many messages waiting; a view that goes to another page; a frame whose page cannot send back its key; and a stopped logic. **Three failures in ten minutes turn the mod off**; the Mods page lists its recent errors. Several in the same second count once. |
| Folder | 2000 files, 2000 folders, 20 MB. |

If the app ends unexpectedly while mod code runs, its next start offers to
start without mod code that time. That includes a window frozen by a view
and then closed: the window tells the core every 2 seconds that it is alive,
and an exit more than 6 seconds after the last time counts as unexpected.
Starting the app with `--no-mods` turns all mod code off for the session.

## Installing

Open the Mods page (palette: "Mods: Open").

- **Install from folder…** copies a mod's folder into the app's own mods folder
  (in the app's data folder) after checking it. It starts off.
- **Load a dev folder…** uses a folder in place, for development (above).
- **Turn on…** shows what the mod adds and asks for, then turns it on.
- **Remove** deletes an installed mod's copy and its storage; for a dev mod,
  the app forgets it and leaves your folder alone.

Themes appear in the theme menu, rule packs in each agent's settings, layouts
in Settings (Layout) and the palette, commands in the palette, and views as "Layout:
Show <title> (<mod name>)".

## Security in plain words

A mod's code is treated as untrusted, however well meant.

- **It runs walled off.** The logic runs in a worker, and each view in a
  frame, with no address of their own. They cannot touch the app's page, its
  storage or other mods' pages, and by design they have no network: their
  files are served with a policy that allows nothing but the mod's own files,
  the webview's DNS prefetching and preconnects (which such a policy does not
  cover) are off, the webview's own network goes through a proxy that refuses
  everything, and the window refuses to go to any address that is not the app
  or a mod's file. The app's own commands answer only the app's page.
- **It reaches the app only through `host`.** Each frame gets one private
  channel to the app, handed only to the first page loaded in that frame and
  trusted only once that page sends back a one-time key the app put in its
  address, so a page that takes another's place gets nothing. The app checks
  every message on it: its size, how many came that second and how much data,
  whether the mod has the permission, and the arguments; over the limits,
  messages wait unread. Messages sent any other way are ignored.
- **It sees only what the user granted.** Two permissions exist, both read
  only, both shown in plain words before the mod is turned on. A changed mod
  needs approval again.
- **It cannot act for the user.** No mod can answer permission requests,
  change an agent, read keys, type into the message box or message agents.
  Rule packs cannot widen what an agent may do, and only the user attaches
  them.
- **It cannot pass for the app.** Its name cannot be the app's, its notices
  start with "Mod <name>:", its commands show its name in the palette, and
  texts with hidden or reordering characters are refused.
- **It is watched.** A logic that stops answering is stopped; a mod that keeps
  failing is turned off; a session that crashed or froze with mods running
  can start without them.

What the sandbox does **not** protect against:

- A mod with `files:read` can read every file in the open project, secrets
  such as `.env` included. Grant it only to mods you trust.
- A rule pack's instructions reach the agent's model. They cannot widen what
  the agent may do, but they can steer it within that. Read a pack before
  attaching it.
- A view runs on the app's own thread (on Linux). A view that hangs freezes
  the window until it is closed or the app restarts; starting without mod code
  then helps.
- A view can show anything inside its own frame, including text that looks
  like part of the app. Keys pressed while it has the focus go to it: a view
  that looks like the message box would read what is typed into it.
- Frames of other mods can send messages to a view's window. A mod that
  listens to window messages instead of using only `host` can be fooled.
- These protections have been checked on Linux (WebKitGTK) only. Windows and
  macOS use other webviews, where parts of them work differently or are not
  in place yet; mods must not ship there before the same checks pass.

For checking the sandbox after a change to the app or its webview, install
`examples/mods/test.escape` as a dev mod, turn it on and show its view
("Layout: Show Escape tests (Escape tests)"). Every line should read
"blocked" (or "reachable" for the one message handler the webview always
offers, which the core ignores without its key); any "LEAKED" is a bug.
Lines marked "manual" (preconnect, DNS prefetch and `sendBeacon`) cannot be seen from
inside a page: watch the network while the tests run, as the line says. The
buttons under "By hand" try the escapes that would leave the page if they
worked, and the limits that turn the mod off when they hold.

The checks live in `src/mods/runtime/` (`protocol.ts`, `session.ts`) and in
`src-tauri/src/mods/` (`scheme.rs`, `navigation.rs`, `webview.rs`).
