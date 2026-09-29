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
    // min-w-0 on both the row and the input is issue #86's fix: a range
    // input has an intrinsic width (~129px in WebKit) and, as a flex item,
    // a default min-width of auto, so it refused to shrink below that. In
    // the Music Map's per-type size rows (label column + per-type label +
    // this) that pushed the readout past the panel edge at the 300px panel
    // width, where overflow-x-hidden cut it off entirely. The track is the
    // part that can give; the readout keeps shrink-0.
    <div className={`flex min-w-0 flex-1 items-center gap-[var(--spacing-xs)] ${className}`}>
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
        className="h-[10px] min-w-0 flex-1 appearance-none bg-transparent disabled:pointer-events-none disabled:opacity-40
          [&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-full [&::-webkit-slider-runnable-track]:bg-[var(--color-control)]
          [&::-webkit-slider-thumb]:mt-[-3.5px] [&::-webkit-slider-thumb]:size-[10px] [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-control)]"
      />
      <span className="shrink-0 text-[length:var(--text-sm)] text-[color:var(--color-control)]">
        {value.toFixed(2)}
      </span>
    </div>
  )
}
