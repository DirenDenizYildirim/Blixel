# Blixel kit

Everything made so far for Blixel, the agent workspace app, in one folder.
Drop this folder into the root of your repo so the coding agent can read it.

## What is inside

| Path | What it is |
|---|---|
| `prompt/project-brief.md` | Everything the coding agent needs to know about the project: the idea, concepts, features, look, decisions and constraints. It has no build instructions; those are yours to give. It already points at the files below. |
| `designs/screenshots/` | Pictures of the approved screens: main screen, create-agent page, and the main screen in six themes. |
| `designs/preview-html/` | The same screens as ordinary web pages. Open them in any browser. They are still pictures of one moment: buttons and animations do not respond. |
| `designs/themes.json` | Every colour token for the six themes (Slate, Paper, Forest, Midnight, Copper, Terminal). |
| `designs/canvas-source/` | The original design canvas files. They only run inside the Claude design canvas, so use them as a backup, not for viewing. |
| `avatar-lab/avatar-lab.html` | The avatar generator. Open it in a browser: it is fully working, and its script is the code to port into the app. |

## Notes

- The web pages load the Fira Code font from Google Fonts, so they need an
  internet connection to look right. Offline they fall back to another
  monospace font.
- Slate is the default theme and the one the main screen and create-agent
  page are drawn in.
- Agent names, the sample project and the code shown in the designs are
  placeholder content.
