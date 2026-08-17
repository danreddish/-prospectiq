'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

/* ============================================================================
   Types
   ============================================================================ */

type Tier = 'A' | 'B' | 'C'
type AdvisorRole = 'wealth_manager' | 'financial_planner' | 'mortgage_broker' | 'other'
type AppScreen =
  | 'role-gate'
  | 'dashboard'
  | 'campaign-new'
  | 'finding'
  | 'prospects'
  | 'researching'
  | 'outreach'
  | 'results'

interface ScoreExplanation {
  wealth: string
  timing: string
  accessibility: string
  complexity: string
}

interface OutreachSequence {
  connection: string
  welcome: string
  relationship: string
  moveOffline: string
}

interface MockProspect {
  id: string
  name: string
  role: string
  company: string
  location: string
  tier: Tier
  scores: { wealth: number; timing: number; accessibility: number; complexity: number }
  total: number
  signals: string[]
  signalExplain: string         // why these signals matter for THIS prospect
  scoreReason: ScoreExplanation // why the score landed where it did
  outreach: Record<AdvisorRole, OutreachSequence>
}

interface ActiveCampaign {
  name: string
  tier: Tier
  count: number
  newThisWeek: number
}

interface RoleConfig {
  label: string
  shortLabel: string
  campaigns: ActiveCampaign[]
  presetICPs: string[]
  audienceDescriptor: string // for stage context
}

/* ============================================================================
   Role configuration — drives which campaigns + ICP presets the user sees
   ============================================================================ */

const ROLE_CONFIG: Record<AdvisorRole, RoleConfig> = {
  wealth_manager: {
    label: 'Wealth manager / IFA',
    shortLabel: 'Wealth manager',
    audienceDescriptor: 'HNW director-shareholders and family-business owners',
    campaigns: [
      { name: 'HNW Directors', tier: 'A', count: 32, newThisWeek: 8 },
      { name: 'Family Business Owners', tier: 'B', count: 58, newThisWeek: 6 },
      { name: 'Founder Exits', tier: 'A', count: 21, newThisWeek: 4 },
    ],
    presetICPs: [
      'UK director-shareholders with retained earnings above £2m',
      'Family business owners aged 50-65 in the South East',
      'Tech founders post-exit with proceeds £5m+',
    ],
  },
  financial_planner: {
    label: 'Financial planner',
    shortLabel: 'Planner',
    audienceDescriptor: 'pre-retirees, inherited-wealth clients, and business sellers',
    campaigns: [
      { name: 'Pre-Retirement HNW', tier: 'A', count: 28, newThisWeek: 7 },
      { name: 'Inherited Wealth', tier: 'B', count: 41, newThisWeek: 5 },
      { name: 'Business Sale Proceeds', tier: 'A', count: 19, newThisWeek: 3 },
    ],
    presetICPs: [
      'Pre-retirees in the South East with pension pots over £750k',
      'Recipients of inheritance above £500k in the last 18 months',
      'Owners of businesses sold for £2m+ in the last 12 months',
    ],
  },
  mortgage_broker: {
    label: 'Mortgage broker',
    shortLabel: 'Broker',
    audienceDescriptor: 'BTL portfolio landlords and HNW property buyers',
    campaigns: [
      { name: 'BTL Portfolio Landlords', tier: 'A', count: 36, newThisWeek: 9 },
      { name: 'HNW Property Buyers', tier: 'B', count: 47, newThisWeek: 5 },
      { name: 'Director-Shareholder Refi', tier: 'A', count: 18, newThisWeek: 3 },
    ],
    presetICPs: [
      'BTL landlords with portfolios of £2m+ across 5+ properties',
      'Director-shareholders seeking property purchase via Ltd company',
      'HNW individuals buying London property £1.5m+ in the next 12 months',
    ],
  },
  other: {
    label: 'Other',
    shortLabel: 'Advisor',
    audienceDescriptor: 'HNW director-shareholders and family-business owners',
    campaigns: [
      { name: 'HNW Directors', tier: 'A', count: 32, newThisWeek: 8 },
      { name: 'Family Business Owners', tier: 'B', count: 58, newThisWeek: 6 },
      { name: 'Founder Exits', tier: 'A', count: 21, newThisWeek: 4 },
    ],
    presetICPs: [
      'UK director-shareholders with retained earnings above £2m',
      'Family business owners aged 50-65 in the South East',
      'Tech founders post-exit with proceeds £5m+',
    ],
  },
}
/* ============================================================================
   Prospect data — outreach is rewritten per advisor role
   ============================================================================ */

