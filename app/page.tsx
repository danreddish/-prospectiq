import Link from 'next/link'
import HeroVideo from './components/HeroVideo'
import TypingHero from './components/TypingHero'

export default function HomePage() {
  const plans = [
    {
      name: 'Starter',
      price: 97,
      annual: 970,
      pop: false,
      prospects: '25',
      features: ['25 prospects/month', '2 active campaigns', '3-step outreach sequences', 'PDF export', 'Email support'],
    },
    {
      name: 'Professional',
      price: 197,
      annual: 1970,
      pop: true,
      prospects: '100',
      features: ['100 prospects/month', '10 active campaigns', 'Custom outreach templates', 'PDF + CSV export', 'Email + monthly group call'],
    },
    {
      name: 'Growth',
      price: 397,
      annual: 3970,
      pop: false,
      prospects: '300',
      features: ['300 prospects/month', 'Unlimited campaigns', 'A/B outreach variants', 'All export formats', 'Priority + strategy call'],
    },
  ]

  return (
    <div className="min-h-screen bg-brand-dark">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-brand-dark/90 backdrop-blur-md border-b border-brand-charcoal-deep">
        <div className="max-w-6xl mx-auto px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <span className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">
              AI Wealth Partners
            </span>
            <span className="text-brand-charcoal text-lg">|</span>
            <span className="text-brand-cream text-xl font-display">ProspectIQ</span>
          </div>
          <div className="flex items-center gap-6">
            <a href="/demo" className="text-brand-beige text-sm hover:text-brand-cream transition-colors hidden sm:inline">
              Live Demo
            </a>
            <a href="#pricing" className="text-brand-beige text-sm hover:text-brand-cream transition-colors hidden sm:inline">
              Pricing
            </a>
            <Link href="/auth/login" className="text-brand-beige text-sm hover:text-brand-cream transition-colors">
              Sign In
            </Link>
            <Link href="/auth/signup" className="btn-primary text-sm">
              Start Free Trial
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="pt-32 pb-20 px-8 relative overflow-hidden">
        <div
          className="absolute inset-0 opacity-[0.03]"
          style={{
            backgroundImage: `linear-gradient(#5d5d5d 1px, transparent 1px), linear-gradient(90deg, #5d5d5d 1px, transparent 1px)`,
            backgroundSize: '60px 60px',
          }}
        />
        <div className="absolute -top-40 -right-20 w-[600px] h-[600px] rounded-full bg-brand-rose-gold/5 blur-3xl" />
        <HeroVideo />

        <div className="max-w-6xl mx-auto relative">
          <div className="max-w-2xl">
            <img
              src="/prospectiq-logo.png"
              alt="ProspectIQ"
              width={220}
              height={60}
              style={{ display: 'block', marginBottom: 24 }}
            />
            <span className="inline-block bg-gradient-to-r from-brand-rose-gold to-brand-rose-gold-light text-brand-dark px-3.5 py-1 rounded-full text-[11px] font-bold tracking-wider uppercase">
              Now in Beta
            </span>

            <h1 className="text-5xl font-display text-brand-cream mt-7 leading-tight tracking-wide">
              Find High-Net-Worth Clients{' '}
              <span className="text-brand-rose-gold">Before Your Competitors Do</span>
            </h1>

            <TypingHero />

            <p className="text-brand-beige text-lg mt-6 leading-relaxed max-w-xl">
              ProspectIQ finds real directors, executives, and business owners from verified public data sources worldwide. Scores them by wealth signals. Generates personalised outreach sequences you can send today. Built for wealth managers, IFAs, and mortgage brokers.
            </p>

            <div className="flex gap-4 mt-10">
              <Link href="/auth/signup" className="btn-primary text-base">
                Start Free Trial
              </Link>
              <a href="#how-it-works" className="btn-secondary text-base">
                See It In Action
              </a>
            </div>

            <div className="flex gap-10 mt-12">
              {[
                { metric: '270M+', label: 'Verified professionals worldwide' },
                { metric: '200+', label: 'Countries covered' },
                { metric: '3-Step', label: 'Ready-to-send outreach' },
              ].map((s) => (
                <div key={s.label}>
                  <p className="text-brand-rose-gold text-xl font-display">{s.metric}</p>
                  <p className="text-brand-beige text-xs mt-1">{s.label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Problem */}
      <section className="py-20 px-8 bg-brand-charcoal-deeper/50">
        <div className="max-w-5xl mx-auto">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-16 items-center">
            <div>
              <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4">The Problem</p>
              <h2 className="text-3xl font-display text-brand-cream leading-tight mb-5">
                Referrals dry up. Networking takes months. Bought leads are shared with 5 other advisors.
              </h2>
              <p className="text-brand-beige text-base leading-relaxed">
                Most financial professionals rely on referrals and introductions for HNW clients. When those slow down, there is no system to replace them. Manual research across LinkedIn, company registers, and Google takes 2-3 hours per prospect. And the advisors winning the best clients already have a pipeline that does this automatically, whether they are targeting UK directors or international executives.
              </p>
            </div>
            <div className="bg-brand-charcoal-deeper rounded-2xl p-8 border border-brand-charcoal-deep">
              <p className="text-brand-cream text-sm font-bold uppercase tracking-wider mb-6">Time per prospect</p>
              {[
                { label: 'Manual research', time: '2-3 hours', width: '100%', color: '#5d5d5d' },
                { label: 'With a VA', time: '45-60 min', width: '38%', color: '#a18d89' },
                { label: 'ProspectIQ', time: '<60 seconds', width: '3%', color: '#c49f8c' },
              ].map((b) => (
                <div key={b.label} className="mb-5 last:mb-0">
                  <div className="flex justify-between mb-1.5">
                    <span className="text-brand-cream text-sm">{b.label}</span>
                    <span className="text-brand-beige text-sm font-semibold">{b.time}</span>
                  </div>
                  <div className="h-2.5 bg-brand-dark rounded-full">
                    <div className="h-full rounded-full" style={{ width: b.width, minWidth: 14, background: b.color }} />
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* How It Works */}
      <section id="how-it-works" className="py-20 px-8">
        <div className="max-w-6xl mx-auto">
          <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4 text-center">How It Works</p>
          <h2 className="text-4xl font-display text-brand-cream text-center mb-16">
            Describe your dream client. Get a scored prospect list.
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                step: '01',
                title: 'Describe your ideal HNW client',
                desc: 'Tell us who you want to reach: "Property directors in Surrey aged 50-65," "Tech founders in Singapore," or "Real estate CEOs in Dubai." Plain English. Choose UK or global search. No filters to learn.',
              },
              {
                step: '02',
                title: 'We find real, verified people',
                desc: 'ProspectIQ searches Companies House (UK directors), the FCA Register (UK financial professionals), or a global database of 270M+ LinkedIn-verified professionals. Real names, real companies, verified data. Scored across four wealth dimensions.',
              },
              {
                step: '03',
                title: 'Get personalised outreach sequences',
                desc: 'Each prospect comes with a research dossier, wealth score, priority tier, LinkedIn profile link, and a 3-step personalised outreach sequence ready to copy and send.',
              },
            ].map((s, i) => (
              <div key={i} className="bg-white/[0.03] backdrop-blur-sm rounded-2xl p-8 border border-white/10 relative overflow-hidden shadow-lg shadow-black/30 transition-all duration-300 hover:bg-white/[0.05] hover:border-brand-rose-gold/20">
                <span className="absolute -top-3 right-4 text-8xl font-display text-brand-charcoal-deep">{s.step}</span>
                <div className="relative">
                  <div className="w-12 h-12 rounded-xl bg-brand-rose-gold/10 border border-brand-rose-gold/20 flex items-center justify-center mb-5">
                    <span className="text-brand-rose-gold font-display text-lg">{s.step}</span>
                  </div>
                  <h3 className="text-brand-cream text-xl font-display mb-3">{s.title}</h3>
                  <p className="text-brand-beige text-sm leading-relaxed">{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Data Sources */}
      <section className="py-20 px-8">
        <div className="max-w-6xl mx-auto">
          <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4 text-center">Three Data Sources</p>
          <h2 className="text-4xl font-display text-brand-cream text-center mb-4">
            UK depth. Global reach.
          </h2>
          <p className="text-brand-beige text-base text-center mb-12 max-w-xl mx-auto">
            Choose the right data source for your market. Every prospect is a real, verified individual from public or commercial records.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                title: 'HNW Clients (UK)',
                badge: 'Companies House',
                badgeColor: 'bg-blue-900/40 text-blue-400',
                desc: 'Real company directors and officers from the official UK company register. Includes occupation, appointment date, and company details.',
                examples: 'Property directors in Surrey, tech founders in London, manufacturing business owners in the Midlands',
              },
              {
                title: 'Financial Professionals (UK)',
                badge: 'FCA Register',
                badgeColor: 'bg-green-900/40 text-green-400',
                desc: 'FCA-approved persons at authorised firms. Real names from the regulator with firm reference numbers and regulatory status.',
                examples: 'IFAs in Yorkshire, mortgage brokers in London, wealth managers in the Home Counties',
              },
              {
                title: 'Global Prospects',
                badge: 'LinkedIn Verified \u00b7 270M+ Profiles',
                badgeColor: 'bg-purple-900/40 text-purple-400',
                desc: 'Directors, founders, and C-suite executives across 200+ countries. Cross-referenced against LinkedIn profiles, corporate filings, and public business records. Deep coverage across US, GCC, Europe, Southeast Asia, and Australia.',
                examples: 'Real estate CEOs in Dubai, fintech founders in Singapore, PE directors in Zurich, tech executives in New York',
              },
            ].map((source, i) => (
              <div key={i} className="bg-white/[0.03] backdrop-blur-sm rounded-2xl p-8 border border-white/10 shadow-lg shadow-black/30 transition-all duration-300 hover:bg-white/[0.05] hover:border-brand-rose-gold/20">
                <span className={`text-[10px] px-2.5 py-1 rounded font-bold uppercase ${source.badgeColor}`}>
                  {source.badge}
                </span>
                <h3 className="text-brand-cream text-xl font-display mt-4 mb-3">{source.title}</h3>
                <p className="text-brand-beige text-sm leading-relaxed mb-4">{source.desc}</p>
                <p className="text-brand-charcoal text-xs italic">e.g. {source.examples}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Social Proof */}
      <section className="py-20 px-8 bg-brand-charcoal-deeper/50">
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4">Proven Results</p>
          <h2 className="text-4xl font-display text-brand-cream mb-4">
            Built on a methodology that has already delivered.
          </h2>
          <p className="text-brand-beige text-base mb-12 max-w-xl mx-auto">
            ProspectIQ automates the exact prospect research and outreach system that AI Wealth Partners clients have used to generate these outcomes.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {[
              {
                metric: '\u00a3100K+',
                label: 'Lifetime value client',
                desc: 'Financial planner booked a \u00a3100K+ lifetime value client within 7 days of implementing the AIWP prospecting system.',
                name: 'Craig',
                role: 'Financial Planner',
              },
              {
                metric: '\u00a355K',
                label: 'Single commission',
                desc: 'IFA and commercial broker secured a \u00a355K commission from a single prospect identified through AI-powered research and personalised outreach.',
                name: 'Gina',
                role: 'IFA & Commercial Broker',
              },
              {
                metric: '\u00a325M',
                label: 'Pipeline built',
                desc: 'Mortgage broker built a \u00a325M pipeline targeting HNW property investors and complex lending cases using systematic prospect intelligence.',
                name: 'Amanda',
                role: 'HNW Mortgage Broker',
              },
            ].map((p, i) => (
              <div key={i} className="bg-brand-charcoal-deep rounded-2xl border border-brand-charcoal p-8 text-left flex flex-col">
                <p className="text-4xl font-display text-brand-rose-gold mb-1">{p.metric}</p>
                <p className="text-brand-cream text-sm font-bold uppercase tracking-wider mb-4">{p.label}</p>
                <p className="text-brand-beige text-sm leading-relaxed flex-1">{p.desc}</p>
                <div className="border-t border-brand-charcoal pt-4 mt-6">
                  <p className="text-brand-cream text-sm font-semibold">{p.name}</p>
                  <p className="text-brand-beige text-xs mt-0.5">{p.role}</p>
                </div>
              </div>
            ))}
          </div>
          <p className="text-brand-charcoal-dark text-xs italic mt-8">
            Past results achieved by AI Wealth Partners consulting clients. Individual outcomes vary. Not guarantees of future performance.
          </p>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-8">
        <div className="max-w-6xl mx-auto text-center">
          <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4">Pricing</p>
          <h2 className="text-4xl font-display text-brand-cream mb-3">
            Less than the cost of one manual research session.
          </h2>
          <p className="text-brand-beige text-base mb-3">
            7-day free trial on all plans. No card required.
          </p>
          <p className="text-brand-charcoal text-sm mb-12">
            All prices exclude VAT.
          </p>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            {plans.map((plan, i) => (
              <div
                key={i}
                className={`rounded-2xl p-8 text-left relative transition-all duration-300 hover:scale-[1.04] hover:shadow-2xl hover:shadow-brand-rose-gold/10 hover:border-brand-rose-gold/40 cursor-pointer ${plan.pop ? 'bg-white/[0.05] backdrop-blur-sm border-2 border-brand-rose-gold scale-[1.02]' : 'bg-white/[0.03] backdrop-blur-sm border border-white/10'}`}
              >
                {plan.pop && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <span className="inline-block bg-gradient-to-r from-brand-rose-gold to-brand-rose-gold-light text-brand-dark px-3 py-0.5 rounded-full text-[10px] font-bold tracking-wider uppercase">
                      Most Popular
                    </span>
                  </div>
                )}
                <h3 className="text-brand-cream text-2xl font-display mb-2">{plan.name}</h3>
                <div className="flex items-baseline gap-1 mb-6">
                  <span className="text-brand-cream text-4xl font-display">&pound;{plan.price}</span>
                  <span className="text-brand-beige text-sm">/mo + VAT</span>
                </div>
                <Link
                  href="/auth/signup"
                  className={`block text-center py-3.5 rounded-lg font-semibold text-sm transition-colors mb-8 ${plan.pop ? 'bg-gradient-to-r from-brand-rose-gold to-brand-rose-gold-light text-brand-dark' : 'border border-brand-charcoal text-brand-cream hover:bg-brand-charcoal-deep'}`}
                >
                  Start Free Trial
                </Link>
                <div className="border-t border-brand-charcoal-deep pt-6 space-y-3">
                  {plan.features.map((f, fi) => (
                    <div key={fi} className="flex items-start gap-2">
                      <span className="text-brand-rose-gold text-xs mt-0.5">&#10003;</span>
                      <span className="text-brand-beige text-sm">{f}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-20 px-8 bg-brand-charcoal-deeper/50">
        <div className="max-w-3xl mx-auto">
          <p className="text-brand-rose-gold text-xs font-bold tracking-[2.5px] uppercase mb-4 text-center">FAQ</p>
          <h2 className="text-3xl font-display text-brand-cream text-center mb-12">
            Common questions
          </h2>

          <div className="space-y-6">
            {[
              {
                q: 'Where does the prospect data come from?',
                a: 'ProspectIQ pulls from three verified sources. UK company directors come from Companies House (the official UK register). UK financial professionals come from the FCA Register. Global prospects are sourced from a database of 270M+ professionals, cross-referenced against LinkedIn profiles, corporate filings, and public business records across 200+ countries. All data is public or commercially licensed. GDPR-compliant for legitimate interest-based outreach.',
              },
              {
                q: 'Are these real people I can actually contact?',
                a: 'Yes. Every prospect is a real, named individual from verified public or commercial data. UK prospects are listed on Companies House or the FCA Register. Global prospects are cross-referenced against LinkedIn profiles and corporate filings. Each comes with a LinkedIn profile link so you can connect directly.',
              },
              {
                q: 'Which countries does it work in?',
                a: 'The UK sources (Companies House, FCA Register) cover all UK-registered companies and regulated firms. The global source draws from a database of 270M+ professionals across 200+ countries, verified against LinkedIn and corporate filings. The strongest coverage is in the US, UK, EU, GCC, Southeast Asia, and Australia.',
              },
              {
                q: 'How is this different from buying leads?',
                a: 'Bought leads are shared with multiple advisors and go stale fast. ProspectIQ gives you exclusive, freshly researched prospects with personalised outreach based on their specific background. Nobody else has the same list.',
              },
              {
                q: 'What are the outreach sequences?',
                a: 'Each prospect receives a personalised 3-step LinkedIn message sequence based on the LINK Method\u2122: a connection request, a value-led follow-up, and a meeting invitation. Every message references the prospect\u2019s real company, role, and background.',
              },
              {
                q: 'Do I need LinkedIn Sales Navigator?',
                a: 'No. ProspectIQ works independently. For most prospects, we provide an exact LinkedIn profile URL. For others, we provide a pre-filled search link. Sales Navigator is useful but not required.',
              },
              {
                q: 'Is this FCA compliant?',
                a: 'ProspectIQ is a prospecting tool, not a regulated service. We help you identify and contact potential clients. All outreach sequences are designed to be compliance-friendly for FCA-regulated professionals. You maintain full control over what you send.',
              },
            ].map((faq, i) => (
              <div key={i} className="bg-brand-charcoal-deeper rounded-xl border border-brand-charcoal-deep p-6">
                <h3 className="text-brand-cream text-base font-semibold mb-2">{faq.q}</h3>
                <p className="text-brand-beige text-sm leading-relaxed">{faq.a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="py-20 px-8 text-center relative overflow-hidden">
        <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full bg-brand-rose-gold/5 blur-3xl" />
        <div className="relative max-w-xl mx-auto">
          <h2 className="text-4xl font-display text-brand-cream leading-tight">
            Your next HNW client is already out there.{' '}
            <span className="text-brand-rose-gold">Find them in 60 seconds.</span>
          </h2>
          <p className="text-brand-beige text-base mt-4">
            7-day free trial. No card required. No Sales Navigator needed.
          </p>
          <p className="text-brand-beige/60 text-sm mt-2">
            UK company directors. FCA-regulated professionals. Global executives. All from one platform.
          </p>
          <Link href="/auth/signup" className="btn-primary text-base inline-block mt-8">
            Start Free Trial
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-brand-charcoal-deep py-8 px-8">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <span className="text-brand-rose-gold text-[10px] font-bold tracking-[2px] uppercase">AI Wealth Partners</span>
            <span className="text-brand-charcoal mx-2">|</span>
            <span className="text-brand-beige text-sm font-display">ProspectIQ</span>
          </div>
          <p className="text-brand-charcoal-deep text-xs">
            &copy; {new Date().getFullYear()} AI Wealth Partners Ltd. All rights reserved.
          </p>
        </div>
      </footer>
    </div>
  )
}
