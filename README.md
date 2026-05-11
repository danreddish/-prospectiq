# ProspectIQ

AI-Powered HNW Prospect Intelligence Platform by AI Wealth Partners.

Turn any LinkedIn profile into a scored prospect dossier with personalised outreach messages in under 60 seconds.

## Tech Stack

- **Frontend**: Next.js 14 (App Router), Tailwind CSS, shadcn/ui
- **Database**: Supabase (PostgreSQL + Auth + Row Level Security)
- **Payments**: Stripe (Checkout, Webhooks, Customer Portal)
- **AI Engine**: Anthropic Claude API (Sonnet) for prospect research
- **Hosting**: Vercel (recommended) or Netlify

## Getting Started

### 1. Prerequisites

- Node.js 18+
- A Supabase account (free tier works for MVP)
- A Stripe account (test mode)
- An Anthropic API key

### 2. Clone and install

```bash
git clone <your-repo-url>
cd prospectiq
npm install
```

### 3. Environment variables

```bash
cp .env.example .env.local
```

Fill in all values in `.env.local`. See `.env.example` for descriptions.

### 4. Database setup

1. Create a new project in Supabase
2. Go to SQL Editor
3. Paste the contents of `supabase/schema.sql` and run it
4. Enable Google OAuth in Supabase Auth settings (optional)

### 5. Stripe setup

1. Create products and prices in Stripe Dashboard:
   - Starter Monthly: £97/month
   - Starter Annual: £970/year
   - Professional Monthly: £197/month
   - Professional Annual: £1,970/year
   - Growth Monthly: £397/month
   - Growth Annual: £3,970/year
2. Copy each Price ID into your `.env.local`
3. Set up a webhook endpoint: `https://your-domain.com/api/stripe/webhook`
4. Events to listen for:
   - `checkout.session.completed`
   - `customer.subscription.created`
   - `customer.subscription.updated`
   - `customer.subscription.deleted`
   - `invoice.payment_failed`

### 6. Fonts

Copy `derringer-serial-regular.ttf` to `public/fonts/`.

### 7. Run locally

```bash
npm run dev
```

In a separate terminal, forward Stripe webhooks:

```bash
npm run stripe:listen
```

### 8. Deploy to Vercel

```bash
npx vercel
```

Set all environment variables in Vercel Dashboard > Settings > Environment Variables.

## Project Structure

```
prospectiq/
├── app/
│   ├── api/
│   │   ├── stripe/
│   │   │   ├── checkout/route.ts    # Creates Stripe Checkout sessions
│   │   │   └── webhook/route.ts     # Handles Stripe webhook events
│   │   └── prospects/
│   │       └── research/route.ts    # AI research endpoint
│   ├── auth/
│   │   ├── callback/route.ts        # Supabase auth callback
│   │   ├── login/page.tsx           # Login page
│   │   ├── signup/page.tsx          # Signup + free trial
│   │   └── signout/route.ts         # Sign out
│   ├── dashboard/
│   │   ├── layout.tsx               # Dashboard layout with sidebar
│   │   ├── page.tsx                 # Dashboard home
│   │   ├── campaigns/
│   │   │   ├── page.tsx             # Create campaign + add prospects
│   │   │   └── [id]/
│   │   │       ├── page.tsx         # Campaign server component
│   │   │       └── campaign-dashboard.tsx  # Interactive dashboard UI
│   │   └── settings/
│   │       └── page.tsx             # Profile + billing
│   ├── layout.tsx                   # Root layout
│   └── globals.css                  # Tailwind + custom styles
├── lib/
│   ├── ai-engine.ts                 # Claude API integration
│   ├── stripe.ts                    # Stripe helpers
│   └── supabase/
│       ├── client.ts                # Browser Supabase client
│       └── server.ts                # Server Supabase client
├── types/
│   └── index.ts                     # TypeScript types + plan config
├── supabase/
│   └── schema.sql                   # Complete database schema
├── middleware.ts                     # Auth protection + session refresh
├── tailwind.config.ts               # AIWP brand colours
└── .env.example                     # Environment variable template
```

## Key Flows

### User Signs Up
1. User fills signup form → Supabase creates auth user
2. Database trigger creates profile row automatically
3. User confirms email → redirected to `/dashboard`
4. Profile starts on `free` tier (3 prospects/month)

### User Researches Prospects
1. User creates a campaign (name, niche, sender name)
2. Adds prospects manually or via CSV upload
3. Clicks "Research" → `POST /api/prospects/research`
4. API checks usage limits → calls Claude for each prospect
5. Claude returns structured JSON (scores, research, outreach)
6. Results stored in `prospects` table → dashboard renders them

### User Upgrades
1. User clicks "Upgrade" in settings → `POST /api/stripe/checkout`
2. Redirect to Stripe Checkout (7-day trial included)
3. On success, Stripe webhook fires → updates profile plan tier
4. Usage limits increase immediately

## Phase 2 Roadmap (Post-MVP)

- [ ] Background job processing (Inngest/Trigger.dev) for large batches
- [ ] PDF export of campaign dashboards
- [ ] CSV export of outreach messages
- [ ] Shareable campaign links (public read-only dashboards)
- [ ] Custom scoring dimensions per campaign
- [ ] CRM integrations (Salesforce, Redtail, Wealthbox)
- [ ] Team/multi-seat accounts
- [ ] Referral programme
- [ ] Landing page with interactive demo dashboard