const MOCK_PROSPECTS: MockProspect[] = [
  {
    id: 'henry',
    name: 'Henry Ashworth',
    role: 'Director',
    company: 'Ashworth Holdings Ltd',
    location: 'London',
    tier: 'A',
    scores: { wealth: 9, timing: 8, accessibility: 9, complexity: 8 },
    total: 34,
    signals: [
      'Three active directorships across property and energy',
      'Company filed £4.2m in retained earnings (latest accounts)',
      'London SW based, 12+ years as director',
      'Active on LinkedIn, posts monthly',
    ],
    signalExplain:
      'These signals together suggest a wealthy operator with liquidity sitting in his Ltd company, a stable base of operations, and an engaged digital presence , meaning he is both a strong candidate and reachable.',
    scoreReason: {
      wealth:
        '9/10. £4.2m in retained earnings is a clear wealth marker. Three directorships across two sectors indicates diversified income.',
      timing:
        '8/10. Multi-sector director-shareholders typically rethink tax structure annually. Active recent filings suggest ongoing strategic activity.',
      accessibility:
        '9/10. Active LinkedIn profile with monthly posts. Open to engagement and connections.',
      complexity:
        '8/10. Spans property + energy holdings, suggesting interest in multi-asset planning conversations.',
    },
    outreach: {
      wealth_manager: {
        connection:
          'Hi Henry, I see we are both in the London property and energy space. Would value being connected.',
        welcome:
          "Henry, thanks for connecting. Noticed Ashworth Holdings spans property and energy , an unusual combination at that scale. Curious whether you are seeing more clients in your network asking about how to consolidate income from multiple holdings for tax efficiency? Picking up on a pattern with similar director-shareholders this quarter.",
        relationship:
          "Henry, came across something you may find useful. The 2025 Family Investment Companies update from STEP highlighted three structural changes most director-shareholders with multi-sector holdings are missing , particularly around dividend timing and reserve allocation. The bit on retained earnings strategies struck me as relevant to what Ashworth is doing. Happy to send the summary across if it would be useful , only takes a couple of minutes to read.",
        moveOffline:
          "Henry, since the STEP piece I sent over, I have spoken with three director-shareholders running similar structures who all flagged the same question , whether their current setup is still the most efficient given the autumn rule changes. The reason I am asking: I am trying to get a sense of whether this is a quiet concern across the sector or something most have already addressed. Would a brief 10-minute call in the next week or two be useful, or is this not really a priority right now? Either answer is helpful.",
      },
      financial_planner: {
        connection:
          'Hi Henry, I see we are both based in London with an interest in long-term wealth planning. Would value being connected.',
        welcome:
          "Henry, thanks for connecting. Noticed Ashworth Holdings spans property and energy. Curious whether your personal financial planning has kept pace with the complexity of the business side , most director-shareholders I speak with at your level say it has not. No agenda, just trying to understand the pattern.",
        relationship:
          "Henry, came across a piece you may find useful. The CISI's 2025 report on multi-directorship retirement planning broke down how three director-shareholders structured their drawdown across multiple Ltd companies , the part on dividend vs. salary timing in the 5-year run-up was particularly sharp. Happy to send the relevant section.",
        moveOffline:
          "Henry, after the CISI piece I shared, I have had short conversations with a handful of director-shareholders in similar positions. The common thread is that the personal-financial-planning side lags 3-5 years behind the business side. Curious whether that matches your own experience. Would a brief 10-minute call in the next couple of weeks be useful, or is this not currently a priority? Either answer helps.",
      },
      mortgage_broker: {
        connection:
          'Hi Henry, I see we are both connected to the London property space. Would value being connected.',
        welcome:
          "Henry, thanks for connecting. Noticed Ashworth Holdings has property in the mix. When you have considered new acquisitions, are you finding the Ltd-company mortgage market straightforward or has the underwriting got harder this year? Asking because I am seeing a clear split among director-shareholder clients.",
        relationship:
          "Henry, picked up something you may find useful. The 2025 review from the Property Wealth Forum compared how thirty-plus director-shareholders structured property purchases via Ltd vs. SPV vs. personal , the part on stress-testing retained earnings against rate rises was particularly relevant. Want me to send across the summary?",
        moveOffline:
          "Henry, since the Property Wealth Forum piece, I have spoken with four director-shareholders looking at property additions this year. The split between Ltd-company and SPV routes is far less obvious than people think. Would a brief 10-minute call in the next couple of weeks be useful, or is this not on your radar right now? Either answer is fine.",
      },
      other: {
        connection:
          'Hi Henry, I see we are both in the London business community. Would value being connected.',
        welcome:
          "Henry, thanks for connecting. Noticed Ashworth Holdings spans property and energy , an interesting combination. Curious whether the operational side of running multi-sector holdings is keeping pace with the strategic side, or whether something feels stretched? No agenda, just trying to understand a pattern.",
        relationship:
          "Henry, came across a piece on multi-sector director-shareholder structures that I think you may find useful. Happy to send across if it would help.",
        moveOffline:
          "Henry, after the piece I shared, I have been comparing notes with a few director-shareholders running similar structures. Would a brief 10-minute call in the next couple of weeks be useful, or is this not a current priority?",
      },
    },
  },
  {
    id: 'priya',
    name: 'Priya Chandra',
    role: 'Founder & CEO',
    company: 'Chandra Capital',
    location: 'Manchester',
    tier: 'A',
    scores: { wealth: 8, timing: 9, accessibility: 8, complexity: 6 },
    total: 31,
    signals: [
      'Founded Chandra Capital 2018, scaled to £12m AUM',
      'Featured in FT wealth report Q3 2025',
      'Director of two charitable foundations',
      'Speaking at MIPIM 2026',
    ],
    signalExplain:
      'A founder who has scaled visibly, has charitable involvements (a wealth marker) and an upcoming high-profile speaking slot , a strong wealth signal combined with a clear accessibility window.',
    scoreReason: {
      wealth:
        '8/10. £12m AUM as a founder implies meaningful personal stake. Charity board roles reinforce the wealth profile.',
      timing:
        '9/10. Public speaking slot creates a natural touchpoint window. Recent FT feature indicates inflection point.',
      accessibility:
        '8/10. Public profile, active speaker, multiple LinkedIn engagements.',
      complexity:
        '6/10. As a fellow operator in financial services, conversations need to be high-substance from message one.',
    },
    outreach: {
      wealth_manager: {
        connection:
          'Hi Priya, I see we are both in the wealth advisory space in the North West. Would value being connected.',
        welcome:
          "Priya, thanks for connecting. Saw the FT piece on Chandra Capital , the growth from 2018 to £12m AUM is genuinely impressive. Curious about something: as you have scaled, are you finding the operational side of HNW onboarding harder to keep pace with the client wins, or has that part stayed manageable?",
        relationship:
          "Priya, thinking about what you said in the FT around growth , I came across a research note from the PIMFA practice management group on what mid-sized wealth firms typically rebuild between £10m and £25m AUM. The compliance-vs-growth tension shows up consistently. Want me to send the summary? Three pages, no sales angle attached.",
        moveOffline:
          "Priya, the PIMFA note I sent through got me thinking. Two founders I have spoken with this month brought up the same issue independently , onboarding compliance scaling slower than client wins. Your view would be genuinely useful given Chandra's trajectory. Would a 15-minute call in the next couple of weeks be worth your time, or is this not a current concern? Honest answer is best.",
      },
      financial_planner: {
        connection:
          'Hi Priya, I see we are both connected to the wealth advisory community in the North West. Would value being connected.',
        welcome:
          "Priya, thanks for connecting. Saw the FT piece , Chandra Capital's trajectory is impressive. Curious whether founders in your position typically have their own personal financial planning sorted, or whether that ends up being the bit that gets postponed? Asking because I see a clear pattern.",
        relationship:
          "Priya, came across something relevant to what you spoke about in the FT. The 2025 STEP report on founder-led wealth firms broke out how the personal-vs-business wealth boundary tends to blur between £10m and £30m AUM. The part on liquidity event planning was particularly sharp. Happy to send across.",
        moveOffline:
          "Priya, after the STEP piece, I have had short conversations with three founder-led firms at the £10m-£25m AUM stage. The personal financial planning side consistently gets put off. Would a 15-minute call in the next couple of weeks be useful, or is this not currently a priority? Either answer is fine.",
      },
      mortgage_broker: {
        connection:
          'Hi Priya, I see we are both in the financial services community in the North West. Would value being connected.',
        welcome:
          "Priya, thanks for connecting. Saw the FT piece on Chandra Capital. For founders at your stage, is property finance one of those things you handle through a broker network or have your clients tended to self-source? Asking because I see firms split very differently on this.",
        relationship:
          "Priya, came across the 2025 PWF report on how mid-sized wealth firms manage property-finance referrals , the part on referral partnership structures was particularly relevant. Happy to send across if useful.",
        moveOffline:
          "Priya, after the PWF piece, a few wealth firm founders I have spoken with said the property-finance side of their referral network is the part that gets least attention. Would a 15-minute call in the next couple of weeks be useful, or is this not currently a priority?",
      },
      other: {
        connection:
          'Hi Priya, I see we are both in the North West professional services community. Would value being connected.',
        welcome:
          "Priya, thanks for connecting. Saw the FT piece on Chandra Capital. Curious about what is on your radar now that the firm has reached that £12m AUM stage?",
        relationship:
          "Priya, came across a research note relevant to founder-led wealth firms in the £10m-£25m AUM range. Happy to send across.",
        moveOffline:
          "Priya, after the piece I shared, would a 15-minute call in the next couple of weeks be useful?",
      },
    },
  },
  {
    id: 'james',
    name: 'James Whitfield',
    role: 'CEO',
    company: 'Whitfield Group',
    location: 'Edinburgh',
    tier: 'B',
    scores: { wealth: 7, timing: 6, accessibility: 8, complexity: 6 },
    total: 27,
    signals: [
      'CEO of family-run holdings group with two active subsidiaries',
      'Recent Companies House filing shows director changes',
      'Based Edinburgh, frequent LinkedIn engagement',
    ],
    signalExplain:
      'Recent director changes often signal succession or restructuring activity , a natural inflection point for adjacent professional services. Combined with strong LinkedIn engagement, this is a workable contact.',
    scoreReason: {
      wealth:
        '7/10. Family holdings group is meaningfully sized but lacks the explicit retained-earnings signal seen in tier-A prospects.',
      timing:
        '6/10. Recent director changes are a positive signal but the trigger is moderate, not acute.',
      accessibility:
        '8/10. Active LinkedIn engagement, accepts connections, comments publicly.',
      complexity:
        '6/10. Family holdings introduce stakeholder dynamics that require more careful conversation framing.',
    },
    outreach: {
      wealth_manager: {
        connection:
          'Hi James, I see we are both in the Scottish family-business space. Would value being connected.',
        welcome:
          "James, thanks for connecting. Noticed Whitfield Group has gone through some director changes recently. Curious whether your next-generation involvement plans have come into focus yet, or whether that is still something the family is working through?",
        relationship:
          "James, came across a piece you may find relevant. The Institute for Family Business put out a 2025 report on succession in Scottish family holdings , the section on how three families handled director transitions without disrupting trading operations was particularly good. Want me to send across the relevant pages?",
        moveOffline:
          "James, after the IFB piece I sent, I have been comparing notes with a handful of family-business CEOs at a similar stage. The common thread is that succession planning gets framed as a one-time exercise when really it is a five-year process. Would a short call in the next couple of weeks be useful , or if now is not the right time, just say.",
      },
      financial_planner: {
        connection:
          'Hi James, I see we are both connected to the Scottish family-business community. Would value being connected.',
        welcome:
          "James, thanks for connecting. Noticed Whitfield Group has had some director changes. Curious whether the personal-financial-planning side of any transition is something the family has worked through, or whether that is still ahead?",
        relationship:
          "James, came across the 2025 IFB succession report , the part on how family CEOs separated personal financial planning from the business transition is genuinely useful. Want me to send across the relevant pages?",
        moveOffline:
          "James, after the IFB piece, two family CEOs I have spoken with raised the same question , whether their personal planning is keeping pace with the business transition. Would a short call in the next couple of weeks be useful?",
      },
      mortgage_broker: {
        connection:
          'Hi James, I see we are both connected to the Scottish business community. Would value being connected.',
        welcome:
          "James, thanks for connecting. Noticed Whitfield Group has had some changes recently. Curious whether the family has any property-finance moves on the cards (purchases, refinancing, restructuring), or whether the focus is entirely on the trading side?",
        relationship:
          "James, came across a useful 2025 PWF piece on how Scottish family holdings groups structured property finance through transition periods. Happy to send across.",
        moveOffline:
          "James, after the PWF piece, a few family-business owners I have spoken with said the property-finance side gets pushed to the back during transitions. Would a short call in the next couple of weeks be useful?",
      },
      other: {
        connection:
          'Hi James, I see we are both in the Scottish business community. Would value being connected.',
        welcome:
          "James, thanks for connecting. Noticed Whitfield Group has had some director changes. Curious how the next 12 months are shaping up for the group?",
        relationship:
          "James, came across the IFB succession report I think you may find useful. Want me to send across?",
        moveOffline:
          "James, after the IFB piece, would a short call in the next couple of weeks be worth doing?",
      },
    },
  },
  {
    id: 'sara',
    name: 'Sara Mendel',
    role: 'MD',
    company: 'Mendel Property',
    location: 'Bristol',
    tier: 'B',
    scores: { wealth: 6, timing: 7, accessibility: 7, complexity: 4 },
    total: 24,
    signals: [
      'MD of property development firm, 8 years tenure',
      'Multiple BTL portfolios visible in Companies House filings',
      'Active LinkedIn presence',
    ],
    signalExplain:
      'A property-focused MD with visible BTL portfolios , clear wealth signals in an asset class that responds well to specialist advice. Lower complexity makes for a clean conversation.',
    scoreReason: {
      wealth:
        '6/10. Property MD with multiple visible BTL portfolios is solid but not yet in the highest wealth bracket.',
      timing:
        '7/10. Post-April 2025 tax shifts have created an ongoing structural question for BTL holders.',
      accessibility:
        '7/10. Active LinkedIn, posts commentary on the sector.',
      complexity:
        '4/10. Clear, well-understood asset class. Easy to frame value quickly.',
    },
    outreach: {
      wealth_manager: {
        connection:
          'Hi Sara, I see we are both in the property and BTL space in the South West. Would value being connected.',
        welcome:
          "Sara, thanks for connecting. Saw your recent comments around BTL portfolio structuring. Curious whether the post-April tax shifts have actually changed how you and your clients are thinking about new acquisitions, or whether the structure question is fairly settled at this point?",
        relationship:
          "Sara, picked up something that may be useful. The Property Wealth Forum published a comparison of how thirty-plus BTL investors restructured ahead of April 2025. The takeaway on the £2m-£5m bracket caught my eye given Mendel's positioning. Happy to send the summary if helpful.",
        moveOffline:
          "Sara, since the Property Wealth Forum piece I sent over, I have been having short conversations with BTL-focused MDs on whether their current structure still holds up. Mendel's experience would be useful input. Would a quick 10-minute call work in the next week or so? If this is not a current priority, that is also a useful answer.",
      },
      financial_planner: {
        connection:
          'Hi Sara, I see we are both connected to the South West property community. Would value being connected.',
        welcome:
          "Sara, thanks for connecting. Saw your BTL commentary. Curious whether the personal financial planning side keeps pace with the business side , most property MDs I speak with say it does not.",
        relationship:
          "Sara, came across the 2025 PFS report on personal financial planning for property MDs , the part on segregating personal vs. business liquidity was particularly sharp. Happy to send across.",
        moveOffline:
          "Sara, after the PFS piece, a few property MDs I have spoken with said the personal-planning side has been parked for years. Would a quick 10-minute call in the next week be useful?",
      },
      mortgage_broker: {
        connection:
          'Hi Sara, I see we are both in the South West property and BTL space. Would value being connected.',
        welcome:
          "Sara, thanks for connecting. Saw your BTL commentary. Curious whether your current lending partners have kept pace with the post-April changes, or whether you are finding cases harder to place this year? Asking because I see a clear split.",
        relationship:
          "Sara, picked up something useful. The Property Wealth Forum's 2025 comparison of how thirty-plus BTL portfolios restructured ahead of April had a sharp section on lender appetite by portfolio size. The £2m-£5m bracket part caught my eye. Want me to send across?",
        moveOffline:
          "Sara, since the PWF piece, I have been comparing notes with BTL-focused MDs on which lenders are still meaningfully open for portfolio cases. Would a quick 10-minute call in the next week be useful?",
      },
      other: {
        connection:
          'Hi Sara, I see we are both in the South West property space. Would value being connected.',
        welcome:
          "Sara, thanks for connecting. Saw your BTL commentary. Curious how things are looking for the rest of the year?",
        relationship:
          "Sara, came across a useful piece on BTL portfolio structuring post-April 2025. Happy to send across.",
        moveOffline:
          "Sara, would a quick 10-minute call in the next week be useful?",
      },
    },
  },
  {
    id: 'tom',
    name: 'Tom Beresford',
    role: 'Director',
    company: 'Beresford & Co',
    location: 'Leeds',
    tier: 'C',
    scores: { wealth: 5, timing: 5, accessibility: 5, complexity: 4 },
    total: 19,
    signals: [
      'Single directorship, mid-sized consultancy',
      'Limited public financial signals',
    ],
    signalExplain:
      'Limited public wealth signals and a single directorship suggest this is a long-term-relationship prospect rather than a near-term opportunity , still worth a touch, but expectations should be set accordingly.',
    scoreReason: {
      wealth:
        '5/10. Single directorship with limited public financial information. Wealth is plausible but unverified.',
      timing:
        '5/10. No clear inflection trigger.',
      accessibility:
        '5/10. Standard LinkedIn presence, no strong signals of engagement.',
      complexity:
        '4/10. Generalist consultancy. Conversation can stay accessible.',
    },
    outreach: {
      wealth_manager: {
        connection:
          'Hi Tom, I see we are both in the Yorkshire professional services space. Would value being connected.',
        welcome:
          "Tom, thanks for connecting. Noticed Beresford & Co has been steady in the consultancy space. Curious how the next 12 months are shaping up for you? Asking because I am tracking a pattern across Yorkshire-based directors that I am not sure how to read yet.",
        relationship:
          "Tom, came across something you may find useful. The Yorkshire Business Confidence index for Q4 broke out professional services separately for the first time. Mixed picture, but a clear divide between those investing now and those waiting. Want me to send the summary?",
        moveOffline:
          "Tom, after the Yorkshire confidence piece I shared, a few owner-directors I have spoken with raised the same question , whether now is the time to invest or hold. Your read on it would help. Would a short call in the next couple of weeks be worth doing, or is this not a current focus? Either answer is fine.",
      },
      financial_planner: {
        connection:
          'Hi Tom, I see we are both in the Yorkshire professional services community. Would value being connected.',
        welcome:
          "Tom, thanks for connecting. Noticed Beresford & Co has been steady. Curious whether you have looked at your personal financial planning recently, or whether the focus has stayed entirely on the firm?",
        relationship:
          "Tom, came across the Yorkshire Business Confidence index for Q4 , the part on professional-services owner-director personal positions was useful context. Want me to send across?",
        moveOffline:
          "Tom, after the YBC piece, a few directors I have spoken with said they have not looked at their personal planning in years. Would a short call in the next couple of weeks be useful?",
      },
      mortgage_broker: {
        connection:
          'Hi Tom, I see we are both in the Yorkshire business community. Would value being connected.',
        welcome:
          "Tom, thanks for connecting. Noticed Beresford & Co has been steady. Curious whether property is on the agenda (personal or company-route), or whether the focus is entirely on the consultancy?",
        relationship:
          "Tom, came across the YBC Q4 index , useful context on owner-director property activity. Happy to send across.",
        moveOffline:
          "Tom, after the YBC piece, would a short call in the next couple of weeks be useful?",
      },
      other: {
        connection:
          'Hi Tom, I see we are both in the Yorkshire business community. Would value being connected.',
        welcome:
          "Tom, thanks for connecting. Noticed Beresford & Co. Curious how the rest of the year is shaping up?",
        relationship:
          "Tom, came across a useful Yorkshire Business Confidence piece. Happy to send across.",
        moveOffline:
          "Tom, would a short call in the next couple of weeks be useful?",
      },
    },
  },
]
/* ============================================================================
   Tour configuration
   ============================================================================ */

