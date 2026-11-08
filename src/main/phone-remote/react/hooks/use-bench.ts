import { useCallback, useRef, useState } from 'react'
import { CONFIG } from '@shared/config'
import {
  MirrorBench,
  format as formatBench,
  incomingEstimateKbps,
  linkTimingMs,
  routeFromStats,
  sampleFromStats,
  sessionCode as mintSessionCode,
  shortRoute,
  type BenchSummary
} from '../mirror-bench'
import { mirrorStatsOverlayEnabled } from '../mirror-stats-flag'
import { wsTxMeter } from './use-connection'
import type { MirrorRigStatus } from '../MirrorStatsOverlay'
import type { MirrorQuality } from '../mirror-quality'

export function useBench(remoteLogRef: React.MutableRefObject<(message: string) => void>) {
  const benchRef = useRef(new MirrorBench())
  const benchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const benchTickRef = useRef(0)
  const benchTxRef = useRef({ msgs: 0, bytes: 0, at: 0 })
  const benchRxRef = useRef({ bytes: 0, at: 0 })
  const [benchSummary, setBenchSummary] = useState<BenchSummary | null>(null)
  const [benchEstimateKbps, setBenchEstimateKbps] = useState<number | null>(null)
  const benchCodeRef = useRef<string | null>(null)
  const [benchCode, setBenchCode] = useState<string | null>(null)
  const [rigStatus, setRigStatus] = useState<MirrorRigStatus | null>(null)

  const formatMmBench = useCallback(
    () => formatBench(benchRef.current.summary(), benchCodeRef.current ?? undefined),
    []
  )
  const stopBench = useCallback(() => {
    if (!benchTimerRef.current) return
    clearInterval(benchTimerRef.current)
    benchTimerRef.current = null
  }, [])
  const startBench = useCallback(
    (pc: RTCPeerConnection, quality: MirrorQuality) => {
      stopBench()
      benchRef.current.reset()
      benchTickRef.current = 0
      const code = mintSessionCode()
      benchCodeRef.current = code
      setBenchCode(code)
      benchTxRef.current = { msgs: wsTxMeter.msgs, bytes: wsTxMeter.bytes, at: performance.now() }
      benchRxRef.current = { bytes: 0, at: 0 }
      benchTimerRef.current = setInterval(() => {
        if (pc.connectionState !== 'connected') return
        void pc.getStats().then((report) => {
          const sample = sampleFromStats(report, performance.now())
          if (!sample) return
          const summary = benchRef.current.add(sample)
          benchTickRef.current++
          if (mirrorStatsOverlayEnabled()) {
            setBenchSummary(summary)
            setBenchEstimateKbps(incomingEstimateKbps(report))
            const timing = linkTimingMs(report)
            setRigStatus((prev) => ({
              macBatteryPct: prev?.macBatteryPct ?? null,
              macCharging: prev?.macCharging ?? false,
              glassesLink: prev?.glassesLink ?? null,
              glassesThermal: prev?.glassesThermal ?? null,
              glassesName: prev?.glassesName ?? null,
              glassesBatteryCritical: prev?.glassesBatteryCritical ?? false,
              rttMs: timing.rtt,
              jitterMs: timing.jitter,
              route: shortRoute(report)
            }))
          }
          if (benchTickRef.current % CONFIG.PHONE_REMOTE.MIRROR_BENCH_LOG_EVERY_N !== 0) return
          const txPrev = benchTxRef.current
          const txNow = { msgs: wsTxMeter.msgs, bytes: wsTxMeter.bytes, at: performance.now() }
          benchTxRef.current = txNow
          const txDtS = (txNow.at - txPrev.at) / 1000
          const txLine =
            txDtS > 0
              ? `tx=${((txNow.msgs - txPrev.msgs) / txDtS).toFixed(0)}/s@${(((txNow.bytes - txPrev.bytes) * 8) / txDtS / 1000).toFixed(0)}k`
              : 'tx=?'
          const timing = linkTimingMs(report)
          const rxPrev = benchRxRef.current
          benchRxRef.current = { bytes: sample.bytesReceived, at: sample.at }
          const rxDtS = (sample.at - rxPrev.at) / 1000
          const rxLine =
            rxPrev.at > 0 && rxDtS > 0
              ? `rx=${(((sample.bytesReceived - rxPrev.bytes) * 8) / rxDtS / 1000).toFixed(0)}k`
              : 'rx=?'
          remoteLogRef.current(
            `${formatBench(summary, code)} q=${quality} ${routeFromStats(report)} ${rxLine} ${txLine} rtt=${timing.rtt}ms jit=${timing.jitter}ms`
          )
        })
      }, CONFIG.PHONE_REMOTE.MIRROR_BENCH_POLL_MS)
    },
    [remoteLogRef, stopBench]
  )

  return {
    benchSummary,
    benchEstimateKbps,
    benchCode,
    rigStatus,
    setRigStatus,
    formatMmBench,
    startBench,
    stopBench
  }
}
