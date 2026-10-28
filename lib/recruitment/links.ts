// Public FCA Register links for the UI. Kept apart from the register API
// client so client components never bundle server code or env lookups.

export function fcaIndividualUrl(irn: string): string {
  return `https://register.fca.org.uk/s/search?q=${encodeURIComponent(irn)}&type=Individuals`
}

export function fcaFirmUrl(frn: string): string {
  return `https://register.fca.org.uk/s/search?q=${encodeURIComponent(frn)}&type=Companies`
}

export function linkedInSearchUrl(name: string, firm?: string | null): string {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${firm || ''}`.trim())}`
}