interface TourStep {
  screen: AppScreen
  highlight?: string
  title: string
  body: string
}

const TOUR_STEPS: TourStep[] = [
  {
    screen: 'role-gate',
    title: 'Tell us who you are',
    body:
      'ProspectIQ tailors its outreach to your role. Pick the one that fits you so the demo shows you content built for your kind of practice.',
  },
  {
    screen: 'dashboard',
    highlight: 'stats',
    title: 'Your home base',
    body:
      'The dashboard shows live counts of prospects researched and hours saved. Tap the cards to drill into the ROI view.',
  },
  {
    screen: 'dashboard',
    highlight: 'new-campaign',
    title: 'Start a campaign',
    body:
      'Tap + New campaign to describe your ideal client in plain English. The AI parses what you say and matches across three data sources.',
  },
  {
    screen: 'campaign-new',
    highlight: 'icp',
    title: 'Plain English ICP',
    body:
      'Type what your ideal client looks like, or pick a preset. No filters, no boolean logic, no Sales-Navigator complexity.',
  },
  {
    screen: 'campaign-new',
    highlight: 'find',
    title: 'Three sources, one search',
    body:
      'Companies House, FCA Register, and a global database of 270M+ LinkedIn-verified professionals. Tap Find prospects to run it.',
  },
  {
    screen: 'prospects',
    highlight: 'prospects-list',
    title: 'Scored A, B, C',
    body:
      'Each prospect is scored on wealth, timing, accessibility and complexity. A is your top tier. Tap a prospect to watch the AI work.',
  },
  {
    screen: 'researching',
    highlight: 'signals',
    title: 'AI research, live',
    body:
      'The AI reads wealth signals from Companies House, FCA Register, and LinkedIn, scoring each prospect on four dimensions in real time.',
  },
  {
    screen: 'outreach',
    highlight: 'messages',
    title: 'Four-message sequence',
    body:
      'Connection, welcome, value drop, then a soft move-offline. Spaced over 2-3 weeks. LINK Method, personalised to you and the prospect. Copy straight into LinkedIn.',
  },
  {
    screen: 'results',
    highlight: 'roi',
    title: 'Track the ROI',
    body:
      'See hours saved and the conversion funnel. That ends the tour. Explore freely or join the waitlist below.',
  },
]

