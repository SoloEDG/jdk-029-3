import type { CalibrationInfo } from '../../../shared/document'

/**
 * 把歌曲时间轴上的点按录音时刻的校准偏移回拨，使录音起音与参考音对齐。
 * 试听游标与音高曲线必须共用本函数，保证两处反映同一偏移。
 */
export function alignTime(songTime: number, info: CalibrationInfo | null | undefined): number {
  return info ? songTime - info.latencyMs / 1000 : songTime
}
