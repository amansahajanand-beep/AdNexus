import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart3, Smartphone, TrendingUp, Target, Sparkles, Users, Bookmark, Globe2,
  ShieldCheck, Lock, Eye, Link2, Check, ArrowRight, Zap, Layers,
} from 'lucide-react';
import { BrandMark } from '../components/ui/BrandLogo';
import './About.css';

/**
 * Public app homepage — also the page Google's OAuth branding verification reads.
 * Keep: app name "mediamonetix" (must match the consent screen), a clear statement of purpose,
 * Google data-use disclosure, and visible Privacy / Terms links. Must stay reachable without login.
 */

const FEATURES = [
  { icon: BarChart3, tone: 'blue', title: 'Ad Manager reporting', text: 'Revenue, impressions, CTR and eCPM from Google Ad Manager across every site, app, ad unit, country and device — with a flexible report builder.' },
  { icon: Smartphone, tone: 'teal', title: 'AdMob & AdSense', text: 'Bring app and web publisher earnings into the same workspace, with the same filters and presets.' },
  { icon: TrendingUp, tone: 'green', title: 'ROI: earnings vs. spend', text: 'Map Google Ads campaigns to the apps and sites they promote and see profit, spend and return side by side.' },
  { icon: Target, tone: 'violet', title: 'Ad Insights', text: 'Explore the headlines, images, videos and keywords behind your own Google Ads campaigns, with performance labels.' },
  { icon: Sparkles, tone: 'amber', title: 'AI reports & forecasts', text: 'Weekly summaries, anomaly alerts and revenue forecasts that explain what changed, in plain language.' },
  { icon: Users, tone: 'rose', title: 'Teams & restricted access', text: 'Give each partner or teammate access only to the sites, apps and accounts you assign.' },
  { icon: Bookmark, tone: 'blue', title: 'Presets & Google Sheets', text: 'Save favourite filters as presets and export reports to Google Sheets or CSV in one click.' },
  { icon: Globe2, tone: 'teal', title: 'Timezone-aware', text: 'View reports in your own timezone and currency, with data-freshness indicators on every number.' },
];

const STATS = [
  { value: '4', label: 'Google products in one workspace' },
  { value: 'Hourly', label: 'Scheduled data sync' },
  { value: 'Any', label: 'Timezone & currency view' },
  { value: 'Role-based', label: 'Access for every user' },
];

const SHOWCASE = [
  {
    id: 'reporting',
    tab: 'Reporting',
    title: 'See every site and app at a glance',
    text: 'Dashboards for revenue, impressions, CTR and eCPM, with breakdowns by site, app, ad unit, country, device and more. Compare any two periods in one click.',
    points: ['Fast dashboards, even for long date ranges', 'Report builder with saved presets', 'Export to Google Sheets or CSV'],
  },
  {
    id: 'roi',
    tab: 'ROI',
    title: 'Know which apps and sites are profitable',
    text: 'Connect Google Ads, map campaigns to the apps and sites they promote, and compare ad spend with the revenue they generate.',
    points: ['Spend, revenue and profit side by side', 'Per app, site, country and account', 'Alerts when ROI drops'],
  },
  {
    id: 'insights',
    tab: 'Ad Insights',
    title: 'Understand the creatives behind your ads',
    text: 'Browse the headlines, descriptions, images and videos of your own campaigns with Google’s performance labels, plus keywords and search terms.',
    points: ['Best / Good / Low asset labels', 'Keywords and search terms', 'Filter by app and period'],
  },
  {
    id: 'ai',
    tab: 'AI insights',
    title: 'Let the numbers explain themselves',
    text: 'Get a weekly written summary, automatic alerts on unusual changes, and revenue forecasts — so you spend time acting, not digging.',
    points: ['Weekly report in plain language', 'Anomaly and threshold alerts', 'Revenue forecasts'],
  },
];

const STEPS = [
  { n: '1', title: 'Connect your Google accounts', text: 'Sign in and authorise Google Ad Manager, AdMob, AdSense or Google Ads with Google’s standard OAuth consent screen. You choose the accounts.' },
  { n: '2', title: 'We sync your reporting data', text: 'mediamonetix pulls reporting data on a schedule and stores it so dashboards open instantly.' },
  { n: '3', title: 'Analyse, share and act', text: 'Slice the data, compare periods, set alerts, export to Sheets and give your team the right level of access.' },
];

