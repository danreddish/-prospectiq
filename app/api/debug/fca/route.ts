import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const apiKey = process.env.FCA_REGISTER_API_KEY
  const email = process.env.FCA_REGISTER_EMAIL

  if (!apiKey || !email) {
    return NextResponse.json({ error: 'Missing env vars', hasApiKey: !!apiKey, hasEmail: !!email })
  }

  const headers = {
    Accept: 'application/json',
    'X-Auth-Email': email,
    'X-Auth-Key': apiKey,
  }

  // Test a range of search terms to find what works
  const testSearches = [
    'wealth management ltd',
    'financial planning ltd',
    'mortgage advisors',
    'mortgage solutions',
    'independent financial advisers',
    'private client',
    'IFA',
    'wealth advisors',
    'financial services ltd',
    'advisory ltd',
    'St. James',
    'Quilter',
    'Hargreaves',
  ]

  const results = []

  for (const term of testSearches) {
    try {
      const encoded = term.replace(/\s+/g, '+')
      const url = `https://register.fca.org.uk/services/V0.1/Search?q=${encoded}&type=firm`
      const res = await fetch(url, { headers })
      const body = await res.text()

      let count = 0
      let firstFirm = ''
      try {
        const json = JSON.parse(body)
        if (json.Data && Array.isArray(json.Data)) {
          count = json.Data.length
          firstFirm = json.Data[0]?.['Name'] || ''
        }
        if (json.ResultInfo?.total_count) {
          count = parseInt(json.ResultInfo.total_count)
        }
      } catch {
        // not JSON
      }

      results.push({
        term,
        status: res.status,
        count,
        firstFirm: firstFirm.slice(0, 80),
        bodyPreview: body.slice(0, 150),
      })
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      results.push({ term, error: msg })
    }
  }

  // Also test a direct firm lookup and individuals fetch
  const firmTest: Record<string, unknown> = {}
  try {
    const firmRes = await fetch('https://register.fca.org.uk/services/V0.1/Firm/122702/Individuals', { headers })
    const firmBody = await firmRes.json()
    firmTest.status = firmRes.status
    firmTest.individualCount = firmBody.Data?.length || 0
    firmTest.firstIndividual = firmBody.Data?.[0]?.['Name'] || 'none'
  } catch (err: unknown) {
    firmTest.error = err instanceof Error ? err.message : String(err)
  }

  return NextResponse.json({ 
    authPattern: 'X-Auth-Email=email, X-Auth-Key=apiKey',
    searchResults: results,
    firmIndividualsTest: firmTest,
  })
}
