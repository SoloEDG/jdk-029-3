import assert from 'node:assert/strict'
import { test } from 'node:test'
import { analyzeCalibration, manualCandidate, MAX_LATENCY_MS, AMBIGUOUS_GAP_MS } from '../src/features/calibration/lib/detect.ts'
import { buildCalibrationSignal } from '../src/features/calibration/lib/signal.ts'
import { alignTime } from '../src/features/calibration/lib/align.ts'
import { sameDevice, deviceLabel, UNKNOWN } from '../src/features/calibration/lib/devices.ts'
import type { CalibrationPulse } from '../src/features/calibration/lib/types.ts'

const RATE = 48000
const PULSES = 4

/** 最小假 AudioContext，仅满足信号生成所需 */
const fakeContext = {
  sampleRate: RATE,
  createBuffer(channels: number, length: number, rate: number) {
    const data = new Float32Array(length)
    return {
      numberOfChannels: channels, length, sampleRate: rate,
      getChannelData: () => data,
    }
  },
} as unknown as BaseAudioContext

const signal = buildCalibrationSignal(fakeContext, PULSES)
const reference = signal.buffer.getChannelData(0)
const pulses: CalibrationPulse[] = signal.pulses

interface Arrival { latencyMs: number; gain: number }

/** 按给定抵达序列合成回录：每个脉冲叠加多条衰减路径 + 背景噪声 */
function synthRecording(arrivalsFor: (pulseIndex: number) => Arrival[], options: { noise?: number; truncateAfterPulse?: number; maxLatencyOverride?: boolean } = {}) {
  const total = reference.length + Math.round(MAX_LATENCY_MS / 1000 * RATE)
  const recording = new Float32Array(total)
  const noise = options.noise ?? 0.003
  for (let i = 0; i < recording.length; i++) recording[i] = (Math.random() - 0.5) * 2 * noise
  pulses.forEach((pulse, pulseIndex) => {
    if (options.truncateAfterPulse !== undefined && pulseIndex >= options.truncateAfterPulse) return
    const arrivals = arrivalsFor(pulseIndex)
    const from = Math.round(pulse.time * RATE)
    const to = Math.round((pulse.time + pulse.duration) * RATE)
    for (const arrival of arrivals) {
      const shift = Math.round(arrival.latencyMs / 1000 * RATE)
      for (let i = from; i < to && i + shift < recording.length; i++) {
        recording[i + shift] += reference[i] * arrival.gain
      }
    }
  })
  return recording
}

test('单一稳定抵达时自动给出可信候选并说明依据', () => {
  const recording = synthRecording(() => [{ latencyMs: 142, gain: 0.8 }])
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'confident')
  if (verdict.status !== 'confident') return
  assert.ok(Math.abs(verdict.chosen.latencyMs - 142) <= 8, `期望约 142ms，实际 ${verdict.chosen.latencyMs}`)
  assert.equal(verdict.chosen.kind, 'direct')
  assert.match(verdict.reason, /第一声/)
  assert.ok(verdict.candidates.length >= 1)
})

test('弱直达声 + 更强墙面反射时仍选最早抵达，并解释选择依据', () => {
  const recording = synthRecording(() => [
    { latencyMs: 96, gain: 0.42 },
    { latencyMs: 168, gain: 1.0 },
  ])
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'confident')
  if (verdict.status !== 'confident') return
  assert.ok(Math.abs(verdict.chosen.latencyMs - 96) <= 8, `应选弱直达 ~96ms，实际 ${verdict.chosen.latencyMs}`)
  const reflection = verdict.candidates.find(c => c.kind === 'reflection')
  assert.ok(reflection, '必须把更响的晚到峰标记为反射峰')
  assert.ok(reflection!.latencyMs > verdict.chosen.latencyMs)
  assert.match(verdict.reason, /反射/)
})

test('两次抵达间隔过近无法区分时保留歧义并要求重新判定', () => {
  const gap = AMBIGUOUS_GAP_MS - 5
  const recording = synthRecording(() => [
    { latencyMs: 120, gain: 0.9 },
    { latencyMs: 120 + gap, gain: 0.95 },
  ])
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'ambiguous')
  if (verdict.status !== 'ambiguous') return
  assert.match(verdict.reason, /无法区分/)
  assert.ok(verdict.candidates.length >= 1, '歧义时仍要展示候选供人工判断')
})

test('线路测试中断（仅捕获部分脉冲）时失败并要求重新测试', () => {
  const recording = synthRecording(() => [{ latencyMs: 130, gain: 0.8 }], { truncateAfterPulse: 2 })
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'failed')
  assert.match(verdict.reason, /中断/)
})

test('回录电平过低时明确失败而不是给错误偏移', () => {
  const recording = synthRecording(() => [{ latencyMs: 130, gain: 0.004 }], { noise: 0.002 })
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'failed')
  assert.match(verdict.reason, /电平/)
})

test('人工标注换算出的候选与试听/曲线偏移一致', () => {
  const recording = synthRecording(() => [{ latencyMs: 150, gain: 0.8 }])
  const markedSample = Math.round((pulses[0].time + 0.15) * RATE)
  const candidate = manualCandidate(markedSample, pulses[0], RATE)
  // 手动标注的样本量化到单样本（48kHz ≈ 0.02ms），误差只来自脉冲时间取整
  assert.ok(Math.abs(candidate.latencyMs - 150) < 5)
  const info = {
    latencyMs: candidate.latencyMs,
    device: { inputId: 'mic-1', inputLabel: 'M', outputId: 'spk-1', outputLabel: 'S', sampleRate: RATE },
    calibrationId: 'c1', calibrated: true, source: 'manual' as const,
  }
  // 歌曲时间轴 2.0s 的声音按 150ms 回拨后应落在 1.85s
  assert.ok(Math.abs(alignTime(2.0, info) - 1.85) < 1e-9)
  // 未校准（旧录音）保持零偏移解释
  assert.equal(alignTime(2.0, null), 2.0)
  // 分析器对同一回录仍可独立复核
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.ok(verdict.status === 'confident' && Math.abs(verdict.chosen.latencyMs - 150) <= 8)
})

test('设备切回原组合时签名匹配恢复，输出未知时明确标注', () => {
  const original = { inputId: 'mic-1', inputLabel: '麦克风', outputId: 'spk-1', outputLabel: '扬声器', sampleRate: RATE }
  const restored = { ...original }
  assert.ok(sameDevice(original, restored))
  assert.equal(sameDevice(original, { ...original, sampleRate: 44100 }), false)
  assert.equal(sameDevice(original, { ...original, outputId: UNKNOWN }), false)
  const unknown = { inputId: UNKNOWN, inputLabel: '未知输入', outputId: UNKNOWN, outputLabel: '未知输出', sampleRate: RATE }
  assert.match(deviceLabel(unknown), /未知输出/)
})

test('多脉冲抵达聚类对小幅抖动稳健，且只接受可重复的峰', () => {
  const jitter = [0, 2, -2, 1]
  const recording = synthRecording(pulseIndex => [
    { latencyMs: 110 + jitter[pulseIndex], gain: 0.75 },
    { latencyMs: 205 + jitter[pulseIndex], gain: 0.55 },
  ])
  const verdict = analyzeCalibration(recording, reference, pulses, RATE)
  assert.equal(verdict.status, 'confident')
  if (verdict.status !== 'confident') return
  assert.ok(Math.abs(verdict.chosen.latencyMs - 110) <= 8)
  assert.ok(verdict.candidates.some(c => Math.abs(c.latencyMs - 205) <= 10))
})