const PILLARS = [
  { icon: Eye, title: 'Read-only reporting', text: 'The application reads reporting data. It does not create, edit or delete campaigns, ads or ad units.' },
  { icon: Lock, title: 'Encrypted & protected', text: 'Connection tokens are stored encrypted, traffic uses HTTPS and users only see inventory assigned to them.' },
  { icon: Link2, title: 'You stay in control', text: 'Choose which accounts to connect, and disconnect or revoke access in your Google Account at any time.' },
  { icon: ShieldCheck, title: 'Never sold, never used for ads', text: 'Google user data is used only to provide the features you see in the app.' },
];

const FAQ = [
  { q: 'What is mediamonetix?', a: 'mediamonetix is an advertising analytics application. It lets publishers and advertisers view Google Ad Manager, AdMob and AdSense earnings and Google Ads spend in one dashboard, and analyse ROI.' },
  { q: 'Which Google data does mediamonetix access?', a: 'Only the reporting data of the accounts you connect — for example impressions, revenue, campaigns, assets and keywords. We use it solely to show you dashboards and reports inside the application.' },
  { q: 'Does mediamonetix change anything in my Google accounts?', a: 'No. The application only reads reporting data. It does not create, edit or delete campaigns, ads, ad units or any other settings in your Google accounts.' },
  { q: 'How is my data protected?', a: 'Connection tokens are stored encrypted, traffic uses HTTPS, and every user only sees the accounts and inventory assigned to them. We do not sell your data or use it for advertising.' },
  { q: 'Can I disconnect at any time?', a: 'Yes. Disconnect an account inside the application, or revoke access from your Google Account permissions page. See our Privacy Policy for how data is handled afterwards.' },
];

/* ───── helpers ───── */

/** Adds `is-in` when the element scrolls into view; everything is visible if IntersectionObserver is missing. */
function Reveal({ as: Tag = 'div', className = '', delay = 0, children, ...rest }) {
  const ref = useRef(null);
  const [seen, setSeen] = useState(typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting) { setSeen(true); io.disconnect(); }
    }, { threshold: 0.12 });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return (
    <Tag ref={ref} className={`ab-reveal ${seen ? 'is-in' : ''} ${className}`.trim()} style={{ transitionDelay: `${delay}ms` }} {...rest}>
      {children}
    </Tag>
  );
}

const AREA = [22, 30, 26, 38, 34, 46, 42, 55, 50, 64, 58, 72, 68, 82, 78, 90];
function areaPath(vals, w, h, close) {
  const step = w / (vals.length - 1);
  const pts = vals.map((v, i) => [i * step, h - (v / 100) * h]);
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i += 1) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    const cx = (x0 + x1) / 2;
    d += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  return close ? `${d} L${w},${h} L0,${h} Z` : d;
}

