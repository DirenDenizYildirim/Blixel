// Icons for the Mods page, drawn like the ones in components/icons.tsx.

interface IconProps {
  size?: number;
  color?: string;
}

const svg = (size: number, color: string, width: number, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={width}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: "none" }}
  >
    {children}
  </svg>
);

export const CheckIcon = ({ size = 13, color = "currentColor" }: IconProps) => svg(size, color, 2.6, <path d="M5 12.5l4.5 4.5L19 7.5" />);

export const NoIcon = ({ size = 13, color = "currentColor" }: IconProps) => svg(size, color, 2.6, <path d="M7 7l10 10M17 7L7 17" />);

/** An arrow into a tray, for installing a folder. */
export const InstallIcon = ({ size = 15, color = "currentColor" }: IconProps) =>
  svg(size, color, 2.4, <path d="M12 4v10M7.5 9.5L12 14l4.5-4.5M5 16v2.5A1.5 1.5 0 006.5 20h11a1.5 1.5 0 001.5-1.5V16" />);

/** Brackets, for a mod loaded from its author's folder. */
export const DevIcon = ({ size = 15, color = "currentColor" }: IconProps) => svg(size, color, 2.4, <path d="M9 7l-5 5 5 5M15 7l5 5-5 5" />);

export const ChevronIcon = ({ size = 12, color = "currentColor", open = false }: IconProps & { open?: boolean }) =>
  svg(size, color, 2.4, <path d={open ? "M6 15l6-6 6 6" : "M6 9l6 6 6-6"} />);
