import { useRef, useState } from 'react'
import { FLACDecoder } from '@wasm-audio-decoders/flac'
import { invoke } from '@tauri-apps/api/core'
import { SERVER_ORIGIN as SERVER_URL } from './config/serverHost'

// Phase 3 of THE SPIKE (see projects/Legato.md): does the "server decodes
// any source -> PCM -> FLAC, client decodes via WASM and schedules gapless
// playback via Web Audio" pipeline actually hold together end to end?
// Explicitly NOT using <audio> element chaining or decodeAudioData — both
// were rejected in the design doc (the former can't be gapless, the latter
// behaves differently per-webview).

// The Abbey Road medley: three tracks mastered to flow into each other with
// zero silence at the boundary. If this pipeline introduces even a few
// milliseconds of gap or a click, it's audible immediately on real ears —
// a much sharper test than measuring scheduled-time deltas alone.
const MEDLEY_TRACKS = [
  '11. Mean Mr. Mustard.flac',
  '12. Polythene Pam.flac',
  "13. She Came In Through The Bathroom Window.flac",
]

type TrackStatus = {
  name: string
  state: 'idle' | 'fetching' | 'decoding' | 'scheduled' | 'error'
  bytes?: number
  samplesDecoded?: number
  sampleRate?: number
  duration?: number
  scheduledAt?: number
  error?: string
}

