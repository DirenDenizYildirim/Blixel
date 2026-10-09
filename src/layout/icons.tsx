// Icons for the layout's menus, drawn like the ones in components/icons.tsx.

const svg = (size: number, color: string, children: React.ReactNode) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke={color}
    strokeWidth={2.2}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    style={{ flex: "none" }}
  >
    {children}
  </svg>
);

/** The "⋯" of a view's menu. */
export const MoreIcon = ({ size = 14, color = "currentColor" }: { size?: number; color?: string }) =>
  svg(size, color, (
    <>
      <circle cx="5" cy="12" r="1.7" fill={color} stroke="none" />
      <circle cx="12" cy="12" r="1.7" fill={color} stroke="none" />
      <circle cx="19" cy="12" r="1.7" fill={color} stroke="none" />
    </>
  ));
