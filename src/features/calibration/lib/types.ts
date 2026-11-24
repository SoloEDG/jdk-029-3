/** 延迟校准领域类型 */
export type { CalibrationInfo } from '../../../shared/document'
import type { CalibrationInfo } from '../../../shared/document'

/** 一次测试音里单个脉冲的描述 */
export interface CalibrationPulse {
  /** 脉冲在测试音缓冲中的起始秒（相对于 context.currentTime 基准） */
  time: number
  /** 脉冲持续秒 */
  duration: number
  /** 频率 Hz */
  frequency: number
}

/** 可识别的输入 / 输出条件；任何字段为空字符串表示该条件无法识别（未知） */
export interface DeviceSignature {
  inputId: string
  inputLabel: string
  outputId: string
  outputLabel: string
  /** AudioContext 采样率，属于可识别条件的一部分 */
  sampleRate: number
}

/** 一次回录分析出的候选偏移（录音时间轴相对参考时间轴的延迟，秒） */
export interface LatencyCandidate {
  /** 候选延迟秒数（正数：听到的声音晚于参考音） */
  latencyMs: number
  /** 归一化相关强度 0..1 */
  strength: number
  kind: 'direct' | 'reflection' | 'ambiguous'
  /** 相对最强峰的强度差 dB（最强峰为 0） */
  marginDb: number
  /** 在回录波形中的抵达样本 */
  onsetSample: number
}

export type CandidateVerdict =
  | { status: 'confident'; chosen: LatencyCandidate; reason: string; candidates: LatencyCandidate[] }
  | { status: 'ambiguous'; candidates: LatencyCandidate[]; reason: string }
  | { status: 'failed'; reason: string; candidates: LatencyCandidate[] }

/** 一次完整校准测试的记录（原始回录可重新验证） */
export interface CalibrationRecord {
  id: string
  createdAt: number
  device: DeviceSignature
  /** 最终确认的延迟毫秒 */
  latencyMs: number
  /** 确认方式 */
  source: 'auto' | 'manual'
  /** 自动判定依据或人工判定说明 */
  reason: string
  /** 分析时的全部候选 */
  candidates: LatencyCandidate[]
  /** 测试音脉冲描述 */
  pulses: CalibrationPulse[]
  /** 回录采样率 */
  sampleRate: number
  /** 回录时长秒 */
  duration: number
  /** 回录原始 PCM（单声道，Float32） */
  waveform: number[]
  /** 测试音原始 PCM（单声道，Float32），用于重新验证 */
  reference: number[]
}

export type CalibrationStatus =
  | { kind: 'none'; label: '未校准' }
  | { kind: 'unknown-output'; label: '输出未知，待确认' }
  | { kind: 'calibrated'; label: '已校准'; latencyMs: number; source: 'auto' | 'manual' | 'restored' }
  | { kind: 'stale'; label: '设备已变更，需重新校准' }
