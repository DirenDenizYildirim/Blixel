// Small shared controls: segmented buttons and switches, as drawn in the designs.

export function Segmented<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div role="group" aria-label={props.label} className="seg">
      {props.options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === props.value}
          disabled={props.disabled || o.disabled}
          onClick={() => props.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Switch(props: { label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return (
    <div className="switch-row">
      <button
        type="button"
        role="switch"
        aria-checked={props.checked}
        aria-label={props.label}
        disabled={props.disabled}
        className="switch"
        onClick={() => props.onChange(!props.checked)}
      >
        <span />
      </button>
      <span>{props.label}</span>
    </div>
  );
}

export function StatusLabel({ status }: { status: string }) {
  const text = status === "waiting" ? "needs you" : status;
  return (
    <span className="status" data-status={status}>
      <span className="status-text">{text}</span>
      <i />
    </span>
  );
}
