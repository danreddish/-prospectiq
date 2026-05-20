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
      return
    }

    // Chrome / Firefox need HLS.js
    let hls: import('hls.js').default | null = null
    import('hls.js').then(({ default: Hls }) => {
      if (!Hls.isSupported()) return
      hls = new Hls({ autoStartLoad: true, lowLatencyMode: false })
      hls.loadSource(HLS_URL)
      hls.attachMedia(video)
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
      className="absolute bottom-0 right-0 w-[680px] h-[680px] object-cover opacity-[0.22] pointer-events-none select-none"
      style={{
        maskImage: 'radial-gradient(circle at center, black 35%, transparent 72%)',
        WebkitMaskImage: 'radial-gradient(circle at center, black 35%, transparent 72%)',
      }}
    />
  )
}
