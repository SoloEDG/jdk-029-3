import type { CalibrationPulse } from './types'

export interface CalibrationSignal {
  buffer: AudioBuffer
  pulses: CalibrationPulse[]
  /** 静音前导秒数，给播放/采集启动留余量 */
  leadIn: number
}

/**
 * 生成校准测试音：多个带静音间隔的短脉冲。
 * 间隔足够长（约 0.9s），使墙面反射在下一脉冲之前衰减，
 * 多次抵达在回录里表现为“多峰”，可逐个比对而不重叠。
 */
export function buildCalibrationSignal(context: BaseAudioContext, pulseCount = 4): CalibrationSignal {
  const rate = context.sampleRate
  const leadIn = 0.4
  const pulseDuration = 0.12
  const gap = 0.9
  const tail = 0.8
  const total = leadIn + pulseCount * pulseDuration + (pulseCount - 1) * gap + tail
  const buffer = context.createBuffer(1, Math.ceil(total * rate), rate)
  const data = buffer.getChannelData(0)
  const pulses: CalibrationPulse[] = []
  for (let p = 0; p < pulseCount; p++) {
    const start = leadIn + p * (pulseDuration + gap)
    const startSample = Math.round(start * rate)
    // 相邻脉冲换频，降低谐波与共振造成的误相关
    const frequency = 660 + p * 110
    const fade = Math.min(0.008, pulseDuration / 4)
    const fadeSamples = Math.round(fade * rate)
    for (let i = 0; i < pulseDuration * rate; i++) {
      const envelope = i < fadeSamples ? i / fadeSamples
        : i > pulseDuration * rate - fadeSamples ? (pulseDuration * rate - i) / fadeSamples
        : 1
      data[startSample + i] = 0.9 * envelope * Math.sin(2 * Math.PI * frequency * (i / rate))
    }
    pulses.push({ time: start, duration: pulseDuration, frequency })
  }
  return { buffer, pulses, leadIn }
}
