<script setup lang="ts">
import { CheckCircle2, History, Play, Radio, RotateCcw, Square, TriangleAlert, Waves } from '@lucide/vue'
import { computed, onBeforeUnmount, onMounted, ref, watchEffect } from 'vue'
import type { CalibrationRecord, CalibrationStatus, CandidateVerdict } from '../lib/types'
import type { TestSession } from '../model/useCalibration'
import { drawCalibrationWave } from '../lib/plot'
import { deviceLabel, UNKNOWN } from '../lib/devices'

const props = defineProps<{
  phase: 'idle' | 'testing' | 'review'
  status: CalibrationStatus
  issue: string
  level: number
  session: TestSession | null
  retained: CalibrationRecord | null
  records: CalibrationRecord[]
  reverify: Record<string, CandidateVerdict>
  outputDevices: MediaDeviceInfo[]
  chosenOutputId: string
}>()

const emit = defineEmits<{
  run: []
  abort: []
  discard: []
  audition: [number | undefined]
  auditionCandidate: [number]
  stopAudition: []
  mark: [number]
  confirmOutput: [string, string]
  confirmAuto: []
  confirmManual: []
  reverify: [CalibrationRecord]
}>()

const canvas = ref<HTMLCanvasElement | null>(null)
const size = ref({ width: 0, height: 0 })
let observer: ResizeObserver | undefined
onMounted(() => {
  if (!canvas.value) return
  observer = new ResizeObserver(([entry]) => {
    size.value = { width: entry.contentRect.width, height: entry.contentRect.height }
  })
  observer.observe(canvas.value)
})
onBeforeUnmount(() => observer?.disconnect())

const verdict = computed(() => props.session?.verdict ?? null)
const chosenMs = computed(() => {
  const v = verdict.value
  return v?.status === 'confident' ? v.chosen.latencyMs : null
})
const referencePulseTimes = computed(() => props.session?.pulses.map(p => p.time) ?? [])

watchEffect(() => {
  const { width, height } = size.value
  if (!canvas.value || !props.session || width < 80 || height < 60) return
  drawCalibrationWave(canvas.value, width, height, {
    recording: props.session.recording,
    rate: props.session.rate,
    pulses: props.session.pulses,
    candidates: verdict.value?.candidates ?? [],
    chosenLatencyMs: chosenMs.value,
    manualLatencyMs: props.session.manualLatencyMs,
    referencePulseTimes: referencePulseTimes.value,
  }, time => emit('mark', time))
})

const outputOptions = computed(() => [
  { id: '', label: '系统默认输出（浏览器可能无法识别具体设备）' },
  ...props.outputDevices.map(d => ({ id: d.deviceId, label: d.label || `输出设备 ${d.deviceId.slice(0, 6)}` })),
])

function onOutputChange(event: Event) {
  const select = event.target as HTMLSelectElement
  const id = select.value
  const label = outputOptions.value.find(o => o.id === id)?.label ?? '未知输出'
  emit('confirmOutput', id || UNKNOWN, label)
}

const kindText: Record<string, string> = { direct: '直达（第一声）', reflection: '反射峰', ambiguous: '难以区分' }

function reverifyNote(record: CalibrationRecord): string {
  const result = props.reverify[record.id]
  if (!result) return ''
  if (result.status !== 'confident') return result.reason
  const delta = Math.abs(result.chosen.latencyMs - record.latencyMs).toFixed(1)
  return `验证通过：自动值 ${result.chosen.latencyMs}ms，与当时确认值相差 ${delta}ms`
}
</script>

