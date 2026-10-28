import {
  getFirmIndividualsPage,
  getFirmAppointedRepsPage,
  getIndividualFunctions,
  type FCAIndividual,
  type FCAFunctionRecord,
} from '@/lib/data-sources/fca-register'

// Firm-led candidate search. 25 candidates per request, cursor paginated.
//
// Principal mode walks the firm's own individual list (20 per register page)
// and keeps the people holding a customer-facing function. A network's list
// includes its AR advisers, recorded against the principal.
// AR mode walks the firm's current appointed representatives (10 per register
// page), lists each AR's individuals, and reports the AR as the candidate's
// firm. Both modes need one controlled-function call per candidate, so a
// request stays under 40 register calls.

export interface AdviserCandidate {
  irn: string
  name: string
  firm: string
  frn: string
  principal_frn: string | null
  principal_name: string | null
  status: string
  function: string
  function_from: string | null
  engagement_method: string | null
  source: 'fca_register'
  confidence: number
}

const PER_REQUEST = 25

// Certified persons hold customer-facing roles under the certification
// regime. Cheap pre-filter from the list before spending a CF call.
function likelyCustomerFacing(ind: FCAIndividual): boolean {
  const s = ind.status.toLowerCase()
  if (s.includes('certified')) return true
  // Firms that still list only "Approved by regulator" (legacy CF30) need the CF call to tell.
  return s.includes('approved')
}

function pickCustomerFunction(functions: FCAFunctionRecord[], frn: string): FCAFunctionRecord | null {
  const atFirm = functions.filter((f) => f.customer_facing && (f.frn === frn || !f.frn))
  const dated = atFirm.filter((f) => f.effective_from).sort((a, b) => (a.effective_from! < b.effective_from! ? -1 : 1))
  return dated[0] || atFirm[0] || functions.find((f) => f.customer_facing) || null
}

async function confirmCandidates(
  people: { ind: FCAIndividual; firm: string; frn: string; principal_frn: string | null; principal_name: string | null }[],
  functionFrn: string
): Promise<AdviserCandidate[]> {
  const batch = people.slice(0, PER_REQUEST)
  // Strict: a failed lookup is kept as an unconfirmed candidate rather than
  // silently dropped, because the cursor moves past it for good.
  const results = await Promise.all(
    batch.map((p) => getIndividualFunctions(p.ind.irn, { strict: true }).catch(() => null))
  )
  const out: AdviserCandidate[] = []
  for (let i = 0; i < batch.length; i++) {
    const p = batch[i]
    const fns = results[i]
    if (fns === null) {
      out.push({
        irn: p.ind.irn, name: p.ind.name, firm: p.firm, frn: p.frn,
        principal_frn: p.principal_frn, principal_name: p.principal_name,
        status: p.ind.status, function: 'Function not confirmed (register busy)', function_from: null,
        engagement_method: null, source: 'fca_register', confidence: 5,
      })
      continue
    }
    const fn = pickCustomerFunction(fns.current, functionFrn)
    if (!fn) continue
    out.push({
      irn: p.ind.irn,
      name: p.ind.name,
      firm: p.firm,
      frn: p.frn,
      principal_frn: p.principal_frn,
      principal_name: p.principal_name,
      status: p.ind.status,
      function: fn.name,
      function_from: fn.effective_from,
      engagement_method: fn.engagement_method,
      source: 'fca_register',
      confidence: 8,
    })
  }
  return out
}

export async function findViaPrincipal(frn: string, firmName: string, startPage: number, startOffset: number, startedAt: number) {
  const pool: { ind: FCAIndividual; firm: string; frn: string; principal_frn: null; principal_name: null }[] = []
  let page = startPage
  let offset = startOffset
  let totalCount = 0
  let exhausted = false
  let pagesRead = 0

  // Read up to two register pages (40 people) so one request stays small.
  while (pool.length < PER_REQUEST && pagesRead < 2) {
    const { individuals, totalCount: total, hasNext } = await getFirmIndividualsPage(frn, page)
    pagesRead++
    totalCount = total
    const slice = individuals.slice(offset)
    for (let i = 0; i < slice.length; i++) {
      if (likelyCustomerFacing(slice[i])) {
        pool.push({ ind: slice[i], firm: firmName, frn, principal_frn: null, principal_name: null })
      }
      offset++
      if (pool.length >= PER_REQUEST) break
    }
    if (offset >= individuals.length) {
      if (!hasNext) { exhausted = true; break }
      page++
      offset = 0
    }
    if (Date.now() - startedAt > 4000) break
  }

  const candidates = await confirmCandidates(pool, frn)
  return {
    candidates,
    mode: 'principal',
    total_individuals: totalCount,
    next_cursor: exhausted ? null : { page, offset },
    done: exhausted,
    timeTakenMs: Date.now() - startedAt,
  }
}

export async function findViaAppointedReps(frn: string, principalName: string, startPage: number, startOffset: number, startedAt: number) {
  // One AR page (10 firms) per request. offset skips ARs already processed on that page.
  const arPage = await getFirmAppointedRepsPage(frn, startPage)
  const ars = arPage.current.slice(startOffset)
  const exhaustedCurrent = arPage.current.length === 0

  if (exhaustedCurrent) {
    return { candidates: [], mode: 'appointed_reps', total_ars: arPage.totalCount, next_cursor: null, done: true, timeTakenMs: Date.now() - startedAt }
  }

  const lists = await Promise.all(
    ars.map((ar) => getFirmIndividualsPage(ar.frn, 1).then((r) => ({ ar, individuals: r.individuals })).catch(() => ({ ar, individuals: [] as FCAIndividual[] })))
  )

  // Accumulate whole ARs until the next one would overflow the request,
  // so the cursor never skips an AR that was only partly processed.
  const pool: { ind: FCAIndividual; firm: string; frn: string; principal_frn: string; principal_name: string }[] = []
  const seen = new Set<string>()
  let arsUsed = 0
  for (const { ar, individuals } of lists) {
    const eligible = individuals.filter((ind) => likelyCustomerFacing(ind) && !seen.has(ind.irn)).slice(0, PER_REQUEST)
    if (arsUsed > 0 && pool.length + eligible.length > PER_REQUEST) break
    for (const ind of eligible) {
      seen.add(ind.irn)
      pool.push({ ind, firm: ar.name, frn: ar.frn, principal_frn: frn, principal_name: principalName })
    }
    arsUsed++
  }

  // Functions for AR advisers are recorded against the principal firm.
  const candidates = await confirmCandidates(pool, frn)

  const processedAll = startOffset + arsUsed >= arPage.current.length
  const nextCursor = processedAll
    ? (arPage.hasNext ? { page: startPage + 1, offset: 0 } : null)
    : { page: startPage, offset: startOffset + arsUsed }

  return {
    candidates,
    mode: 'appointed_reps',
    total_ars: arPage.totalCount,
    next_cursor: nextCursor,
    done: nextCursor === null,
    timeTakenMs: Date.now() - startedAt,
  }
}
