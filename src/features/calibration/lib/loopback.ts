import type { PcmFrame } from '../../../shared/document'
import processorUrl from './capture-processor.js?url&no-inline'
import type { CalibrationSignal } from './signal'

export interface LoopbackResult {
  /** 单声道回录；样本时间轴 t=0 对齐测试音播放起点 */
  recording: Float32Array
  rate: number
  stream: MediaStream
  context: AudioContext
  signal: CalibrationSignal
}

export class CalibrationAborted extends Error {
  constructor(public reason: 'user' | 'device') {
    super(reason === 'user' ? '校准测试已中断。' : '采集设备在测试中断开。')
    this.name = 'CalibrationAborted'
  }
}

export interface LoopbackHandle {
  promise: Promise<LoopbackResult>
  abort: () => void
}

/** 同步播放校准测试音并通过麦克风回录；测试音与回录共用同一 AudioContext 时钟 */
export function startLoopback(
  buildSignal: (context: BaseAudioContext) => CalibrationSignal,
  outputDeviceId: string | undefined,
  onLevel?: (level: number) => void,
): LoopbackHandle {
  let aborted: 'user' | 'device' | null = null
  let doAbort: (() => void) | null = null

  const promise = (async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    })
    if (aborted) { stream.getTracks().forEach(t => t.stop()); throw new CalibrationAborted(aborted) }
    const context = new AudioContext()
    const signal = buildSignal(context)
    if (outputDeviceId && 'setSinkId' in context) {
      try {
        await (context as AudioContext & { setSinkId: (id: string) => Promise<void> }).setSinkId(outputDeviceId)
      } catch { /* 保留默认输出，按未知处理 */ }
    }
    await context.audioWorklet.addModule(processorUrl)
    await context.resume()

    const frames: PcmFrame[] = []
    const node = new AudioWorkletNode(context, 'night-session-calibration')
    const mic = context.createMediaStreamSource(stream)
    const silent = new GainNode(context, { gain: 0 })
    mic.connect(node).connect(silent).connect(context.destination)
    node.port.onmessage = ({ data }: MessageEvent<PcmFrame>) => {
      frames.push(data)
      const rms = Math.sqrt(data.samples.reduce((sum, v) => sum + v * v, 0) / data.samples.length)
      onLevel?.(Math.min(1, rms * 4))
    }
    const onLost = () => { aborted = 'device'; doAbort?.() }
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', onLost)

    const source = context.createBufferSource()
    source.buffer = signal.buffer
    source.connect(context.destination)
    const when = context.currentTime + 0.15
    source.start(when)

    const result = await new Promise<LoopbackResult>((resolve, reject) => {
      doAbort = () => {
        if (aborted === null) aborted = 'user'
        try { source.stop() } catch { /* 已停止 */ }
        try { node.port.close() } catch { /* 已关闭 */ }
        for (const track of stream.getAudioTracks()) track.stop()
        void context.close()
        reject(new CalibrationAborted(aborted ?? 'user'))
      }
      if (aborted) { doAbort(); return }
      source.onended = async () => {
        if (aborted) { reject(new CalibrationAborted(aborted)); return }
        await new Promise<void>(done => {
          const timer = window.setTimeout(done, 200)
          node.port.onmessage = ({ data }: MessageEvent<PcmFrame | { flushed: true }>) => {
            if ('flushed' in data) { window.clearTimeout(timer); done() }
            else frames.push(data)
          }
          node.port.postMessage('flush')
        })
        const rate = context.sampleRate
        const length = Math.round((context.currentTime - when) * rate)
        const recording = new Float32Array(Math.max(0, length))
        for (const frame of frames) {
          const offset = Math.round((frame.inputTime - when) * rate)
          const first = Math.max(0, -offset)
          const last = Math.min(frame.samples.length, recording.length - offset)
          if (last <= first) continue
          recording.set(frame.samples.subarray(first, last), offset + first)
        }
        for (const track of stream.getAudioTracks()) {
          track.removeEventListener('ended', onLost)
          track.stop()
        }
        node.disconnect(); mic.disconnect(); silent.disconnect()
        void context.close()
        resolve({ recording, rate, stream, context, signal })
      }
    })
    return result
  })()

  return {
    promise,
    abort: () => { if (doAbort) doAbort(); else aborted = 'user' },
  }
}
