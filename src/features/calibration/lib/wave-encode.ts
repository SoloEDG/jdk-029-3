/** 单声道 Float32 PCM 编码为 16bit WAV Blob，供试听 */
export function encodeWave(samples: Float32Array, rate: number): Blob {
  const length = samples.length
  const buffer = new ArrayBuffer(44 + length * 2)
  const view = new DataView(buffer)
  const mark = (offset: number, tag: string) => {
    for (const [index, value] of Array.from(tag).entries()) view.setUint8(offset + index, value.charCodeAt(0))
  }
  mark(0, 'RIFF')
  view.setUint32(4, buffer.byteLength - 8, true)
  mark(8, 'WAVE')
  mark(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  mark(36, 'data')
  view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i++) {
    view.setInt16(44 + 2 * i, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true)
  }
  return new Blob([buffer], { type: 'audio/wav' })
}
