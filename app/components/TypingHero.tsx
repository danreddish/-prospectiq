'use client'

import { useEffect, useState } from 'react'

const PHRASES = [
  'wealth managers.',
  'IFAs.',
  'mortgage brokers.',
  'financial planners.',
  'private client advisors.',
]

export default function TypingHero() {
  const [phraseIndex, setPhraseIndex] = useState(0)
  const [displayed, setDisplayed] = useState('')
  const [deleting, setDeleting] = useState(false)

  useEffect(() => {
    const current = PHRASES[phraseIndex]

    if (!deleting && displayed === current) {
      const pause = setTimeout(() => setDeleting(true), 2200)
      return () => clearTimeout(pause)
    }

    if (deleting && displayed === '') {
      setDeleting(false)
      setPhraseIndex((i) => (i + 1) % PHRASES.length)
      return
    }

    const speed = deleting ? 35 : 75
    const timeout = setTimeout(() => {
      setDisplayed(
        deleting
          ? displayed.slice(0, -1)
          : current.slice(0, displayed.length + 1)
      )
    }, speed)

    return () => clearTimeout(timeout)
  }, [displayed, deleting, phraseIndex])

  return (
    <p className="text-brand-beige text-base mt-3 font-light tracking-wide">
      Built for{' '}
      <span className="text-brand-rose-gold font-semibold">
        {displayed}
        <span
          className="inline-block w-[2px] h-[1em] bg-brand-rose-gold ml-[2px] align-middle"
          style={{ animation: 'blink 0.75s step-end infinite' }}
        />
      </span>
    </p>
  )
}
