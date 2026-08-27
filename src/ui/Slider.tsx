/* v2's slider — settings/nodes/size, settings/links/distance+thickness,
 * settings/forces/center+repel+link. See DESIGN.md "Controls" -> "v2:
 * settings primitives". The numeric readout is Rubik/--color-control, not
 * mono/ink: it's a live control value, not library data — see DESIGN.md
 * "The one rule (v2)".
 *
 * WebKitGTK is the app's one rendering engine (see CLAUDE.md), so the
 * ::-webkit-* pseudo-elements below are the only ones this needs. */

type SliderProps = {
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  step?: number
  disabled?: boolean
  label?: string
  className?: string
}

export function Slider({
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
  disabled,
  label,
  className = '',
}: SliderProps) {
  return (
    <div className={`flex flex-1 items-center gap-[var(--spacing-xs)] ${className}`}>
      <input
        type="range"
        role="slider"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="h-[10px] flex-1 appearance-none bg-transparent disabled:pointer-events-none disabled:opacity-40
          [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--color-control)]
          [&::-webkit-slider-thumb]:mt-[-3.5px] [&::-webkit-slider-thumb]:size-[10px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-control)]"
      />
      <span className="shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
        {value.toFixed(2)}
      </span>
    </div>
  )
}