/* ============================================================================
   Streaming animation hook
   ============================================================================ */

const STREAM_CPS = 60 // 60 characters per second

function useStreamingText(text: string, enabled: boolean, onComplete?: () => void) {
  const [displayed, setDisplayed] = useState('')
  const [isComplete, setIsComplete] = useState(false)
  const completeRef = useRef(onComplete)
  completeRef.current = onComplete

  useEffect(() => {
    if (!enabled) {
      setDisplayed('')
      setIsComplete(false)
      return
    }
    setDisplayed('')
    setIsComplete(false)
    if (!text) {
      setIsComplete(true)
      completeRef.current?.()
      return
    }
    const interval = 1000 / STREAM_CPS
    let i = 0
    const id = setInterval(() => {
      i += 1
      setDisplayed(text.slice(0, i))
      if (i >= text.length) {
        clearInterval(id)
        setIsComplete(true)
        completeRef.current?.()
      }
    }, interval)
    return () => clearInterval(id)
  }, [text, enabled])

  return { displayed, isComplete }
}

/* ============================================================================
   Helper for tier colours
   ============================================================================ */

function tierColour(t: Tier): string {
  return t === 'A' ? '#c49f8c' : t === 'B' ? '#a18d89' : 'rgba(251,249,244,0.45)'
}

/* ============================================================================
   Public event used by the /demo page to start the guided tour from the
   hero button that sits outside the phone. The tour state itself lives in
   this component so the embed variant needs no external controls.
   ============================================================================ */

export const PHONE_DEMO_START_TOUR_EVENT = 'prospectiq:start-tour'

/* ============================================================================
   PhoneDemo — the interactive phone demo, self-contained
   ============================================================================ */

type PhoneDemoVariant = 'page' | 'embed'

export default function PhoneDemo({ variant = 'page' }: { variant?: PhoneDemoVariant }) {
  // App state
  const [role, setRole] = useState<AdvisorRole | null>(null)
  const [screen, setScreen] = useState<AppScreen>('role-gate')
  const [icp, setIcp] = useState('')
  const [selectedProspectId, setSelectedProspectId] = useState<string | null>(null)
  const [revealedSignals, setRevealedSignals] = useState(0) // for backwards compat with non-streaming behaviour
  const [prospectFilter, setProspectFilter] = useState<'all' | Tier>('all')

  // Tour state
  const [tourActive, setTourActive] = useState(false)
  const [tourStep, setTourStep] = useState(0)

  const selectedProspect =
    MOCK_PROSPECTS.find((p) => p.id === selectedProspectId) || null

  // Auto-select Henry when entering screens that need a prospect, if none chosen
  useEffect(() => {
    if ((screen === 'researching' || screen === 'outreach') && !selectedProspectId) {
      setSelectedProspectId('henry')
    }
  }, [screen, selectedProspectId])

  // When researching screen is shown, reset signal counter (used by non-streaming components if any)
  useEffect(() => {
    if (screen === 'researching') {
      setRevealedSignals(0)
    }
  }, [screen, selectedProspectId])

  // When user clicks "Find prospects" → finding screen → after delay → prospects list
  useEffect(() => {
    if (screen === 'finding') {
      const t = setTimeout(() => setScreen('prospects'), 2200)
      return () => clearTimeout(t)
    }
  }, [screen])

  // Tour navigation
  const handleStartTour = useCallback(() => {
    setTourActive(true)
    setTourStep(0)
    setScreen(TOUR_STEPS[0].screen)
  }, [])

  // The /demo page triggers the tour from a button outside the phone
  useEffect(() => {
    const onStart = () => handleStartTour()
    window.addEventListener(PHONE_DEMO_START_TOUR_EVENT, onStart)
    return () => window.removeEventListener(PHONE_DEMO_START_TOUR_EVENT, onStart)
  }, [handleStartTour])

  const handleTourNext = useCallback(() => {
    const next = tourStep + 1
    if (next >= TOUR_STEPS.length) {
      setTourActive(false)
      return
    }
    setTourStep(next)
    setScreen(TOUR_STEPS[next].screen)
    // Auto-select Henry for tour screens that need a prospect
    if (
      (TOUR_STEPS[next].screen === 'researching' || TOUR_STEPS[next].screen === 'outreach') &&
      !selectedProspectId
    ) {
      setSelectedProspectId('henry')
    }
    // If tour requires a role and none chosen, default to wealth_manager
    if (TOUR_STEPS[next].screen !== 'role-gate' && !role) {
      setRole('wealth_manager')
    }
  }, [tourStep, role, selectedProspectId])

  const handleTourPrev = useCallback(() => {
    if (tourStep === 0) return
    const prev = tourStep - 1
    setTourStep(prev)
    setScreen(TOUR_STEPS[prev].screen)
  }, [tourStep])

  const handleTourClose = useCallback(() => {
    setTourActive(false)
  }, [])

  const isEmbed = variant === 'embed'
  const highlight = tourActive ? TOUR_STEPS[tourStep]?.highlight : undefined

  // The final tour step points at the waitlist form that sits below the phone
  // on /demo. Inside the embed there is no form below, so the wording changes.
  const activeTourStep = TOUR_STEPS[tourStep]
  const tourStepForPanel =
    isEmbed && tourStep === TOUR_STEPS.length - 1
      ? {
          ...activeTourStep,
          body:
            'See hours saved and the conversion funnel. That ends the tour. Explore freely, or join the waitlist.',
        }
      : activeTourStep

  const screens = (
    <>
      {screen === 'role-gate' && (
        <RoleGateScreen
          role={role}
          setRole={(r) => {
            setRole(r)
            setScreen('dashboard')
          }}
          showTourTrigger={isEmbed}
          onStartTour={handleStartTour}
        />
      )}
      {screen === 'dashboard' && (
        <DashboardScreen role={role} setScreen={setScreen} highlight={highlight} />
      )}
      {screen === 'campaign-new' && (
        <CampaignNewScreen
          role={role}
          icp={icp}
          setIcp={setIcp}
          setScreen={setScreen}
          highlight={highlight}
        />
      )}
      {screen === 'finding' && <FindingScreen />}
      {screen === 'prospects' && (
        <ProspectsScreen
          setScreen={setScreen}
          setSelectedProspectId={setSelectedProspectId}
          filter={prospectFilter}
          setFilter={setProspectFilter}
          highlight={highlight}
        />
      )}
      {screen === 'researching' && selectedProspect && (
        <ResearchingScreen
          prospect={selectedProspect}
          setScreen={setScreen}
          highlight={highlight}
        />
      )}
      {screen === 'outreach' && selectedProspect && role && (
        <OutreachScreen
          prospect={selectedProspect}
          role={role}
          setScreen={setScreen}
          highlight={highlight}
        />
      )}
      {screen === 'results' && (
        <ResultsScreen setScreen={setScreen} highlight={highlight} embed={isEmbed} />
      )}
    </>
  )

  const tourPanel = tourActive ? (
    <TourPanel
      step={tourStepForPanel}
      index={tourStep}
      total={TOUR_STEPS.length}
      onNext={handleTourNext}
      onPrev={handleTourPrev}
      onClose={handleTourClose}
    />
  ) : null

  // Embed variant: no bezel, no shadow, no rounded corners, no notch. The
  // parent site draws the phone shape around the iframe.
  if (isEmbed) {
    return (
      <>
        <div className="w-full h-full flex flex-col bg-[#171515]">
          {/* Status bar */}
          <div className="flex-shrink-0 h-10 flex items-center justify-between px-6 pt-2 text-[10px] text-[#fbf9f4]/90 font-medium">
            <span>9:41</span>
            <span className="opacity-0">.</span>
          </div>
          {/* Screen content */}
          <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain relative [&>div]:h-auto [&>div]:min-h-full">
            {screens}
          </div>
        </div>
        {tourPanel}
      </>
    )
  }

  return (
    <>
      <div className="relative w-[300px] h-[620px]">
        <div className="absolute inset-0 rounded-[48px] bg-gradient-to-b from-[#2a2626] to-[#0a0a0a] p-2.5 shadow-[0_30px_80px_-20px_rgba(196,159,140,0.32),0_0_0_1.5px_rgba(196,159,140,0.22)]">
          <div className="relative w-full h-full rounded-[40px] bg-[#171515] overflow-hidden">
            {/* Notch */}
            <div className="absolute top-2 left-1/2 -translate-x-1/2 w-24 h-6 bg-black rounded-full z-30" />
            {/* Status bar */}
            <div className="absolute top-0 left-0 right-0 h-10 z-20 flex items-center justify-between px-6 pt-2 text-[10px] text-[#fbf9f4]/90 font-medium">
              <span>9:41</span>
              <span className="opacity-0">.</span>
            </div>
            {/* Screen content */}
            <div className="pt-[42px] h-full overflow-hidden relative">
              {screens}
            </div>
          </div>
        </div>
      </div>
      {tourPanel}
    </>
  )
}

