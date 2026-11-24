import type { CalibrationPulse, CandidateVerdict, LatencyCandidate } from './types'

/** 可接受的最大端到端延迟（输出缓冲 + 声学路径 + 输入缓冲） */
export const MAX_LATENCY_MS = 600
/** 两次抵达低于该间隔（毫秒）时无法区分谁是第一声 */
export const AMBIGUOUS_GAP_MS = 25
/** 跨脉冲聚类的时间容差 */
const CLUSTER_TOLERANCE_MS = 8
/** 弱直达声相对最强峰低于该比例仍可被选为第一声（弱直达 / 强反射场景） */
const DIRECT_MIN_RATIO = 0.4
/** NCC 延迟网格步长 */
const HOP_MS = 2
/** 峰选最小间距（毫秒），小于歧义间隔，使 25ms 内的两次抵达能各自成峰 */
const PEAK_MIN_GAP_MS = 10
/** 低于最强 NCC 峰该比例的扫描点不参与峰选 */
const SCORE_FLOOR_RATIO = 0.45
/** 仅取脉冲起始段做模板：包含淡入非周期部分，抑制长正弦模板的周期旁瓣假峰 */
const TEMPLATE_MS = 30

interface Onset { latencyMs: number; strength: number; onsetSample: number; pulseIndex: number }
interface Cluster { latencyMs: number; stdMs: number; strength: number; count: number; onsetSample: number }

function rms(samples: Float32Array, from: number, to: number): number {
  let sum = 0
  for (let i = from; i < to; i++) sum += samples[i] * samples[i]
  return Math.sqrt(sum / Math.max(1, to - from))
}

/** 归一化互相关；返回 -1..1，能量过低时返回 0 */
function ncc(x: Float32Array, offset: number, template: Float32Array): number {
  const n = template.length
  if (offset < 0 || offset + n > x.length) return 0
  let mx = 0
  let mt = 0
  for (let i = 0; i < n; i++) { mx += x[offset + i]; mt += template[i] }
  mx /= n; mt /= n
  let num = 0
  let vx = 0
  let vt = 0
  for (let i = 0; i < n; i++) {
    const dx = x[offset + i] - mx
    const dt = template[i] - mt
    num += dx * dt
    vx += dx * dx
    vt += dt * dt
  }
  const den = Math.sqrt(vx * vt)
  return den < 1e-9 ? 0 : num / den
}

function templateFor(reference: Float32Array, pulse: CalibrationPulse, rate: number): Float32Array {
  const from = Math.round(pulse.time * rate)
  const to = Math.min(
    Math.round((pulse.time + pulse.duration) * rate),
    from + Math.round(TEMPLATE_MS / 1000 * rate),
  )
  return reference.slice(from, to)
}

/**
 * 单脉冲多抵达检测：在延迟网格上逐点做归一化互相关，再取局部极大值。
 * NCC 对同频波形敏感，弱直达 / 强反射和近距双峰都能各自成峰，
 * 不依赖能量包络过门（包络在短间隔抵达下会合并成一个峰）。
 */
function detectOnsets(
  recording: Float32Array,
  reference: Float32Array,
  pulse: CalibrationPulse,
  pulseIndex: number,
  rate: number,
  noiseFloor: number,
): Onset[] {
  const hop = Math.max(1, Math.round(rate * HOP_MS / 1000))
  const searchFrom = Math.round(pulse.time * rate)
  const searchTo = Math.min(recording.length, Math.round((pulse.time + MAX_LATENCY_MS / 1000) * rate))
  if (searchTo <= searchFrom) return []
  // 能量门控：该脉冲的搜索窗内没有明显高于底噪的能量时直接判为缺失，
  // 避免纯噪声段的随机 NCC 峰在跨脉冲聚类里凑数（线路中断场景）
  const windowRms = rms(recording, searchFrom, searchTo)
  if (windowRms < noiseFloor * 2.5) return []
  const template = templateFor(reference, pulse, rate)
  const scores: { index: number; offset: number; score: number }[] = []
  let index = 0
  for (let offset = searchFrom; offset + template.length <= searchTo; offset += hop, index++) {
    const score = ncc(recording, offset, template)
    if (score > 0) scores.push({ index, offset, score })
  }
  if (!scores.length) return []
  const strongest = Math.max(...scores.map(s => s.score))
  const floor = strongest * SCORE_FLOOR_RATIO
  const minGap = Math.round(PEAK_MIN_GAP_MS / HOP_MS)
  const peaks: { index: number; offset: number; score: number }[] = []
  for (let k = 1; k < scores.length - 1; k++) {
    const current = scores[k]
    if (current.score < floor) continue
    if (current.score <= scores[k - 1].score || current.score < scores[k + 1].score) continue
    const last = peaks[peaks.length - 1]
    if (last && current.index - last.index < minGap) {
      if (current.score > last.score) peaks[peaks.length - 1] = current
      continue
    }
    peaks.push(current)
  }
  // 亚跳精度细化：在峰附近 ±1 跳内逐样本重算 NCC
  const refine = hop
  return peaks.map(peak => {
    let bestOffset = peak.offset
    let best = peak.score
    for (let lag = -refine; lag <= refine; lag++) {
      const score = ncc(recording, peak.offset + lag, template)
      if (score > best) { best = score; bestOffset = peak.offset + lag }
    }
    return {
      latencyMs: (bestOffset - searchFrom) / rate * 1000,
      strength: Math.max(0, best),
      onsetSample: bestOffset,
      pulseIndex,
    }
  })
}

