import assert from 'node:assert/strict'
import { test } from 'node:test'
import { findRestorableSignature, sameDevice, UNKNOWN } from '../src/features/calibration/lib/devices.ts'
import type { DeviceSignature } from '../src/features/calibration/lib/types.ts'

const RATE = 48000
const micA: DeviceSignature = { inputId: 'mic-a', inputLabel: '麦克风 A', outputId: 'spk-a', outputLabel: '扬声器 A', sampleRate: RATE }
const micB: DeviceSignature = { inputId: 'mic-b', inputLabel: '麦克风 B', outputId: 'spk-a', outputLabel: '扬声器 A', sampleRate: RATE }

test('切走再切回原输入输出组合时恢复原校准', () => {
  // 历史按最近使用倒序：最近用过 B，更早是 A
  const stored = [micB, micA]
  // 当前在用 B，机器上只剩 B：没有其他在线组合，保持 B
  assert.equal(findRestorableSignature(stored, new Set(['mic-b']), new Set(['spk-a']), micB), micB)
  // 只剩 B 且没有 previous（页面重载）-> 恢复最近可用的 B
  assert.equal(findRestorableSignature(stored, new Set(['mic-b']), new Set(['spk-a']), null), micB)
  // A 重新插回、当前签名是 B -> 识别到切回原组合 A，恢复 A 的校准
  const restored = findRestorableSignature(stored, new Set(['mic-a', 'mic-b']), new Set(['spk-a']), micB)
  assert.equal(restored, micA)
  assert.ok(sameDevice(restored!, micA))
})

test('原组合设备不在场且当前组合也离线时不恢复，状态应显示需重新校准', () => {
  // 历史里只有 micA，当前签名 micB；两者的输入都不在线
  const restored = findRestorableSignature([micA], new Set(['mic-x']), new Set(['spk-a']), micB)
  assert.equal(restored, null)
})

test('当前组合仍在线时即使存在其他历史记录也保持当前组合', () => {
  const restored = findRestorableSignature([micA], new Set(['mic-b']), new Set(['spk-a']), micB)
  assert.equal(restored, micB)
})

test('输出为 default 或未知时按可恢复处理，未知输出仍需用户确认', () => {
  const unknownOutput: DeviceSignature = { ...micA, outputId: UNKNOWN, outputLabel: '未知输出' }
  const restored = findRestorableSignature([unknownOutput], new Set(['mic-a']), new Set(['spk-a']), null)
  assert.equal(restored, unknownOutput)
  assert.equal(restored!.outputId, UNKNOWN)
  const defaultOutput: DeviceSignature = { ...micA, outputId: 'default', outputLabel: '默认输出' }
  assert.equal(findRestorableSignature([defaultOutput], new Set(['mic-a']), new Set([]), null), defaultOutput)
})
