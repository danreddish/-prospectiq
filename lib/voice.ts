// v81: the user's own voice. Settings keeps a few messages they have really
// sent in profiles.service_profile.voice_sample (account level, no new
// column). The message writers are shown them for style only.
// No imports: the deep research background function bundles this file.

export const VOICE_SAMPLE_MAX = 3000

/** The voice sample from an account's service profile, trimmed, or null. */
export function voiceSampleFrom(serviceProfile: unknown): string | null {
  const v = (serviceProfile as { voice_sample?: unknown } | null | undefined)?.voice_sample
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, VOICE_SAMPLE_MAX) : null
}