function cluster(onsets: Onset[], rate: number): Cluster[] {
  const sorted = [...onsets].sort((a, b) => a.latencyMs - b.latencyMs)
  const clusters: Cluster[] = []
  for (const onset of sorted) {
    const nearby = clusters.find(c => Math.abs(c.latencyMs - onset.latencyMs) <= CLUSTER_TOLERANCE_MS)
    if (!nearby) {
      clusters.push({ latencyMs: onset.latencyMs, stdMs: 0, strength: onset.strength, count: 1, onsetSample: onset.onsetSample })
      continue
    }
    const prevMean = nearby.latencyMs
    const values = [...Array(nearby.count)].map(() => prevMean)
    values.push(onset.latencyMs)
    const mean = values.reduce((a, b) => a + b, 0) / values.length
    const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length
    nearby.latencyMs = (nearby.latencyMs * nearby.count + onset.latencyMs) / (nearby.count + 1)
    nearby.stdMs = Math.sqrt(variance)
    nearby.strength = (nearby.strength * nearby.count + onset.strength) / (nearby.count + 1)
    nearby.count += 1
    nearby.onsetSample = Math.round(nearby.latencyMs / 1000 * rate)
  }
  return clusters
}

/**
 * 分析一次校准回录。
 * 纯函数：输入参考音、回录与脉冲表，输出可信候选与判定结论。
 */
export function analyzeCalibration(
  recording: Float32Array,
  reference: Float32Array,
  pulses: CalibrationPulse[],
  rate: number,
): CandidateVerdict {
  const quietTo = Math.max(1, Math.round((pulses[0].time - 0.15) * rate))
  const noiseFloor = rms(recording, 0, Math.min(quietTo, recording.length))
  const signalRms = rms(recording, Math.round(pulses[0].time * rate), Math.min(recording.length, Math.round((pulses.at(-1)!.time + 0.3) * rate)))
  if (signalRms < noiseFloor * 2 || signalRms < 0.01) {
    return { status: 'failed', reason: '回录电平过低或环境噪声占主导，未检测到测试音。', candidates: [] }
  }
  const perPulse = pulses.map((pulse, index) => detectOnsets(recording, reference, pulse, index, rate, noiseFloor))
  const hitPulses = perPulse.filter(onsets => onsets.length > 0).length
  // 4 脉冲至少 3 次重复：单个脉冲的相关旁瓣无法跨脉冲聚类，避免假峰被当成抵达
  const minReps = Math.max(2, Math.round(pulses.length * 0.75))
  if (hitPulses < minReps) {
    return {
      status: 'failed',
      reason: `线路测试中断：${pulses.length} 个测试脉冲中仅捕获到 ${hitPulses} 个，无法交叉确认，请重新测试。`,
      candidates: [],
    }
  }
  const clusters = cluster(perPulse.flat(), rate).filter(c => c.count >= minReps)
  if (!clusters.length) {
    return { status: 'failed', reason: '各脉冲的抵达时间无法重复对齐，疑似采集中断或设备异常。', candidates: [] }
  }
  const strongest = Math.max(...clusters.map(c => c.strength))
  const candidates: LatencyCandidate[] = clusters
    .filter(c => c.strength >= DIRECT_MIN_RATIO * strongest)
    .sort((a, b) => a.latencyMs - b.latencyMs)
    .map((c, index, list) => ({
      latencyMs: Math.round(c.latencyMs * 10) / 10,
      strength: Math.round(c.strength * 1000) / 1000,
      kind: index === 0 ? 'direct' : (c.latencyMs - list[0].latencyMs < AMBIGUOUS_GAP_MS ? 'ambiguous' : 'reflection'),
      marginDb: Math.round(20 * Math.log10(c.strength / strongest) * 10) / 10,
      onsetSample: c.onsetSample,
    }))
  const first = clusters[0]
  const second = clusters[1]
  const nearTie = second && second.latencyMs - first.latencyMs < AMBIGUOUS_GAP_MS
  const inconsistent = first.stdMs > CLUSTER_TOLERANCE_MS * 1.5
  if (nearTie || inconsistent) {
    const reason = nearTie
      ? `两次抵达仅相差 ${Math.round(second!.latencyMs - first.latencyMs)}ms（< ${AMBIGUOUS_GAP_MS}ms），无法区分第一声，已保留上次确认值，请人工判定。`
      : `最早抵达在各脉冲间偏差 ${first.stdMs.toFixed(1)}ms，重复性不足，已保留上次确认值，请重新判定。`
    return { status: 'ambiguous', reason, candidates }
  }
  const chosen = candidates[0]
  const reflectionNote = candidates.length > 1
    ? `最早抵达强度为最强峰的 ${Math.round(chosen.strength / strongest * 100)}%（${chosen.marginDb}dB），判定为较弱的扬声器直达声；其后 ${candidates
      .slice(1).map(c => `${Math.round(c.latencyMs - chosen.latencyMs)}ms 处的更强峰为墙面反射`).join('，')}。`
    : '仅出现一组稳定抵达，无明显反射峰。'
  return {
    status: 'confident',
    chosen,
    reason: `第一声在 ${hitPulses}/${pulses.length} 个脉冲重复出现（组内偏差 ${first.stdMs.toFixed(1)}ms）。${reflectionNote}`,
    candidates,
  }
}

/** 用户手动标第一声时，把标注样本换算成延迟候选 */
export function manualCandidate(onsetSample: number, pulse: CalibrationPulse, rate: number): LatencyCandidate {
  return {
    latencyMs: Math.round((onsetSample / rate - pulse.time) * 1000 * 10) / 10,
    strength: 1,
    kind: 'direct',
    marginDb: 0,
    onsetSample,
  }
}
