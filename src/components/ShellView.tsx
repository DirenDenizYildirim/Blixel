import { FitAddon } from "@xterm/addon-fit";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef } from "react";
import { useStore } from "../model/store";
import { token } from "../theme/theme";

function terminalTheme(): ITheme {
  const t = (name: string) => token(name);
  return {
    background: t("side"),
    foreground: t("fg"),
    cursor: t("side"),
    selectionBackground: t("sel"),
    black: t("accent-ink"),
    red: t("accent"),
    green: t("ok"),
    yellow: t("warn"),
    blue: t("fn"),
    magenta: t("kw"),
    cyan: t("type"),
    white: t("strong"),
    brightBlack: t("muted"),
    brightRed: t("danger-fg"),
    brightGreen: t("ok"),
    brightYellow: t("warn"),
    brightBlue: t("fn"),
    brightMagenta: t("kw"),
    brightCyan: t("type"),
    brightWhite: t("strong"),
  };
}

/** One agent's shell. Output is read-only: the agent runs commands, the user watches. */
export function ShellView({ agentId }: { agentId: string }) {
  const host = useRef<HTMLDivElement>(null);
  const term = useRef<Terminal | null>(null);
  const written = useRef({ agentId: "", total: 0 });
  const data = useStore((s) => s.shells[agentId]?.data ?? "");
  const total = useStore((s) => s.shells[agentId]?.total ?? 0);
  const theme = useStore((s) => s.theme);

  useEffect(() => {
    const t = new Terminal({
      fontFamily: "'Fira Code', ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.6,
      disableStdin: true,
      drawBoldTextInBrightColors: false,
      cursorBlink: false,
      scrollback: 5000,
      theme: terminalTheme(),
    });
    const fit = new FitAddon();
    t.loadAddon(fit);
    t.open(host.current!);
    t.write("\x1b[?25l");
    term.current = t;
    const resize = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // The panel can be zero-sized while hidden.
      }
    });
    resize.observe(host.current!);
    return () => {
      resize.disconnect();
      t.dispose();
      term.current = null;
      written.current = { agentId: "", total: 0 };
    };
  }, []);

  useEffect(() => {
    if (term.current) term.current.options.theme = terminalTheme();
  }, [theme]);

  // Write only what is new; switching agents, or falling behind what the store
  // still keeps, redraws the kept output.
  useEffect(() => {
    const t = term.current;
    if (!t) return;
    const w = written.current;
    const fresh = total - w.total;
    if (w.agentId !== agentId || fresh < 0 || fresh > data.length) {
      t.reset();
      t.write("\x1b[?25l" + data);
    } else if (fresh > 0) {
      t.write(data.slice(data.length - fresh));
    }
    written.current = { agentId, total };
  }, [agentId, data, total]);

  return <div ref={host} className="shell-host" />;
}
