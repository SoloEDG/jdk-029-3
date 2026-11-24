import type { DeviceSignature } from './types'

export const UNKNOWN = 'unknown'

export function unknownSignature(sampleRate: number): DeviceSignature {
  return { inputId: UNKNOWN, inputLabel: '未知输入', outputId: UNKNOWN, outputLabel: '未知输出', sampleRate }
}

/** 枚举媒体设备；未授权时标签为空，此时按“未知”处理并要求用户确认 */
export async function enumerateAudioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] }
  const devices = await navigator.mediaDevices.enumerateDevices()
  return {
    inputs: devices.filter(d => d.kind === 'audioinput'),
    outputs: devices.filter(d => d.kind === 'audiooutput'),
  }
}

/**
 * 识别当前输入 / 输出条件。
 * 输出路径在浏览器里通常无法与具体播放设备对应（AudioContext 没有 sinkId 查询），
 * 此时 outputId 明确为 unknown，由 UI 请用户确认。
 */
export async function identifyDevices(
  context: BaseAudioContext,
  stream: MediaStream,
  chosenOutputId?: string,
): Promise<DeviceSignature> {
  const { inputs, outputs } = await enumerateAudioDevices()
  const track = stream.getAudioTracks()[0]
  const trackSettings = track?.getSettings()
  const inputId = trackSettings?.deviceId || inputs.find(d => d.label)?.deviceId || UNKNOWN
  const input = inputs.find(d => d.deviceId === inputId)
  const outputId = chosenOutputId || UNKNOWN
  const output = outputs.find(d => d.deviceId === outputId)
  return {
    inputId,
    inputLabel: input?.label || '未知输入',
    outputId,
    outputLabel: output?.label || '未知输出（浏览器无法识别当前输出路径）',
    sampleRate: context.sampleRate,
  }
}

export function sameDevice(a: DeviceSignature | null, b: DeviceSignature | null): boolean {
  if (!a || !b) return false
  return a.inputId === b.inputId && a.outputId === b.outputId && a.sampleRate === b.sampleRate
}

export function deviceLabel(device: DeviceSignature): string {
  const input = device.inputId === UNKNOWN ? '未知输入' : device.inputLabel
  const output = device.outputId === UNKNOWN ? '未知输出' : device.outputLabel
  return `${input} → ${output}（${device.sampleRate} Hz）`
}

/** 某签名对应的输入 / 输出设备当前是否在线（未知与 default 视为可恢复） */
export function isSignatureAvailable(
  signature: DeviceSignature,
  inputIds: ReadonlySet<string>,
  outputIds: ReadonlySet<string>,
): boolean {
  return (signature.inputId === UNKNOWN || inputIds.has(signature.inputId))
    && (signature.outputId === UNKNOWN || signature.outputId === 'default' || outputIds.has(signature.outputId))
}

/**
 * 设备热插拔 / 切换后的恢复匹配（stored 按最近使用倒序传入）：
 * 1. 优先在历史里找与当前签名不同、但设备在线的组合 —— 对应“切回原组合”；
 * 2. 当前签名本身仍在线则保留；
 * 3. 都不在场返回 null，调用方显示“需重新校准”。
 */
export function findRestorableSignature(
  stored: DeviceSignature[],
  inputIds: ReadonlySet<string>,
  outputIds: ReadonlySet<string>,
  previous: DeviceSignature | null,
): DeviceSignature | null {
  const switchedBack = stored.find(signature =>
    isSignatureAvailable(signature, inputIds, outputIds)
    && (!previous || !sameDevice(signature, previous)))
  if (switchedBack) return switchedBack
  if (previous && isSignatureAvailable(previous, inputIds, outputIds)) return previous
  return null
}
