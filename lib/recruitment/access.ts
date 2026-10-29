import { RecruitmentProfile } from '@/types'

// v76: access rules live in access-rules.ts so the scheduled functions can
// share them. Re-exported here for the app.
export {
  recruitmentAccess,
  hasRecruitmentAccess,
  recruitmentMessage,
  RECRUITMENT_ACCESS_COLUMNS,
  type RecruitmentReason,
  type RecruitmentAccessFields,
} from './access-rules'

export const EMPTY_RECRUITMENT_PROFILE: RecruitmentProfile = {
  firm_name: null,
  proposition: null,
  roles_needed: [],
  adviser_types: [],
  target_locations: [],
  min_years_approved: null,
  permissions_required: [],
  notes: null,
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.map((x) => String(x).trim()).filter(Boolean)
}

// Normalise whatever is in the jsonb column into a full profile shape.
export function normaliseRecruitmentProfile(raw: unknown): RecruitmentProfile {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const minYears = r.min_years_approved
  return {
    firm_name: typeof r.firm_name === 'string' && r.firm_name.trim() ? r.firm_name.trim() : null,
    proposition: typeof r.proposition === 'string' && r.proposition.trim() ? r.proposition.trim() : null,
    roles_needed: asStringArray(r.roles_needed),
    adviser_types: asStringArray(r.adviser_types) as RecruitmentProfile['adviser_types'],
    target_locations: asStringArray(r.target_locations),
    min_years_approved: typeof minYears === 'number' && minYears > 0 ? minYears : null,
    permissions_required: asStringArray(r.permissions_required),
    notes: typeof r.notes === 'string' && r.notes.trim() ? r.notes.trim() : null,
  }
}

// Campaign level overrides account level, field by field. Same pattern as
// the service profile merge in the client research route.
export function mergeRecruitmentProfiles(account: unknown, campaign: unknown): RecruitmentProfile {
  const a = normaliseRecruitmentProfile(account)
  const c = normaliseRecruitmentProfile(campaign)
  return {
    firm_name: c.firm_name || a.firm_name,
    proposition: c.proposition || a.proposition,
    roles_needed: c.roles_needed.length ? c.roles_needed : a.roles_needed,
    adviser_types: c.adviser_types.length ? c.adviser_types : a.adviser_types,
    target_locations: c.target_locations.length ? c.target_locations : a.target_locations,
    min_years_approved: c.min_years_approved ?? a.min_years_approved,
    permissions_required: c.permissions_required.length ? c.permissions_required : a.permissions_required,
    notes: c.notes || a.notes,
  }
}

export function recruitmentProfileIsEmpty(p: RecruitmentProfile): boolean {
  return !p.firm_name && !p.proposition && p.roles_needed.length === 0 && p.adviser_types.length === 0
    && p.target_locations.length === 0 && !p.min_years_approved && p.permissions_required.length === 0 && !p.notes
}