export default function PlaybackSpike() {
  const [tracks, setTracks] = useState<TrackStatus[]>(
    MEDLEY_TRACKS.map((name) => ({ name, state: 'idle' })),
  )
  const [log, setLog] = useState<string[]>([])
  const audioCtxRef = useRef<AudioContext | null>(null)

  const appendLog = (line: string) =>
    setLog((prev) => [...prev, `[${performance.now().toFixed(1)}ms] ${line}`])

  const updateTrack = (i: number, patch: Partial<TrackStatus>) =>
    setTracks((prev) => prev.map((t, idx) => (idx === i ? { ...t, ...patch } : t)))

  // Isolates whether Web Audio output works in this webview at all,
  // independent of fetch/decode/scheduling — a plain oscillator, started
  // immediately (not scheduled ahead), with the clock polled to see
  // whether it's actually advancing or silently stalled.
  const testTone = async () => {
    setLog([])
    const ctx = audioCtxRef.current ?? new AudioContext()
    audioCtxRef.current = ctx
    appendLog(`ctx.state before resume = ${ctx.state}`)
    await ctx.resume()
    appendLog(`ctx.state after resume = ${ctx.state}, sampleRate=${ctx.sampleRate}`)

    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    gain.gain.value = 0.2
    osc.frequency.value = 440
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.start()
    appendLog(`oscillator started at ctx.currentTime=${ctx.currentTime.toFixed(3)}`)

    const t0 = performance.now()
    const poll = setInterval(() => {
      appendLog(
        `+${(performance.now() - t0).toFixed(0)}ms wall: ctx.currentTime=${ctx.currentTime.toFixed(3)}, state=${ctx.state}`,
      )
    }, 300)

    setTimeout(() => {
      clearInterval(poll)
      osc.stop()
      appendLog('oscillator stopped')
    }, 2000)
  }

  // Phase 4: native decode + gapless playback via rodio/cpal in the Rust
  // backend, reading the same medley straight off disk — no webview Web
  // Audio involved at all, to check whether that sidesteps the WebKitGTK +
  // Bluetooth issue found in the WASM-decoder-in-webview path above.
  const playNative = async () => {
    setLog([])
    appendLog('invoking play_native_gapless_spike (rodio/cpal, reads /mnt/music directly)')
    try {
      await invoke('play_native_gapless_spike')
      appendLog('native playback started — check system audio, this UI has no visibility into it')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      appendLog(`ERROR invoking native playback: ${message}`)
    }
  }

  const playGapless = async () => {
    setLog([])
    const ctx = audioCtxRef.current ?? new AudioContext()
    audioCtxRef.current = ctx
    await ctx.resume()

    appendLog(`AudioContext sampleRate=${ctx.sampleRate}`)

    // Small lead-in so the first buffer's scheduled start isn't already in
    // the past by the time playback begins.
    let nextStartTime = ctx.currentTime + 0.25
    let cumulativeDuration = 0

    for (let i = 0; i < MEDLEY_TRACKS.length; i++) {
      const name = MEDLEY_TRACKS[i]
      try {
        updateTrack(i, { state: 'fetching' })
        appendLog(`fetching ${name}`)
        const res = await fetch(`${SERVER_URL}/stream/${encodeURIComponent(name)}`)
        if (!res.ok) throw new Error(`server returned ${res.status}`)
        const bytes = new Uint8Array(await res.arrayBuffer())
        updateTrack(i, { bytes: bytes.byteLength, state: 'decoding' })
        appendLog(`fetched ${name} (${bytes.byteLength} bytes), decoding`)

        const decoder = new FLACDecoder()
        await decoder.ready
        const { channelData, samplesDecoded, sampleRate, errors } =
          await decoder.decodeFile(bytes)

        if (errors.length > 0) {
          appendLog(`${name}: ${errors.length} decode error(s): ${errors[0].message}`)
        }

        const buffer = ctx.createBuffer(channelData.length, samplesDecoded, sampleRate)
        for (let ch = 0; ch < channelData.length; ch++) {
          // Copy out of the WASM heap before free()'ing the decoder — also
          // sidesteps the Float32Array<ArrayBufferLike> vs <ArrayBuffer> type gap.
          buffer.copyToChannel(Float32Array.from(channelData[ch]), ch)
        }
        decoder.free()

        const source = ctx.createBufferSource()
        source.buffer = buffer
        source.connect(ctx.destination)
        source.start(nextStartTime)

        appendLog(
          `${name}: decoded ${samplesDecoded} samples @ ${sampleRate}Hz ` +
            `(${buffer.duration.toFixed(3)}s) — scheduled start=${nextStartTime.toFixed(3)}, ` +
            `boundary continues previous end exactly (no gap inserted)`,
        )

        updateTrack(i, {
          state: 'scheduled',
          samplesDecoded,
          sampleRate,
          duration: buffer.duration,
          scheduledAt: nextStartTime,
        })

        nextStartTime += buffer.duration
        cumulativeDuration += buffer.duration
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        updateTrack(i, { state: 'error', error: message })
        appendLog(`${name}: ERROR ${message}`)
        return
      }
    }

    appendLog(
      `all tracks scheduled — total programme length ${cumulativeDuration.toFixed(3)}s, ` +
        `final end time ${nextStartTime.toFixed(3)}`,
    )
  }

  const stop = () => {
    audioCtxRef.current?.close()
    audioCtxRef.current = null
    setTracks(MEDLEY_TRACKS.map((name) => ({ name, state: 'idle' })))
  }

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#111',
        color: '#fff',
        fontFamily: 'monospace',
        fontSize: 13,
        padding: 24,
        overflow: 'auto',
      }}
    >
      <h2 style={{ marginTop: 0 }}>THE SPIKE — gapless server-decoded playback</h2>
      <p style={{ opacity: 0.7, maxWidth: 700 }}>
        Server (ffmpeg, {SERVER_URL}) decodes each source file to PCM and re-encodes to FLAC on
        the fly; client decodes that FLAC via a WASM decoder (@wasm-audio-decoders/flac) and
        schedules each buffer to start exactly when the previous one ends, via the Web Audio API.
        No &lt;audio&gt; element, no decodeAudioData.
      </p>

      <div style={{ display: 'flex', gap: 8, margin: '16px 0' }}>
        <button onClick={playGapless} style={{ padding: '8px 16px' }}>
          Play medley gapless (tracks 11-13)
        </button>
        <button onClick={testTone} style={{ padding: '8px 16px' }}>
          Test tone (440Hz, 2s)
        </button>
        <button onClick={playNative} style={{ padding: '8px 16px', background: '#8f6' }}>
          Native gapless (rodio, tracks 11-13)
        </button>
        <button onClick={stop} style={{ padding: '8px 16px' }}>
          Stop / reset
        </button>
      </div>

      <table style={{ borderCollapse: 'collapse', width: '100%', maxWidth: 900 }}>
        <thead>
          <tr style={{ textAlign: 'left', opacity: 0.6 }}>
            <th style={{ padding: 4 }}>track</th>
            <th style={{ padding: 4 }}>state</th>
            <th style={{ padding: 4 }}>bytes</th>
            <th style={{ padding: 4 }}>samples @ rate</th>
            <th style={{ padding: 4 }}>duration</th>
            <th style={{ padding: 4 }}>scheduled at</th>
          </tr>
        </thead>
        <tbody>
          {tracks.map((t) => (
            <tr key={t.name} style={{ borderTop: '1px solid #333' }}>
              <td style={{ padding: 4 }}>{t.name}</td>
              <td style={{ padding: 4, color: t.state === 'error' ? '#f66' : undefined }}>
                {t.state}
                {t.error ? `: ${t.error}` : ''}
              </td>
              <td style={{ padding: 4 }}>{t.bytes ?? ''}</td>
              <td style={{ padding: 4 }}>
                {t.samplesDecoded ? `${t.samplesDecoded} @ ${t.sampleRate}Hz` : ''}
              </td>
              <td style={{ padding: 4 }}>{t.duration ? `${t.duration.toFixed(3)}s` : ''}</td>
              <td style={{ padding: 4 }}>{t.scheduledAt ? t.scheduledAt.toFixed(3) : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>log</h3>
      <div
        style={{
          background: 'rgba(255,255,255,0.05)',
          padding: 12,
          borderRadius: 4,
          maxHeight: 300,
          overflow: 'auto',
          whiteSpace: 'pre-wrap',
        }}
      >
        {log.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
      </div>
    </div>
  )
}
