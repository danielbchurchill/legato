import qrcode from 'qrcode-generator'

// The four-module margin the QR spec asks for; scanners find the code's
// edges by it.
const QUIET_ZONE = 4

/** One SVG path for every dark module, in module units. */
export function qrPath(value: string): { path: string; size: number } {
  // Error correction M: the default most generators use, and plenty for a
  // code read off a screen rather than a scuffed sticker.
  const qr = qrcode(0, 'M')
  qr.addData(value)
  qr.make()
  const count = qr.getModuleCount()
  let path = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`
    }
  }
  return { path, size: count + QUIET_ZONE * 2 }
}
