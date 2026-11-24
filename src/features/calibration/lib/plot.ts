import type { LatencyCandidate } from './types'

export interface CalibrationPlot {
  recording: Float32Array
  rate: number
  pulses: { time: number; duration: number }[]
  candidates: LatencyCandidate[]
  /** 自动选中的延迟毫秒 */
  chosenLatencyMs: number | null
  /** 人工标注的延迟毫秒 */
  manualLatencyMs: number | null
  /** 参考脉冲在回录时间轴上的理论位置（t=0 即延迟 0） */
  referencePulseTimes: number[]
}

const CANDIDATE_COLORS: Record<LatencyCandidate['kind'], string> = {
  direct: '#85cbd5',
  reflection: '#ec9fa9',
  ambiguous: '#e5bd70',
}

export function drawCalibrationWave(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  plot: CalibrationPlot,
  onPick?: (recordingTime: number) => void,
) {
  const ratio = window.devicePixelRatio || 1
  canvas.width = Math.round(width * ratio)
  canvas.height = Math.round(height * ratio)
  const context = canvas.getContext('2d')
  if (!context) return
  context.scale(ratio, ratio)
  const left = 34
  const right = width - 12
  const top = 12
  const bottom = height - 22
  const duration = plot.recording.length / plot.rate
  const x = (time: number) => left + (time / duration) * (right - left)
  const mid = (top + bottom) / 2

  context.strokeStyle = '#343a30'
  context.lineWidth = 1
  context.beginPath()
  context.moveTo(left, mid)
  context.lineTo(right, mid)
  context.stroke()

  // 降采样绘制波形，避免每样本画路径
  const bins = Math.max(60, right - left)
  const binSize = plot.recording.length / bins
  context.strokeStyle = '#7d8a72'
  context.lineWidth = 1
  context.beginPath()
  for (let bin = 0; bin < bins; bin++) {
    const from = Math.floor(bin * binSize)
    const to = Math.max(from + 1, Math.floor((bin + 1) * binSize))
    let peak = 0
    for (let i = from; i < to && i < plot.recording.length; i++) {
      const v = Math.abs(plot.recording[i])
      if (v > peak) peak = v
    }
    const px = x(((bin + 0.5) * binSize) / plot.rate)
    const amp = peak * (bottom - top) * 0.48
    context.moveTo(px, mid - amp)
    context.lineTo(px, mid + amp)
  }
  context.stroke()

  // 参考音理论位置（白色虚线）
  context.strokeStyle = '#f6eddb'
  context.setLineDash([4, 4])
  for (const time of plot.referencePulseTimes) {
    const px = x(time)
    context.beginPath()
    context.moveTo(px, top)
    context.lineTo(px, bottom)
    context.stroke()
  }
  context.setLineDash([])

  // 候选峰
  context.font = '10px "IBM Plex Mono", monospace'
  for (const candidate of plot.candidates) {
    const time = plot.pulses[0].time + candidate.latencyMs / 1000
    const px = x(time)
    context.strokeStyle = CANDIDATE_COLORS[candidate.kind]
    context.lineWidth = candidate.latencyMs === plot.chosenLatencyMs ? 2.4 : 1.4
    context.beginPath()
    context.moveTo(px, top)
    context.lineTo(px, bottom)
    context.stroke()
    context.fillStyle = CANDIDATE_COLORS[candidate.kind]
    context.fillText(`${Math.round(candidate.latencyMs)}ms`, px + 3, top + 10)
  }

  // 人工标注（绿色实线 + 顶部三角）
  if (plot.manualLatencyMs != null) {
    const px = x(plot.pulses[0].time + plot.manualLatencyMs / 1000)
    context.strokeStyle = '#b8dc9d'
    context.lineWidth = 2
    context.beginPath()
    context.moveTo(px, top)
    context.lineTo(px, bottom)
    context.stroke()
    context.fillStyle = '#b8dc9d'
    context.beginPath()
    context.moveTo(px, top)
    context.lineTo(px - 5, top - 7)
    context.lineTo(px + 5, top - 7)
    context.closePath()
    context.fill()
    context.fillText(`手动 ${Math.round(plot.manualLatencyMs)}ms`, px + 3, bottom - 4)
  }

  if (onPick) {
    canvas.onclick = event => {
      const rect = canvas.getBoundingClientRect()
      const px = event.clientX - rect.left
      if (px < left || px > right) return
      const time = ((px - left) / (right - left)) * duration
      onPick(time)
    }
    canvas.style.cursor = 'crosshair'
  } else {
    canvas.onclick = null
    canvas.style.cursor = 'default'
  }
}