/* ============================================================================
   Role gate screen — first thing the user sees inside the phone
   ============================================================================ */

interface RoleGateProps {
  role: AdvisorRole | null
  setRole: (r: AdvisorRole) => void
  showTourTrigger?: boolean
  onStartTour?: () => void
}

function RoleGateScreen({ role, setRole, showTourTrigger, onStartTour }: RoleGateProps) {
  const options: AdvisorRole[] = [
    'wealth_manager',
    'financial_planner',
    'mortgage_broker',
    'other',
  ]

  return (
    <div className="p-4 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto flex flex-col">
      <div className="text-center mb-5 mt-2">
        <p className="text-[10px] tracking-[0.25em] uppercase text-[#c49f8c] mb-3">
          Welcome
        </p>
        <h2 className="font-serif text-2xl leading-tight mb-2">
          Which type of advisor are you?
        </h2>
        <p className="text-[11px] text-[#fbf9f4]/60 leading-relaxed">
          ProspectIQ tailors campaigns, prospects, and outreach to your role.
          Pick the one that fits. You can change it later.
        </p>
      </div>

      <div className="flex flex-col gap-2.5 mt-2">
        {options.map((r) => {
          const cfg = ROLE_CONFIG[r]
          const active = role === r
          return (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`text-left px-3.5 py-3 rounded-xl border transition-colors ${
                active
                  ? 'bg-[#c49f8c]/15 border-[#c49f8c]/60'
                  : 'bg-[#0a0a0a] border-[#c49f8c]/15 hover:border-[#c49f8c]/35'
              }`}
            >
              <p className="font-medium text-[12px]">{cfg.label}</p>
              <p className="text-[10px] text-[#fbf9f4]/55 mt-0.5 leading-snug">
                {cfg.audienceDescriptor}
              </p>
            </button>
          )
        })}
      </div>

      {showTourTrigger && onStartTour && (
        <button
          onClick={onStartTour}
          className="self-center mt-3.5 bg-transparent border-none p-0 text-[10px] text-[#c49f8c] underline underline-offset-2"
        >
          Take the guided tour
        </button>
      )}

      <p className="text-[9px] text-[#fbf9f4]/40 text-center mt-auto pt-4 leading-relaxed">
        Tap a role to continue. This shapes everything the AI surfaces next.
      </p>
    </div>
  )
}

/* ============================================================================
   Dashboard screen — role-aware campaigns
   ============================================================================ */

interface DashboardProps {
  role: AdvisorRole | null
  setScreen: (s: AppScreen) => void
  highlight?: string
}

