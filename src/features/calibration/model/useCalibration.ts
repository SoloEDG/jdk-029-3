import { computed, onBeforeUnmount, ref, shallowRef } from 'vue'
import type {
  CalibrationInfo, CalibrationRecord, CalibrationStatus, CandidateVerdict, DeviceSignature,
} from '../lib/types'
import { analyzeCalibration, manualCandidate } from '../lib/detect'
import { alignTime } from '../lib/align'
import { findRestorableSignature, identifyDevices, sameDevice, UNKNOWN } from '../lib/devices'
import { CalibrationAborted, startLoopback, type LoopbackHandle } from '../lib/loopback'
import { buildCalibrationSignal } from '../lib/signal'
import { readCalibrations, writeCalibration } from '../lib/storage'
import { encodeWave } from '../lib/wave-encode'

export interface TestSession {
  recording: Float32Array
  reference: Float32Array
  pulses: CalibrationRecord['pulses']
  rate: number
  verdict: CandidateVerdict
  device: DeviceSignature
  /** 人工在波形上标出的延迟毫秒；null 表示尚未标注 */
  manualLatencyMs: number | null
  audioUrl: string
}

const outputStorageKey = 'night-session.output-device'

export function useCalibration() {
  const phase = ref<'idle' | 'testing' | 'review'>('idle')
  const issue = ref('')
  const level = ref(0)
  const records = shallowRef<CalibrationRecord[]>([])
  const currentSignature = shallowRef<DeviceSignature | null>(null)
  const session = shallowRef<TestSession | null>(null)
  const reverify = shallowRef<Record<string, CandidateVerdict>>({})
  const outputDevices = shallowRef<MediaDeviceInfo[]>([])
  const chosenOutputId = ref(localStorage.getItem(outputStorageKey) ?? '')
  /** 本次会话内通过测试确认的最新校准 id，用于区分“恢复值”与“新测值” */
  const lastTestedId = ref<string | null>(null)
  const player = new Audio()
  let handle: LoopbackHandle | null = null

  const current = computed<CalibrationRecord | null>(() => {
    const signature = currentSignature.value
    if (!signature) return null
    return records.value
      .filter(r => sameDevice(r.device, signature))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  })

  const status = computed<CalibrationStatus>(() => {
    const record = current.value
    if (record) {
      if (record.device.outputId === UNKNOWN) return { kind: 'unknown-output', label: '输出未知，待确认' }
      // 签名是通过设备切回重新匹配到的（而非本次会话刚测出来），标记为恢复值
      const restored = !session.value && record.id !== lastTestedId.value
      return {
        kind: 'calibrated',
        label: '已校准',
        latencyMs: record.latencyMs,
        source: restored ? 'restored' : record.source,
      }
    }
    if (records.value.length) return { kind: 'stale', label: '设备已变更，需重新校准' }
    return { kind: 'none', label: '未校准' }
  })

  /** 模糊判定时保留的上次确认值（同设备组合） */
  const retained = computed<CalibrationRecord | null>(() => {
    const signature = session.value?.device
    if (!signature) return null
    return records.value
      .filter(r => sameDevice(r.device, signature))
      .sort((a, b) => b.createdAt - a.createdAt)[0] ?? null
  })

  /**
   * 设备热插拔 / 切换后重新匹配：
   * - 当前组合仍在 -> 保留校准；
   * - 切到别的组合 -> 当前签名置空，状态显示“设备已变更”；
   * - 切回原组合（含 default 设备 ID 漂移）-> 自动恢复对应历史校准。
   */
  async function refreshDevices() {
    if (!navigator.mediaDevices?.enumerateDevices) return
    const devices = await navigator.mediaDevices.enumerateDevices()
    outputDevices.value = devices.filter(d => d.kind === 'audiooutput')
    const inputIds = new Set(devices.filter(d => d.kind === 'audioinput').map(d => d.deviceId))
    const outputIds = new Set(devices.filter(d => d.kind === 'audiooutput').map(d => d.deviceId))
    currentSignature.value = findRestorableSignature(
      records.value.map(r => r.device), inputIds, outputIds, currentSignature.value,
    )
  }

  async function runTest() {
    if (phase.value === 'testing') return
    issue.value = ''
    phase.value = 'testing'
    level.value = 0
    try {
      const outputId = chosenOutputId.value || undefined
      handle = startLoopback(context => buildCalibrationSignal(context), outputId, value => { level.value = value })
      const result = await handle.promise
      const device = await identifyDevices(result.context, result.stream, outputId)
      const { signal } = result
      const verdict = analyzeCalibration(result.recording, signal.buffer.getChannelData(0), signal.pulses, result.rate)
      session.value = {
        recording: result.recording,
        reference: signal.buffer.getChannelData(0).slice(),
        pulses: signal.pulses,
        rate: result.rate,
        verdict,
        device,
        manualLatencyMs: null,
        audioUrl: URL.createObjectURL(encodeWave(result.recording, result.rate)),
      }
      currentSignature.value = device
      phase.value = 'review'
    } catch (error) {
      if (error instanceof CalibrationAborted) {
        issue.value = error.reason === 'device'
          ? '采集设备在测试中断开，线路测试未完成，请重新测试。'
          : '线路测试已中断，未产生校准值，请重新测试。'
      } else if (error instanceof DOMException && error.name === 'NotAllowedError') {
        issue.value = '麦克风权限未开启，无法进行校准。'
      } else {
        issue.value = '校准测试失败，请检查麦克风与扬声器后重试。'
      }
      phase.value = 'idle'
    } finally {
      handle = null
      level.value = 0
    }
  }

  function abortTest() { handle?.abort() }

  function discardSession() {
    if (session.value) URL.revokeObjectURL(session.value.audioUrl)
    session.value = null
    phase.value = 'idle'
    issue.value = ''
  }

  /** 反复试听：从指定录音时间播放一个短片段，用 timeupdate 精确截停 */
  function audition(fromTime?: number, duration = 0.9) {
    const active = session.value
    if (!active) return
    const start = Math.max(0, fromTime ?? active.pulses[0].time - 0.25)
    const stopAt = start + duration
    player.ontimeupdate = () => { if (player.currentTime >= stopAt) stopAudition() }
    player.src = active.audioUrl
    player.currentTime = start
    void player.play().catch(() => { stopAudition(); issue.value = '试听播放失败。' })
  }

  /** 围绕某个候选抵达时间前后试听，便于人工核对“第一声” */
  function auditionCandidate(latencyMs: number) {
    const active = session.value
    if (!active) return
    const arrival = active.pulses[0].time + latencyMs / 1000
    audition(Math.max(0, arrival - 0.12), 0.5)
  }

  function stopAudition() {
    player.pause()
    player.ontimeupdate = null
  }

  /** 在波形图上手动标出第一声：recordingTime 为回录时间轴上的点击位置（秒） */
  function markManual(recordingTime: number) {
    const active = session.value
    if (!active) return
    const pulse = active.pulses[0]
    const candidate = manualCandidate(Math.round(recordingTime * active.rate), pulse, active.rate)
    // shallowRef 需整体替换才能触发面板与波形重绘
    session.value = { ...active, manualLatencyMs: candidate.latencyMs }
  }

  /** 输出路径无法识别时，由用户人工确认输出条件 */
  function confirmOutputPath(outputId: string, label: string) {
    const active = session.value
    if (!active) return
    const device = { ...active.device, outputId, outputLabel: label }
    session.value = { ...active, device }
    currentSignature.value = device
    if (outputId !== UNKNOWN) {
      chosenOutputId.value = outputId === 'default' ? '' : outputId
      localStorage.setItem(outputStorageKey, chosenOutputId.value)
    }
  }

  async function persist(source: 'auto' | 'manual', latencyMs: number, reason: string, verdict: CandidateVerdict) {
    const active = session.value
    if (!active) return
    if (active.device.outputId === UNKNOWN) {
      issue.value = '输出路径无法识别，请先确认输出设备后再保存校准值。'
      return
    }
    const record: CalibrationRecord = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      device: active.device,
      latencyMs: Math.round(latencyMs * 10) / 10,
      source,
      reason,
      candidates: verdict.candidates,
      pulses: active.pulses,
      sampleRate: active.rate,
      duration: active.recording.length / active.rate,
      waveform: Array.from(active.recording),
      reference: Array.from(active.reference),
    }
    await writeCalibration(record)
    records.value = [record, ...records.value.filter(r => r.id !== record.id)]
    currentSignature.value = record.device
    lastTestedId.value = record.id
    discardSession()
  }

  async function confirmAuto() {
    const active = session.value
    if (!active || active.verdict.status !== 'confident') return
    await persist('auto', active.verdict.chosen.latencyMs, active.verdict.reason, active.verdict)
  }

  async function confirmManual() {
    const active = session.value
    if (!active || active.manualLatencyMs == null) return
    const reason = `人工在回录波形上标注第一声，手动确认延迟 ${active.manualLatencyMs}ms。`
    await persist('manual', active.manualLatencyMs, reason, active.verdict)
  }

  /** 用保存的原始回录重新跑一遍分析，验证历史校准值是否仍然成立 */
  function reVerify(record: CalibrationRecord): CandidateVerdict {
    const verdict = analyzeCalibration(
      Float32Array.from(record.waveform),
      Float32Array.from(record.reference),
      record.pulses,
      record.sampleRate,
    )
    reverify.value = { ...reverify.value, [record.id]: verdict }
    return verdict
  }

  /** 录音保存时附带的校准解释；未校准则返回 null，旧录音据此按未校准解释 */
  function infoForCapture(): CalibrationInfo | null {
    const record = current.value
    const signature = currentSignature.value
    if (!record || !signature) return null
    const restored = !session.value && record.id !== lastTestedId.value
    return {
      latencyMs: record.latencyMs,
      device: record.device,
      calibrationId: record.id,
      calibrated: record.device.outputId !== UNKNOWN,
      source: restored ? 'restored' : record.source,
    }
  }

  async function load() {
    try {
      const stored = await readCalibrations()
      records.value = stored.sort((a, b) => b.createdAt - a.createdAt)
    } catch {
      issue.value = '无法读取本机校准记录。'
      records.value = []
    }
    await refreshDevices()
    if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshDevices)
  }

  onBeforeUnmount(() => {
    handle?.abort()
    player.pause()
    if (navigator.mediaDevices) navigator.mediaDevices.removeEventListener('devicechange', refreshDevices)
    if (session.value) URL.revokeObjectURL(session.value.audioUrl)
  })

  return {
    phase, issue, level, records, current, currentSignature, status, retained, session, reverify,
    outputDevices, chosenOutputId,
    load, runTest, abortTest, discardSession, audition, auditionCandidate, stopAudition, markManual,
    confirmOutputPath, confirmAuto, confirmManual, reVerify, infoForCapture, alignTime, refreshDevices,
  }
}