function Chart({ vals = AREA }) {
  return (
    <svg viewBox="0 0 320 120" preserveAspectRatio="none" className="ab-chart" aria-hidden>
      <defs>
        <linearGradient id="abFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#6366f1" stopOpacity=".35" />
          <stop offset="1" stopColor="#6366f1" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="abLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#2563eb" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
      </defs>
      {[30, 60, 90].map((y) => <line key={y} x1="0" x2="320" y1={y} y2={y} stroke="currentColor" strokeOpacity=".08" />)}
      <path d={areaPath(vals, 320, 120, true)} fill="url(#abFill)" />
      <path d={areaPath(vals, 320, 120, false)} fill="none" stroke="url(#abLine)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function Window({ title, children, className = '' }) {
  return (
    <div className={`ab-mock ${className}`} aria-hidden>
      <div className="ab-mock-bar"><span /><span /><span /><em>{title}</em></div>
      <div className="ab-mock-body">{children}</div>
    </div>
  );
}

function Kpis({ items }) {
  return (
    <div className="ab-mock-kpis">
      {items.map(([l, v, d]) => (
        <div key={l} className="ab-mock-kpi"><small>{l}</small><strong>{v}</strong><i>{d}</i></div>
      ))}
    </div>
  );
}

function Rows({ rows }) {
  return (
    <div className="ab-mock-rows">
      {rows.map(([name, val, pctv]) => (
        <div key={name}>
          <span>{name}</span>
          <span className="ab-mock-meter"><u style={{ width: `${pctv}%` }} /></span>
          <b>{val}</b>
        </div>
      ))}
    </div>
  );
}

function ShowcaseMock({ id }) {
  if (id === 'roi') {
    return (
      <Window title="mediamonetix · ROI">
        <Kpis items={[['Revenue', '$18,240', '+9.4%'], ['Ad spend', '$7,120', '+3.1%'], ['Profit', '$11,120', '+13%'], ['ROI', '256%', '+18%']]} />
        <Chart vals={[30, 34, 40, 38, 48, 52, 50, 60, 66, 62, 74, 80, 78, 88, 92, 96]} />
        <Rows rows={[['App · Puzzle Quest', '312%', 92], ['App · Racing Pro', '241%', 74], ['Site · news-daily.com', '188%', 58]]} />
      </Window>
    );
  }
  if (id === 'insights') {
    return (
      <Window title="mediamonetix · Ad Insights">
        <div className="ab-assets">
          {[['Best', 'best', 'linear-gradient(135deg,#60a5fa,#6366f1)'], ['Good', 'good', 'linear-gradient(135deg,#34d399,#0ea5e9)'], ['Low', 'low', 'linear-gradient(135deg,#fbbf24,#f87171)']].map(([l, t, bg]) => (
            <div key={l} className="ab-asset-tile">
              <div className="ab-asset-img" style={{ background: bg }}><b className={`ab-lbl ab-lbl--${t}`}>{l}</b></div>
              <small>Marketing image</small>
            </div>
          ))}
        </div>
        <div className="ab-mock-chips">
          {['Play now — free', 'Level up fast', 'Join millions of players', 'puzzle game', 'offline games'].map((c) => <span key={c}>{c}</span>)}
        </div>
        <Rows rows={[['“puzzle game”', '48.2K', 88], ['“brain games”', '31.7K', 62], ['“offline games”', '19.4K', 40]]} />
      </Window>
    );
  }
  if (id === 'ai') {
    return (
      <Window title="mediamonetix · Weekly report">
        <div className="ab-ai">
          <div className="ab-ai-tag"><Sparkles size={13} /> AI summary</div>
          <p>Revenue rose <b>8.2%</b> week over week, led by <b>Puzzle Quest</b> in the US. eCPM dipped on Android in India — worth checking floor prices.</p>
        </div>
        <Chart vals={[40, 44, 42, 50, 48, 56, 60, 58, 66, 70, 68, 76, 80, 78, 86, 90]} />
        <div className="ab-alert"><Zap size={14} /> Alert: iOS fill rate down 12% vs. last week</div>
      </Window>
    );
  }
  return (
    <Window title="mediamonetix · Dashboard">
      <Kpis items={[['Revenue', '$12,480', '+8.2%'], ['Impressions', '4.2M', '+5.1%'], ['eCPM', '$2.97', '+2.9%'], ['CTR', '1.84%', '+0.2%']]} />
      <Chart />
      <Rows rows={[['App · Puzzle Quest', '$3,210', 90], ['Site · news-daily.com', '$2,874', 76], ['App · Racing Pro', '$1,962', 54]]} />
    </Window>
  );
}

/* ───── page ───── */

export default function About() {
  const year = new Date().getFullYear();
  const [tab, setTab] = useState('reporting');
  const active = SHOWCASE.find((s) => s.id === tab) || SHOWCASE[0];

  return (
    <div className="ab">
      <header className="ab-nav">
        <div className="ab-wrap ab-nav-in">
          <Link to="/" className="ab-brand" aria-label="mediamonetix home">
            <BrandMark size={32} className="ab-logo" />
            <span>mediamonetix</span>
          </Link>
          <nav className="ab-links" aria-label="Primary">
            <a href="#features">Features</a>
            <a href="#showcase">Product</a>
            <a href="#how">How it works</a>
            <a href="#security">Data &amp; security</a>
            <a href="#faq">FAQ</a>
          </nav>
          <Link to="/login" className="ab-btn ab-btn--primary ab-nav-cta">Sign in <ArrowRight size={16} /></Link>
        </div>
      </header>

      <main>
        {/* hero */}
        <section className="ab-hero">
          <div className="ab-hero-bg" aria-hidden />
          <div className="ab-wrap ab-hero-in">
            <div className="ab-hero-copy">
              <span className="ab-pill"><Zap size={14} /> Ad revenue &amp; ad spend analytics</span>
              <h1>
                All your Google ad earnings and spend,
                <span> in one clear dashboard.</span>
              </h1>
              <p className="ab-lead">
                <strong>mediamonetix</strong> is an advertising analytics application for publishers,
                app developers and ad teams. Connect Google Ad Manager, AdMob, AdSense and Google Ads
                to see revenue, impressions, campaigns and ROI — and understand what is working.
              </p>
              <div className="ab-cta">
                <Link to="/login" className="ab-btn ab-btn--primary ab-btn--lg">Sign in to mediamonetix <ArrowRight size={18} /></Link>
                <a href="#showcase" className="ab-btn ab-btn--ghost ab-btn--lg">See how it looks</a>
              </div>
              <ul className="ab-trust">
                <li><Check size={15} /> Read-only reporting access</li>
                <li><Check size={15} /> Encrypted connections</li>
                <li><Check size={15} /> Disconnect any time</li>
              </ul>
            </div>

            <div className="ab-hero-visual">
              <Window title="mediamonetix · Dashboard" className="ab-mock--hero">
                <Kpis items={[['Revenue', '$12,480', '+8.2%'], ['Impressions', '4.2M', '+5.1%'], ['eCPM', '$2.97', '+2.9%'], ['ROI', '184%', '+11%']]} />
                <Chart />
                <Rows rows={[['App · Puzzle Quest', '$3,210', 90], ['Site · news-daily.com', '$2,874', 76], ['App · Racing Pro', '$1,962', 54]]} />
              </Window>
              <div className="ab-float ab-float--a"><TrendingUp size={16} /> <span><b>+8.2%</b> revenue this week</span></div>
              <div className="ab-float ab-float--b"><Layers size={16} /> <span>4 Google products connected</span></div>
            </div>
          </div>
        </section>

        {/* products strip */}
        <section className="ab-strip" aria-label="Supported Google products">
          <div className="ab-wrap ab-strip-in">
            <span>Works with</span>
            {['Google Ad Manager', 'AdMob', 'AdSense', 'Google Ads', 'Google Sheets'].map((p) => <b key={p}>{p}</b>)}
          </div>
        </section>

        {/* stats */}
        <section className="ab-wrap ab-stats">
          {STATS.map((s, i) => (
            <Reveal key={s.label} delay={i * 70} className="ab-stat">
              <strong>{s.value}</strong>
              <span>{s.label}</span>
            </Reveal>
          ))}
        </section>

        {/* what it is */}
        <section className="ab-section ab-wrap" id="about">
          <Reveal className="ab-head">
            <h2>What mediamonetix does</h2>
            <p>
              Running ads across many sites, apps and accounts means logging in to several Google
              tools and stitching numbers together by hand. mediamonetix connects to them for you
              and turns the raw reports into one workspace you can filter, compare and share.
            </p>
          </Reveal>
          <Reveal className="ab-purpose">
            <div>
              <h3>Purpose of the application</h3>
              <ul className="ab-check">
                <li>Connect Google Ad Manager, AdMob, AdSense and Google Ads with OAuth so reporting data can sync securely.</li>
                <li>Display dashboards and detailed reports for impressions, revenue, campaigns and inventory.</li>
                <li>Help teams compare earnings and ad spend (ROI) across sites, apps and accounts.</li>
                <li>Provide administration tools for organisations that manage multiple users and clients.</li>
              </ul>
            </div>
            <div className="ab-who">
              <h3>Who it’s for</h3>
              {[['Publishers', 'Monitor earnings across many sites and apps and spot revenue drops early.'],
                ['App developers', 'Compare ad revenue with user-acquisition spend to see which apps are profitable.'],
                ['Ad ops & agencies', 'Manage multiple clients and partners from one place, with restricted logins.']].map(([t, x]) => (
                  <div key={t} className="ab-who-item"><strong>{t}</strong><span>{x}</span></div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* features */}
        <section className="ab-section ab-section--alt" id="features">
          <div className="ab-wrap">
            <Reveal className="ab-head">
              <h2>Everything you need to understand your ad business</h2>
              <p>Powerful where it matters, simple everywhere else.</p>
            </Reveal>
            <div className="ab-features">
              {FEATURES.map((f, i) => {
                const Ico = f.icon;
                return (
                  <Reveal as="article" key={f.title} delay={(i % 4) * 60} className="ab-feature">
                    <span className={`ab-ficon ab-tone--${f.tone}`}><Ico size={22} strokeWidth={1.9} /></span>
                    <h3>{f.title}</h3>
                    <p>{f.text}</p>
                  </Reveal>
                );
              })}
            </div>
          </div>
        </section>

        {/* showcase */}
        <section className="ab-section ab-wrap" id="showcase">
          <Reveal className="ab-head">
            <h2>A closer look</h2>
            <p>One workspace, four ways to understand your ads.</p>
          </Reveal>
          <div className="ab-tabs" role="tablist" aria-label="Product areas">
            {SHOWCASE.map((s) => (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={tab === s.id}
                className={tab === s.id ? 'is-active' : ''}
                onClick={() => setTab(s.id)}
              >
                {s.tab}
              </button>
            ))}
          </div>
          <div className="ab-showcase" key={active.id}>
            <div className="ab-showcase-copy">
              <h3>{active.title}</h3>
              <p>{active.text}</p>
              <ul className="ab-check">
                {active.points.map((p) => <li key={p}>{p}</li>)}
              </ul>
            </div>
            <div className="ab-showcase-visual"><ShowcaseMock id={active.id} /></div>
          </div>
        </section>

        {/* how */}
        <section className="ab-section ab-section--alt" id="how">
          <div className="ab-wrap">
            <Reveal className="ab-head">
              <h2>How it works</h2>
              <p>From sign-in to insight in three steps.</p>
            </Reveal>
            <ol className="ab-steps">
              {STEPS.map((s, i) => (
                <Reveal as="li" key={s.n} delay={i * 90}>
                  <span className="ab-step-n">{s.n}</span>
                  <h3>{s.title}</h3>
                  <p>{s.text}</p>
                </Reveal>
              ))}
            </ol>
          </div>
        </section>

        {/* security */}
        <section className="ab-sec-wrap" id="security">
          <div className="ab-wrap">
            <Reveal className="ab-head ab-head--light">
              <h2>Your Google data, handled with care</h2>
              <p>We ask for the minimum access needed to show your reports, and we are transparent about how it is used.</p>
            </Reveal>
            <div className="ab-trustgrid">
              {PILLARS.map((p, i) => {
                const Ico = p.icon;
                return (
                  <Reveal key={p.title} delay={i * 70} className="ab-trustcard">
                    <span><Ico size={20} /></span>
                    <h3>{p.title}</h3>
                    <p>{p.text}</p>
                  </Reveal>
                );
              })}
            </div>
            <Reveal className="ab-disclosure">
              <h3>Google API Services disclosure</h3>
              <p>
                mediamonetix’s use and transfer of information received from Google APIs adheres to the{' '}
                <a href="https://developers.google.com/terms/api-services-user-data-policy" target="_blank" rel="noopener noreferrer">
                  Google API Services User Data Policy
                </a>
                , including the Limited Use requirements. Read the full details in our{' '}
                <Link to="/privacy">Privacy Policy</Link> and <Link to="/terms">Terms of Service</Link>.
              </p>
            </Reveal>
          </div>
        </section>

        {/* faq */}
        <section className="ab-section ab-wrap" id="faq">
          <Reveal className="ab-head"><h2>Frequently asked questions</h2></Reveal>
          <Reveal className="ab-faq">
            {FAQ.map((f) => (
              <details key={f.q}>
                <summary>{f.q}</summary>
                <p>{f.a}</p>
              </details>
            ))}
          </Reveal>
        </section>

        {/* final cta */}
        <section className="ab-final">
          <div className="ab-wrap ab-final-in">
            <h2>Ready to see your numbers clearly?</h2>
            <p>Sign in to connect your Google accounts and start exploring your data.</p>
            <Link to="/login" className="ab-btn ab-btn--light ab-btn--lg">Sign in to mediamonetix <ArrowRight size={18} /></Link>
          </div>
        </section>
      </main>

      <footer className="ab-footer">
        <div className="ab-wrap ab-footer-in">
          <div className="ab-brand ab-brand--foot">
            <BrandMark size={26} className="ab-logo" />
            <span>mediamonetix</span>
          </div>
          <nav className="ab-flinks" aria-label="Legal">
            <Link to="/about">About</Link>
            <Link to="/privacy">Privacy Policy</Link>
            <Link to="/terms">Terms of Service</Link>
            <Link to="/login">Sign in</Link>
          </nav>
          <span className="ab-copy">© {year} mediamonetix. All rights reserved.</span>
        </div>
      </footer>
    </div>
  );
}
