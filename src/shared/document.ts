export interface TimeRange { start: number; end: number }

export interface LyricLine extends TimeRange {
  id: string
  text: string
}

export interface GuideNote extends TimeRange { midi: number }

export interface Song {
  id: string
  title: string
  artist: string
  bpm: number
  key: string
  duration: number
  audio: string
  cover: string
  lines: LyricLine[]
  notes: GuideNote[]
}

export interface PitchPoint {
  time: number
  midi: number | null
}

export interface Take extends TimeRange {
  id: string
  songId: string
  lineId: string
  createdAt: number
  audio: Blob
  pitch: PitchPoint[]
  /** 录音时刻的校准解释；旧录音无此字段，按未校准解释 */
  calibration?: CalibrationInfo | null
}

export interface PcmFrame {
  inputTime: number
  samples: Float32Array
}

/** 录音保存时绑定的校准条件（旧录音无此字段，按未校准解释） */
export interface CalibrationInfo {
  /** 录音时刻生效的延迟毫秒；回放与曲线均按该值对齐 */
  latencyMs: number
  device: {
    inputId: string
    inputLabel: string
    outputId: string
    outputLabel: string
    sampleRate: number
  }
  calibrationId: string
  /** 录音时刻该设备组合是否处于已校准状态 */
  calibrated: boolean
  source: 'auto' | 'manual' | 'restored'
}