function DashboardScreen({ role, setScreen, highlight }: DashboardProps) {
  const cfg = ROLE_CONFIG[role || 'wealth_manager']
  const totalProspects = cfg.campaigns.reduce((acc, c) => acc + c.count, 0)
  const newThisWeek = cfg.campaigns.reduce((acc, c) => acc + c.newThisWeek, 0)

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      {/* Stage context */}
      <StageBanner text={`Your live prospect intelligence overview for ${cfg.shortLabel}s`} />

      {/* Greeting */}
      <div className="flex items-center justify-between mb-3">
        <div>
          <p className="text-[9px] text-[#fbf9f4]/50 m-0">Good morning</p>
          <p className="font-serif text-[15px] m-0">Dan</p>
        </div>
        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-[#c49f8c] to-[#a18d89]" />
      </div>

      {/* Stats , clickable into ROI */}
      <button
        onClick={() => setScreen('results')}
        className={`w-full grid grid-cols-2 gap-1.5 mb-3 rounded-xl text-left ${
          highlight === 'stats' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        <div className="rounded-xl bg-[#0a0a0a] border border-[#c49f8c]/12 p-2.5">
          <p className="text-[8px] text-[#fbf9f4]/50 uppercase tracking-wider m-0">
            Prospects
          </p>
          <p className="font-serif text-[21px] m-0 mt-1">{totalProspects}</p>
          <p className="text-[9px] text-[#c49f8c] m-0">+{newThisWeek} this week</p>
        </div>
        <div className="rounded-xl bg-[#0a0a0a] border border-[#c49f8c]/12 p-2.5">
          <p className="text-[8px] text-[#fbf9f4]/50 uppercase tracking-wider m-0">
            Hours saved
          </p>
          <p className="font-serif text-[21px] m-0 mt-1">38</p>
          <p className="text-[9px] text-[#c49f8c] m-0">+6 this week</p>
        </div>
      </button>

      {/* Campaigns */}
      <p className="text-[9px] tracking-widest text-[#fbf9f4]/50 uppercase mb-1.5 mt-1">
        Active campaigns
      </p>
      <div className="mb-3 flex flex-col gap-1.5">
        {cfg.campaigns.map((c, i) => {
          const clickable = i === 0
          return (
            <button
              key={c.name}
              onClick={() => clickable && setScreen('prospects')}
              disabled={!clickable}
              className={`flex items-center justify-between px-2.5 py-2 rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 text-left ${
                clickable ? 'cursor-pointer hover:border-[#c49f8c]/35' : 'cursor-default'
              }`}
            >
              <div className="flex items-center gap-2">
                <span className="text-[9px] font-semibold w-4 h-4 rounded bg-[#c49f8c]/20 text-[#c49f8c] flex items-center justify-center">
                  {c.tier}
                </span>
                <span className="text-[10.5px]">{c.name}</span>
              </div>
              <span className="text-[9px] text-[#fbf9f4]/50">{c.count}</span>
            </button>
          )
        })}
      </div>

      {/* New campaign CTA */}
      <div
        className={`rounded-xl ${
          highlight === 'new-campaign' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        <button
          onClick={() => setScreen('campaign-new')}
          className="w-full px-3 py-2.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-[12px]"
        >
          + New campaign
        </button>
      </div>

      {/* Role change link */}
      <p className="text-[9px] text-[#fbf9f4]/35 text-center mt-3">
        Set up as a {cfg.shortLabel.toLowerCase()}.
      </p>
    </div>
  )
}

/* ============================================================================
   Reusable: stage context banner at top of each screen
   ============================================================================ */

function StageBanner({ text }: { text: string }) {
  return (
    <div className="mb-3 -mx-3.5 px-3.5 py-2 bg-[#0a0a0a]/40 border-b border-[#c49f8c]/8">
      <p className="text-[9px] text-[#c49f8c]/85 m-0 leading-snug">{text}</p>
    </div>
  )
}
/* ============================================================================
   Campaign new screen — role-aware presets
   ============================================================================ */

interface CampaignNewProps {
  role: AdvisorRole | null
  icp: string
  setIcp: (s: string) => void
  setScreen: (s: AppScreen) => void
  highlight?: string
}

function CampaignNewScreen({ role, icp, setIcp, setScreen, highlight }: CampaignNewProps) {
  const cfg = ROLE_CONFIG[role || 'wealth_manager']

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      <StageBanner text={`Tell the AI what your ideal ${cfg.shortLabel.toLowerCase()} client looks like`} />

      {/* Back nav */}
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={() => setScreen('dashboard')}
          className="text-[#c49f8c] text-xl bg-transparent border-none p-0 leading-none"
        >
          ‹
        </button>
        <p className="text-[10px] text-[#fbf9f4]/50 m-0">New campaign</p>
      </div>

      <h3 className="font-serif text-[16px] m-0 mb-3">Describe your ideal client</h3>

      <div
        className={`mb-3 rounded-lg ${
          highlight === 'icp' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        <textarea
          value={icp}
          onChange={(e) => setIcp(e.target.value)}
          placeholder={`e.g. ${cfg.presetICPs[0]}`}
          rows={4}
          className="w-full px-2.5 py-2 text-[10px] rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/20 text-[#fbf9f4] outline-none focus:border-[#c49f8c]/60 resize-none"
        />
      </div>

      <p className="text-[9px] text-[#fbf9f4]/50 mb-1.5">Or try a preset:</p>
      <div className="mb-3 flex flex-col gap-1">
        {cfg.presetICPs.map((p, i) => (
          <button
            key={i}
            onClick={() => setIcp(p)}
            className="text-left px-2 py-1.5 rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 text-[9px] text-[#fbf9f4]/85 hover:border-[#c49f8c]/30"
          >
            {p}
          </button>
        ))}
      </div>

      <p className="text-[9px] tracking-widest text-[#fbf9f4]/50 uppercase mb-1.5">
        Data source
      </p>
      <div className="flex flex-col gap-1 mb-3">
        {[
          { label: 'HNW Clients (UK)', badge: 'CH', active: true },
          { label: 'Financial Pros (UK)', badge: 'FCA', active: false },
          { label: 'Global Prospects', badge: '270M', active: false },
        ].map((s) => (
          <div
            key={s.label}
            className={`flex items-center justify-between px-2.5 py-2 rounded-lg border ${
              s.active
                ? 'bg-[#c49f8c]/10 border-[#c49f8c]/40'
                : 'bg-[#0a0a0a] border-[#c49f8c]/12'
            }`}
          >
            <span className="text-[10px]">{s.label}</span>
            <span className="text-[8px] px-1.5 py-0.5 rounded bg-[#c49f8c]/20 text-[#c49f8c] font-semibold">
              {s.badge}
            </span>
          </div>
        ))}
      </div>

      <div
        className={`rounded-xl ${
          highlight === 'find' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        <button
          onClick={() => icp.trim() && setScreen('finding')}
          disabled={!icp.trim()}
          className={`w-full px-3 py-2.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-[12px] ${
            !icp.trim() ? 'opacity-40 cursor-not-allowed' : ''
          }`}
        >
          Find prospects →
        </button>
      </div>
    </div>
  )
}

/* ============================================================================
   Finding screen — searching animation
   ============================================================================ */

function FindingScreen() {
  const steps = [
    'Parsing your ICP',
    'Searching Companies House',
    'Cross-referencing FCA Register',
    'Scoring wealth signals',
  ]
  const [done, setDone] = useState<boolean[]>(steps.map(() => false))

  useEffect(() => {
    const timers = steps.map((_, i) =>
      setTimeout(() => {
        setDone((prev) => prev.map((v, idx) => (idx === i ? true : v)))
      }, 350 * (i + 1))
    )
    return () => timers.forEach(clearTimeout)
  }, [])

  return (
    <div className="h-full bg-[#171515] text-[#fbf9f4] flex flex-col items-center justify-center px-6">
      <div className="relative w-12 h-12 mb-4">
        <div className="absolute inset-0 rounded-full border-2 border-[#c49f8c]/20" />
        <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-[#c49f8c] animate-spin" />
      </div>
      <p className="font-serif text-[16px] m-0 mb-1">Finding prospects</p>
      <p className="text-[10px] text-[#fbf9f4]/60 text-center leading-snug mb-4">
        Searching Companies House, FCA Register, and 270M+ verified professionals
      </p>
      <div className="w-full">
        {steps.map((label, i) => (
          <div
            key={label}
            className={`flex items-center gap-2 text-[9px] mb-1.5 transition-opacity duration-500 ${
              done[i] ? 'opacity-100' : 'opacity-40'
            }`}
          >
            <span className={done[i] ? 'text-[#c49f8c]' : 'text-[#fbf9f4]/30'}>
              {done[i] ? '✓' : '○'}
            </span>
            <span className={done[i] ? 'text-[#fbf9f4]/85' : 'text-[#fbf9f4]/40'}>
              {label}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ============================================================================
   Prospects screen — list of scored prospects
   ============================================================================ */

interface ProspectsProps {
  setScreen: (s: AppScreen) => void
  setSelectedProspectId: (id: string | null) => void
  filter: 'all' | Tier
  setFilter: (f: 'all' | Tier) => void
  highlight?: string
}

function ProspectsScreen({
  setScreen,
  setSelectedProspectId,
  filter,
  setFilter,
  highlight,
}: ProspectsProps) {
  const filtered = filter === 'all' ? MOCK_PROSPECTS : MOCK_PROSPECTS.filter((p) => p.tier === filter)

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      <StageBanner text="AI-scored leads, tiered A/B/C by wealth signals" />

      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => setScreen('dashboard')}
            className="text-[#c49f8c] text-xl bg-transparent border-none p-0 leading-none"
          >
            ‹
          </button>
          <h3 className="font-serif text-[13px] m-0">HNW Directors</h3>
        </div>
        <span className="text-[9px] text-[#fbf9f4]/50">{filtered.length} of {MOCK_PROSPECTS.length}</span>
      </div>

      {/* Filter pills */}
      <div className="flex gap-1 mb-2.5">
        {(['all', 'A', 'B', 'C'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setFilter(t)}
            className={`text-[9px] px-2.5 py-1 rounded-full ${
              filter === t
                ? 'bg-[#c49f8c] text-[#0a0a0a] font-semibold'
                : 'bg-[#0a0a0a] border border-[#c49f8c]/20 text-[#fbf9f4]/75'
            }`}
          >
            {t === 'all' ? 'All' : t}
          </button>
        ))}
      </div>

      <div
        className={`rounded-lg ${
          highlight === 'prospects-list' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        {filtered.map((p) => {
          const initials = p.name.split(' ').map((n) => n[0]).join('')
          return (
            <button
              key={p.id}
              onClick={() => {
                setSelectedProspectId(p.id)
                setScreen('researching')
              }}
              className="w-full text-left flex items-center gap-2 px-2.5 py-2 rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 mb-1.5 text-[#fbf9f4] hover:border-[#c49f8c]/30"
            >
              <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#c49f8c] to-[#a18d89] flex items-center justify-center text-[10px] font-semibold text-[#0a0a0a] flex-shrink-0">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-[10.5px] m-0 truncate">{p.name}</p>
                <p className="text-[9px] text-[#fbf9f4]/50 m-0 truncate">
                  {p.role}, {p.company}
                </p>
                <p className="text-[9px] text-[#fbf9f4]/40 m-0">{p.location}</p>
              </div>
              <div className="flex flex-col items-end">
                <span
                  className="text-[10px] font-bold"
                  style={{ color: tierColour(p.tier) }}
                >
                  {p.tier}
                </span>
                <span className="text-[9px] text-[#fbf9f4]/40">{p.total}</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
/* ============================================================================
   Researching screen — streams signals one by one, shows score with explanation
   ============================================================================ */

interface ResearchingProps {
  prospect: MockProspect
  setScreen: (s: AppScreen) => void
  highlight?: string
}

function ResearchingScreen({ prospect, setScreen, highlight }: ResearchingProps) {
  const [currentSignal, setCurrentSignal] = useState(0)
  const [streamingDone, setStreamingDone] = useState(false)
  const initials = prospect.name.split(' ').map((n) => n[0]).join('')

  const isLastSignal = currentSignal >= prospect.signals.length - 1
  const currentText = prospect.signals[currentSignal] || ''

  const handleSignalComplete = useCallback(() => {
    if (isLastSignal) {
      setStreamingDone(true)
      // No auto-advance, user clicks "Create outreach" button to move forward.
    } else {
      const t = setTimeout(() => setCurrentSignal((s) => s + 1), 200)
      return () => clearTimeout(t)
    }
  }, [isLastSignal])

  const { displayed } = useStreamingText(currentText, true, handleSignalComplete)

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      <StageBanner text="AI analysing this prospect's wealth indicators" />

      {/* Prospect header */}
      <div className="flex items-center gap-2.5 mb-3">
        <div className="w-11 h-11 rounded-full bg-gradient-to-br from-[#c49f8c] to-[#a18d89] flex items-center justify-center text-[12px] font-semibold text-[#0a0a0a]">
          {initials}
        </div>
        <div>
          <p className="text-[11.5px] font-medium m-0">{prospect.name}</p>
          <p className="text-[9px] text-[#fbf9f4]/60 m-0">
            {prospect.role}, {prospect.company}
          </p>
        </div>
      </div>

      {/* AI status line */}
      <div className="flex items-center gap-2 mb-2.5">
        <div className="relative w-3.5 h-3.5">
          <div className="absolute inset-0 rounded-full border border-[#c49f8c]/20" />
          {!streamingDone && (
            <div className="absolute inset-0 rounded-full border border-transparent border-t-[#c49f8c] animate-spin" />
          )}
        </div>
        <p className="text-[9px] text-[#c49f8c] tracking-widest uppercase m-0">
          {streamingDone ? 'Research complete' : 'Researching with AI'}
        </p>
      </div>

      <p className="text-[8px] tracking-widest uppercase text-[#fbf9f4]/50 mb-2">
        Wealth signals
      </p>

      <div className={`${highlight === 'signals' ? 'rounded-lg ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''}`}>
        {prospect.signals.map((signal, i) => {
          const isCurrent = i === currentSignal
          const isPast = i < currentSignal || streamingDone
          if (i > currentSignal) return null

          return (
            <div
              key={i}
              className="px-2.5 py-2 rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 mb-1.5"
            >
              <p className="text-[9px] leading-snug m-0">
                <span className="text-[#c49f8c] mr-1">+</span>
                <span className="text-[#fbf9f4]/90">
                  {isCurrent && !streamingDone ? displayed : signal}
                  {isCurrent && !streamingDone && displayed.length < signal.length && (
                    <span className="inline-block w-1 h-2.5 bg-[#c49f8c] ml-0.5 align-middle animate-pulse" />
                  )}
                </span>
              </p>
            </div>
          )
        })}
      </div>

      {/* Why these signals (only after streaming is done) */}
      {streamingDone && (
        <div className="mt-2.5 p-2.5 rounded-lg bg-[#0a0a0a]/60 border border-[#c49f8c]/15 animate-[piqFade_0.4s_ease-out]">
          <p className="text-[8px] tracking-widest uppercase text-[#fbf9f4]/50 mb-1">
            Why these signals matter
          </p>
          <p className="text-[9px] leading-snug text-[#fbf9f4]/75 m-0">
            {prospect.signalExplain}
          </p>
        </div>
      )}

      {/* Score panel (only after streaming done) */}
      {streamingDone && (
        <div className="mt-3 rounded-xl bg-gradient-to-br from-[#c49f8c]/20 to-transparent border border-[#c49f8c]/30 p-3 animate-[piqFade_0.5s_ease-out]">
          <p className="text-[8px] text-[#c49f8c] tracking-widest uppercase m-0 mb-1">
            Tier {prospect.tier} &middot; Score {prospect.total}/40
          </p>
          <div className="grid grid-cols-4 gap-1.5 mt-1.5">
            {(['wealth', 'timing', 'accessibility', 'complexity'] as const).map((k) => {
              const labels = {
                wealth: 'Wealth',
                timing: 'Timing',
                accessibility: 'Access',
                complexity: 'Complex',
              }
              return (
                <div key={k} className="text-center">
                  <p className="font-serif text-[18px] m-0">{prospect.scores[k]}</p>
                  <p className="text-[7px] text-[#fbf9f4]/50 uppercase tracking-wider m-0">
                    {labels[k]}
                  </p>
                </div>
              )
            })}
          </div>

          {/* Always-visible score reasons */}
          <div className="mt-2.5 pt-2.5 border-t border-[#c49f8c]/15 flex flex-col gap-1.5">
            <ScoreReasonRow label="Wealth" value={prospect.scoreReason.wealth} />
            <ScoreReasonRow label="Timing" value={prospect.scoreReason.timing} />
            <ScoreReasonRow label="Access" value={prospect.scoreReason.accessibility} />
            <ScoreReasonRow label="Complex" value={prospect.scoreReason.complexity} />
          </div>

          <p className="text-[8px] text-[#fbf9f4]/45 mt-2.5 mb-0 leading-snug">
            Tiers: A = 30+ (top priority) &middot; B = 22–29 &middot; C = under 22
          </p>
        </div>
      )}

      {/* Manual progression to outreach — replaces previous auto-advance */}
      {streamingDone && (
        <button
          onClick={() => setScreen('outreach')}
          className="w-full mt-3 py-2.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-[12px] border-none animate-[piqFade_0.5s_ease-out] tracking-wide"
        >
          Create outreach →
        </button>
      )}
    </div>
  )
}

function ScoreReasonRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[7.5px] tracking-widest uppercase text-[#c49f8c]/80 m-0">{label}</p>
      <p className="text-[9px] text-[#fbf9f4]/75 leading-snug m-0">{value}</p>
    </div>
  )
}

/* ============================================================================
   Outreach screen — streams 4 messages, role-aware
   ============================================================================ */

interface OutreachProps {
  prospect: MockProspect
  role: AdvisorRole
  setScreen: (s: AppScreen) => void
  highlight?: string
}

function OutreachScreen({ prospect, role, setScreen, highlight }: OutreachProps) {
  const messages = prospect.outreach[role]
  const sequence = [
    { stage: '1. Connection request', timing: 'Day 1', text: messages.connection, why: 'Common ground only. No pitch, no results claims , keeps the connection rate high.' },
    { stage: '2. Welcome', timing: 'After they accept', text: messages.welcome, why: 'Rapport plus an illumination question. Designed to start a real conversation, not a sales pitch.' },
    { stage: '3. Value drop', timing: '+1 week', text: messages.relationship, why: 'Shares a specific named resource. No ask. Builds reciprocity (Cialdini) before any request.' },
    { stage: '4. Move offline', timing: '+2 weeks', text: messages.moveOffline, why: 'A temperature check, not a hard ask. Gives an explicit honest-out so the prospect feels in control.' },
  ]

  const initials = prospect.name.split(' ').map((n) => n[0]).join('')
  const [currentMsg, setCurrentMsg] = useState(0)
  const [allDone, setAllDone] = useState(false)
  const [copied, setCopied] = useState(false)

  const isLast = currentMsg >= sequence.length - 1
  const currentText = sequence[currentMsg]?.text || ''

  const handleMsgComplete = useCallback(() => {
    if (isLast) {
      setAllDone(true)
    } else {
      const t = setTimeout(() => setCurrentMsg((m) => m + 1), 350)
      return () => clearTimeout(t)
    }
  }, [isLast])

  const { displayed } = useStreamingText(currentText, true, handleMsgComplete)

  const handleCopy = () => {
    const all = sequence
      .map((m) => `${m.stage.toUpperCase()}\n${m.text}`)
      .join('\n\n')
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(all).catch(() => {})
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      <StageBanner text={`LINK Method sequence, written for a ${ROLE_CONFIG[role].shortLabel.toLowerCase()}`} />

      <div className="flex items-center gap-1.5 mb-2.5">
        <button
          onClick={() => setScreen('prospects')}
          className="text-[#c49f8c] text-xl bg-transparent border-none p-0 leading-none"
        >
          ‹
        </button>
        <div className="w-6 h-6 rounded-full bg-gradient-to-br from-[#c49f8c] to-[#a18d89] flex items-center justify-center text-[9px] font-semibold text-[#0a0a0a]">
          {initials}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-[10px] font-medium m-0 truncate">{prospect.name}</p>
          <p className="text-[8px] text-[#fbf9f4]/50 m-0">
            Tier {prospect.tier} &middot; Score {prospect.total}
          </p>
        </div>
      </div>

      <p className="text-[8px] tracking-widest uppercase text-[#c49f8c] m-0 mb-2">
        LINK Method &middot; 4-message sequence
      </p>

      <div className={`${highlight === 'messages' ? 'rounded-lg ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''}`}>
        {sequence.map((msg, i) => {
          const isCurrent = i === currentMsg
          const isPast = i < currentMsg
          const isStreaming = isCurrent && !allDone && displayed.length < msg.text.length
          if (i > currentMsg) return null

          return (
            <div
              key={i}
              className="rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/15 p-2 mb-1.5"
            >
              <div className="flex justify-between items-center mb-1">
                <p className="text-[7.5px] uppercase tracking-widest text-[#c49f8c]/85 m-0">
                  {msg.stage}
                </p>
                <p className="text-[7.5px] text-[#fbf9f4]/40 m-0">
                  {msg.timing} &middot; {msg.text.length} chars
                </p>
              </div>
              <p className="text-[9px] leading-relaxed text-[#fbf9f4]/90 m-0">
                {isStreaming ? displayed : msg.text}
                {isStreaming && (
                  <span className="inline-block w-1 h-2.5 bg-[#c49f8c] ml-0.5 align-middle animate-pulse" />
                )}
              </p>
              {(isPast || (isCurrent && allDone)) && (
                <p className="text-[7.5px] text-[#fbf9f4]/45 mt-1 mb-0 italic leading-snug">
                  {msg.why}
                </p>
              )}
            </div>
          )
        })}
      </div>

      {allDone && (
        <div className="mt-2 animate-[piqFade_0.4s_ease-out]">
          <button
            onClick={handleCopy}
            className="w-full py-2.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-[11px] border-none tracking-wide"
          >
            {copied ? '✓ Sequence queued' : 'Send sequence'}
          </button>
          <p className="text-[8px] text-[#fbf9f4]/55 mt-1.5 mb-0 text-center leading-snug">
            {copied
              ? 'Connection on Day 1, messages 2-4 spaced across 21 days.'
              : 'Auto-sent via your connected LinkedIn account, spaced across 21 days.'}
          </p>
          <p className="text-[8px] text-[#fbf9f4]/40 mt-1 mb-0 text-center">
            <span style={{ textDecoration: 'underline', cursor: 'pointer' }}>Send manually instead</span>
          </p>
        </div>
      )}
    </div>
  )
}

/* ============================================================================
   Results screen — ROI summary
   ============================================================================ */

interface ResultsProps {
  setScreen: (s: AppScreen) => void
  highlight?: string
  embed?: boolean
}

function ResultsScreen({ setScreen, highlight, embed }: ResultsProps) {
  const funnel = [
    { label: 'Contacted', percent: 100, value: '247' },
    { label: 'Connected', percent: 42, value: '104' },
    { label: 'Replied', percent: 18, value: '44' },
    { label: 'Booked', percent: 6, value: '14' },
  ]

  return (
    <div className="p-3.5 h-full bg-[#171515] text-[#fbf9f4] overflow-y-auto">
      <StageBanner text="What you've gained vs. doing this manually" />

      <div className="flex items-center gap-1.5 mb-1.5">
        <button
          onClick={() => setScreen('dashboard')}
          className="text-[#c49f8c] text-xl bg-transparent border-none p-0 leading-none"
        >
          ‹
        </button>
        <p className="text-[10px] text-[#fbf9f4]/50 m-0">This month</p>
      </div>

      <h3 className="font-serif text-[16px] m-0 mb-3">Your ROI</h3>

      <div
        className={`rounded-xl ${
          highlight === 'roi' ? 'ring-2 ring-[#c49f8c] ring-offset-2 ring-offset-[#171515]' : ''
        }`}
      >
        <div className="rounded-xl bg-gradient-to-br from-[#c49f8c]/20 to-transparent border border-[#c49f8c]/30 p-3 mb-2">
          <p className="text-[9px] tracking-widest uppercase text-[#c49f8c] m-0 mb-0.5">
            Hours saved
          </p>
          <p className="font-serif text-[34px] m-0">38.5</p>
          <p className="text-[9px] text-[#fbf9f4]/60 m-0 mt-0.5">vs. manual research</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-1.5 mb-2">
        <div className="rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 p-2.5">
          <p className="text-[8px] text-[#fbf9f4]/50 uppercase m-0">Prospects</p>
          <p className="font-serif text-[17px] m-0">247</p>
        </div>
        <div className="rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 p-2.5">
          <p className="text-[8px] text-[#fbf9f4]/50 uppercase m-0">A-tier</p>
          <p className="font-serif text-[17px] m-0">71</p>
        </div>
      </div>

      <div className="rounded-lg bg-[#0a0a0a] border border-[#c49f8c]/12 p-2.5">
        <p className="text-[8px] text-[#fbf9f4]/50 uppercase m-0 mb-1.5">Conversion funnel</p>
        {funnel.map((f) => (
          <div key={f.label} className="mb-1.5">
            <div className="flex justify-between text-[8px] mb-0.5">
              <span className="text-[#fbf9f4]/60">{f.label}</span>
              <span className="text-[#fbf9f4]/85">{f.value}</span>
            </div>
            <div className="h-1 rounded-full bg-[#171515] overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-[#c49f8c] to-[#a18d89] rounded-full transition-all duration-700"
                style={{ width: `${f.percent}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Embed only: the waitlist form lives on the full /demo page, so break
          out of the iframe rather than loading it inside the phone frame. */}
      {embed && (
        <a
          href="https://prospectiq.aiwealthpartners.co.uk/demo#waitlist"
          target="_top"
          className="block w-full text-center no-underline mt-3 py-2.5 rounded-xl bg-[#c49f8c] text-[#0a0a0a] font-semibold text-[12px] tracking-wide"
        >
          Join the waitlist →
        </a>
      )}
    </div>
  )
}
/* ============================================================================
   Tour panel — bottom-floating
   ============================================================================ */

interface TourPanelProps {
  step: TourStep
  index: number
  total: number
  onNext: () => void
  onPrev: () => void
  onClose: () => void
}

function TourPanel({ step, index, total, onNext, onPrev, onClose }: TourPanelProps) {
  return (
    <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-2rem)] max-w-md rounded-2xl bg-[#222020]/95 border border-[#c49f8c]/40 p-5 backdrop-blur-md shadow-[0_20px_60px_-10px_rgba(0,0,0,0.6)]">
      <div className="flex justify-between items-start mb-2">
        <span className="text-[10px] tracking-[0.15em] uppercase text-[#c49f8c]">
          Step {index + 1} of {total}
        </span>
        <button
          onClick={onClose}
          className="text-[#fbf9f4]/40 bg-transparent border-none text-lg leading-none"
        >
          ×
        </button>
      </div>
      <h4 className="font-serif text-[19px] m-0 mb-1.5">{step.title}</h4>
      <p className="text-[13px] leading-relaxed text-[#fbf9f4]/75 m-0 mb-3.5">{step.body}</p>
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={onPrev}
          disabled={index === 0}
          className={`text-[13px] text-[#fbf9f4]/60 bg-transparent border-none ${
            index === 0 ? 'opacity-30 cursor-not-allowed' : ''
          }`}
        >
          ‹ Previous
        </button>
        <div className="flex gap-1.5">
          {Array.from({ length: total }).map((_, i) => (
            <span
              key={i}
              className={`w-1.5 h-1.5 rounded-full ${
                i === index ? 'bg-[#c49f8c]' : 'bg-[#fbf9f4]/20'
              }`}
            />
          ))}
        </div>
        <button
          onClick={onNext}
          className="text-[13px] bg-[#c49f8c] text-[#0a0a0a] font-semibold border-none px-3.5 py-1.5 rounded-full"
        >
          {index === total - 1 ? 'Finish' : 'Next ›'}
        </button>
      </div>
    </div>
  )
}