<template>
  <section class="calibration" aria-labelledby="calibration-title">
    <h2 class="rail-title" id="calibration-title"><Radio :size="17" /> 延迟校准 <span class="mono">{{ status.label }}</span></h2>

    <div v-if="phase !== 'review'" class="cal-current">
      <template v-if="status.kind === 'calibrated'">
        <p class="cal-value mono">{{ status.latencyMs }}<small>ms · {{ status.source === 'manual' ? '人工确认' : status.source === 'restored' ? '设备恢复' : '自动确认' }}</small></p>
      </template>
      <p v-else-if="status.kind === 'unknown-output'" class="cal-warn"><TriangleAlert :size="14" /> 当前校准的输出路径未知，请确认输出设备</p>
      <p v-else-if="status.kind === 'stale'" class="cal-warn"><TriangleAlert :size="14" /> 输入 / 输出组合已切换，旧值不再适用</p>
      <p v-else class="cal-hint">尚未校准，录音与参考音将按零偏移显示。</p>

      <label class="output-select">
        <span>输出设备</span>
        <select :value="chosenOutputId" @change="onOutputChange">
          <option v-for="option in outputOptions" :key="option.id || 'default'" :value="option.id">{{ option.label }}</option>
        </select>
      </label>

      <div v-if="phase === 'testing'" class="cal-testing">
        <div class="level-meter" role="meter" aria-label="回录音量">
          <i v-for="step in 16" :key="step" :class="{ lit: level * 16 >= step }"></i>
        </div>
        <p class="cal-hint">正在播放校准测试音并回录，保持环境安静…</p>
        <button class="ghost-button" @click="emit('abort')"><Square :size="13" fill="currentColor" /> 中断测试</button>
      </div>
      <button v-else class="primary-button" @click="emit('run')"><Waves :size="15" /> 开始校准测试</button>
    </div>

    <div v-else-if="session" class="cal-review">
      <p class="cal-device mono" :title="deviceLabel(session.device)">{{ deviceLabel(session.device) }}</p>
      <p v-if="session.device.outputId === UNKNOWN" class="cal-warn">
        <TriangleAlert :size="14" /> 浏览器无法识别当前输出路径，请先在下方确认输出设备后再保存。
      </p>

      <div class="cal-canvas-wrap">
        <canvas ref="canvas" class="cal-canvas" role="img"
          aria-label="回录波形与候选偏移，可点击标出实际听到的第一声"></canvas>
        <p class="cal-hint">白虚线＝参考音理论位置；点击波形可标出你听到的第一声。</p>
      </div>

      <div v-if="verdict?.candidates.length" class="candidate-list">
        <button v-for="candidate in verdict.candidates" :key="candidate.onsetSample" type="button" class="candidate-row"
          :class="{ chosen: candidate.latencyMs === chosenMs }" :title="`试听该抵达前后片段`"
          @click="emit('auditionCandidate', candidate.latencyMs)">
          <strong class="mono">{{ candidate.latencyMs }}ms</strong>
          <span>{{ kindText[candidate.kind] }}</span>
          <small class="mono">{{ candidate.marginDb }}dB · {{ Math.round(candidate.strength * 100) }}%</small>
        </button>
      </div>

      <div v-if="verdict?.status === 'confident'" class="cal-verdict ok">
        <CheckCircle2 :size="15" /><p>{{ verdict.reason }}</p>
      </div>
      <div v-else-if="verdict?.status === 'ambiguous'" class="cal-verdict warn">
        <TriangleAlert :size="15" />
        <div>
          <p>{{ verdict.reason }}</p>
          <p v-if="retained" class="cal-hint">已保留上次确认值 <strong class="mono">{{ retained.latencyMs }}ms</strong>（{{ deviceLabel(retained.device) }}），请重新判定。</p>
        </div>
      </div>
      <div v-else-if="verdict" class="cal-verdict warn">
        <TriangleAlert :size="15" /><p>{{ verdict.reason }}</p>
      </div>

      <div v-if="session.manualLatencyMs != null" class="cal-manual">
        人工标注：<strong class="mono">{{ session.manualLatencyMs }}ms</strong>
      </div>

      <div class="cal-actions">
        <button class="ghost-button" @click="emit('audition', undefined)"><Play :size="13" fill="currentColor" /> 试听回录</button>
        <button class="ghost-button" @click="emit('stopAudition')"><Square :size="12" fill="currentColor" /> 停止</button>
        <button v-if="verdict?.status === 'confident'" class="primary-button"
          :disabled="session.device.outputId === UNKNOWN" @click="emit('confirmAuto')">
          <CheckCircle2 :size="14" /> 采用自动值 {{ chosenMs }}ms
        </button>
        <button class="primary-button" :disabled="session.manualLatencyMs == null || session.device.outputId === UNKNOWN"
          @click="emit('confirmManual')">确认人工标注</button>
        <button class="ghost-button" @click="emit('discard')"><RotateCcw :size="13" /> 放弃本次</button>
      </div>

      <label v-if="session.device.outputId === UNKNOWN" class="output-select">
        <span>请确认本次测试的输出设备</span>
        <select :value="''" @change="onOutputChange">
          <option value="" disabled>选择输出…</option>
          <option v-for="option in outputOptions" :key="option.id || 'default'" :value="option.id">{{ option.label }}</option>
          <option :value="UNKNOWN">确实无法识别，标记为未知输出</option>
        </select>
      </label>
    </div>

    <details v-if="records.length" class="cal-history">
      <summary><History :size="14" /> 历史校准（{{ records.length }}）· 原始回录可重新验证</summary>
      <ul>
        <li v-for="record in records.slice(0, 6)" :key="record.id">
          <div>
            <strong class="mono">{{ record.latencyMs }}ms</strong>
            <small>{{ record.source === 'manual' ? '人工' : '自动' }} · {{ deviceLabel(record.device) }}</small>
          </div>
          <button class="ghost-button tiny" @click="emit('reverify', record)">
            <RotateCcw :size="12" /> 重新验证
          </button>
          <p v-if="reverify[record.id]" class="cal-hint reverify-note"
            :class="{ fail: reverify[record.id].status !== 'confident' }">
            {{ reverifyNote(record) }}
          </p>
        </li>
      </ul>
    </details>

    <p v-if="issue" class="inline-error" role="alert">{{ issue }}</p>
  </section>
</template>
