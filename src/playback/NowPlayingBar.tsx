import type { PlaybackStatus } from './usePlayback'

function formatMs(ms: number): string {
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export default function NowPlayingBar({
  status,
  title,
  onPause,
  onResume,
  onStop,
  onSkip,
}: {
  status: PlaybackStatus
  title: string | null
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onSkip: () => void
}) {
  if (!title) return null

  return (
    <div
      style={{
        position: 'fixed',
        left: 0,
        right: 340, // clears the article panel width when open
        bottom: 0,
        background: 'rgba(0,0,0,0.85)',
        borderTop: '1px solid #333',
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: 13,
        padding: '8px 16px',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        zIndex: 20,
      }}
    >
      <span>{title}</span>
      <span style={{ opacity: 0.6 }}>{formatMs(status.positionMs)}</span>
      <div style={{ flex: 1 }} />
      <button onClick={status.playing ? onPause : onResume} style={{ fontFamily: 'monospace' }}>
        {status.playing ? 'pause' : 'play'}
      </button>
      <button onClick={onSkip} style={{ fontFamily: 'monospace' }}>
        skip
      </button>
      <button onClick={onStop} style={{ fontFamily: 'monospace' }}>
        stop
      </button>
    </div>
  )
}
