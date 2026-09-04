interface ToggleProps {
  label: string;
  checked: boolean;
  disabled?: boolean;
  hint?: string;
  onChange: (v: boolean) => void;
}

export function Toggle({ label, checked, disabled, hint, onChange }: ToggleProps) {
  return (
    <label className={`toggle${disabled ? ' is-disabled' : ''}`} title={hint}>
      <span className="toggle-label">{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-switch" aria-hidden />
    </label>
  );
}
