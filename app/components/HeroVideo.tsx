'use client'

import { useEffect, useRef } from 'react'

const PLAYBACK_ID = '8wrHPCX2dC3msyYU9ObwqNdm00u3ViXvOSHUMRYSEe5Q'
const HLS_URL = `https://stream.mux.com/${PLAYBACK_ID}.m3u8`
const POSTER_URL = `https://image.mux.com/${PLAYBACK_ID}/thumbnail.jpg?time=0`

export default function HeroVideo() {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    // Safari supports HLS natively
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = HLS_URL
      video.load()
      video.play().catch(() => {})
      return
    }

    // Chrome / Firefox need HLS.js
    let hls: import('hls.js').default | null = null
    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) return
      hls = new Hls({ autoStartLoad: true, lowLatencyMode: false })
      hls.loadSource(HLS_URL)
      hls.attachMedia(video)
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {})
      })
    })

    return () => {
      hls?.destroy()
    }
  }, [])

  return (
    <video
      ref={videoRef}
      autoPlay
      muted
      loop
      playsInline
      poster={POSTER_URL}
      className="absolute inset-0 w-full h-full object-cover opacity-[0.18] pointer-events-none select-none"
    />
  )
}
