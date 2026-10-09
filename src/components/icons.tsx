// Icons drawn exactly as in the design files.

interface IconProps {
  size?: number;
  color?: string;
  width?: number;
}

const svg = (size: number, color: string, width: number, children: React.ReactNode, join = false) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin={join ? "round" : undefined}
    aria-hidden="true"
    style={{ flex: "none" }}
  >
    {children}
  </svg>
);

const ACCENT = "var(--accent)";

export const MenuIcon = ({ size = 18, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.4, <path d="M4 6h16M4 12h16M4 18h16" />);

export const SearchIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.4, <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M20 20l-4.5-4.5" /></>);

export const PlusIcon = ({ size = 15, color = ACCENT, width = 2.4 }: IconProps) =>
  svg(size, color, width, <path d="M12 5v14M5 12h14" />);

export const AgentsIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.2, (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6" />
      <path d="M16 4.6a3.5 3.5 0 010 6.8M18 14.3c2 .8 3.5 2.6 3.5 5.7" />
    </>
  ));

export const FolderIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.2, <path d="M3 6.5A1.5 1.5 0 014.5 5H9l2 2.5h8.5A1.5 1.5 0 0121 9v8.5a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 17.5z" />, true);

export const ChevronDown = ({ size = 12, color = "var(--muted)", width = 2.4 }: IconProps) =>
  svg(size, color, width, <path d="M6 9l6 6 6-6" />, true);

export const ChevronRight = ({ size = 12, color = "var(--muted)" }: IconProps) =>
  svg(size, color, 2.4, <path d="M9 6l6 6-6 6" />, true);

export const TasksIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.2, <><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M8.5 12.5l2.5 2.5 4.5-5.5" /></>, true);

export const TerminalIcon = ({ size = 15, color = ACCENT, width = 2.2 }: IconProps) =>
  svg(size, color, width, <path d="M5 8l4 4-4 4M12 16h7" />, true);

export const ThemeIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.2, (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <circle cx="9" cy="9.5" r="1" />
      <circle cx="14.5" cy="9" r="1" />
      <circle cx="15.5" cy="14" r="1" />
    </>
  ));

/** A puzzle piece, for the mods. */
export const ModsIcon = ({ size = 15, color = ACCENT }: IconProps) =>
  svg(size, color, 2.2, (
    <path d="M3.5 9v10a1.5 1.5 0 001.5 1.5h10a1.5 1.5 0 001.5-1.5v-3.2a2.5 2.5 0 100-3.6V9A1.5 1.5 0 0015 7.5h-3.2a2.5 2.5 0 10-3.6 0H5A1.5 1.5 0 003.5 9z" />
  ), true);

export const SettingsIcon = ({ size = 18, color = "currentColor" }: IconProps) =>
  svg(size, color, 2, (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ));

export const SendIcon = ({ size = 16, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.6, <path d="M12 19V5M6 11l6-6 6 6" />, true);

export const CloseIcon = ({ size = 12, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.4, <path d="M6 6l12 12M18 6L6 18" />);

export const OpenIcon = ({ size = 14, color = "var(--muted)" }: IconProps) =>
  svg(size, color, 2.2, <path d="M14 4h6v6M20 4l-9 9M18 14v4.5a1.5 1.5 0 01-1.5 1.5h-11A1.5 1.5 0 014 18.5v-11A1.5 1.5 0 015.5 6H10" />, true);

export const ChatIcon = ({ size = 14, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.2, <path d="M5 5h14a1.5 1.5 0 011.5 1.5v9a1.5 1.5 0 01-1.5 1.5H10l-4.5 3.5V17H5a1.5 1.5 0 01-1.5-1.5v-9A1.5 1.5 0 015 5z" />, true);

export const CodeIcon = ({ size = 14, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.2, <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />, true);

export const StopIcon = ({ size = 14, color = "currentColor" }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
    <rect x="6" y="6" width="12" height="12" rx="2" fill={color} />
  </svg>
);
