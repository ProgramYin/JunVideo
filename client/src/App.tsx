import { FormEvent, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Check,
  ChevronRight,
  CircleHelp,
  Clock3,
  Copy,
  Download,
  ExternalLink,
  FileAudio,
  FileImage,
  FileText,
  FileVideo,
  History as HistoryIcon,
  Languages,
  Link2,
  LogIn,
  LogOut,
  Menu,
  Play,
  Plus,
  ShieldCheck,
  Sparkles,
  UserRound,
  X,
  Zap,
} from 'lucide-react';
import {
  activateVip,
  ApiError,
  downloadMedia,
  downloadUrl,
  getToken,
  health,
  history,
  login,
  me,
  parseUrl,
  transcribeVideo,
  register,
  saveLocale,
  setToken,
  usage,
} from './api';
import { defaultLocale, t, type CopyKey } from './i18n';
import type { ApiHealth, DownloadOption, Locale, ParseJob, Usage, User, ViewName } from './types';

async function retryStartupRequest<T>(request: () => Promise<T>, attempts = 8): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      lastError = error;
      const status = error instanceof ApiError ? error.status : 0;
      if (status > 0 && status < 500) throw error;
      if (attempt < attempts - 1) {
        await new Promise((resolve) => window.setTimeout(resolve, 500 + attempt * 400));
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('JunVideo API is unavailable.');
}

const platformCards = [
  { key: 'douyin', label: '抖音', code: '抖', tone: 'coral' },
  { key: 'xiaohongshu', label: '小红书', code: '小', tone: 'rose' },
  { key: 'bilibili', label: 'Bilibili', code: 'B', tone: 'blue' },
  { key: 'youtube', label: 'YouTube', code: '▶', tone: 'red' },
  { key: 'tiktok', label: 'TikTok', code: '♪', tone: 'ink' },
  { key: 'more', label: '+ more', code: '+', tone: 'soft' },
];

function formatDuration(seconds?: number | null) {
  if (!seconds || seconds < 1) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const remaining = total % 60;
  return `${minutes}:${remaining.toString().padStart(2, '0')}`;
}

function formatDate(date?: string | null, locale: Locale = 'zh') {
  if (!date) return '—';
  try {
    return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(date));
  } catch {
    return date;
  }
}

function friendlyPlatform(platform: string) {
  const map: Record<string, string> = {
    douyin: '抖音',
    xiaohongshu: '小红书',
    bilibili: 'Bilibili',
    youtube: 'YouTube',
    tiktok: 'TikTok',
    instagram: 'Instagram',
    x: 'X / Twitter',
    weibo: '微博',
    kuaishou: '快手',
  };
  return map[platform] ?? platform ?? 'Web';
}

function App() {
  const [locale, setLocale] = useState<Locale>(() => {
    const stored = window.localStorage.getItem('junvideo_locale');
    if (stored === 'en' || stored === 'zh') return stored;
    return defaultLocale;
  });
  const [view, setView] = useState<ViewName>('workspace');
  const [user, setUser] = useState<User | null>(null);
  const [usageState, setUsageState] = useState<Usage | null>(null);
  const [service, setService] = useState<ApiHealth | null>(null);
  const [sessionLoading, setSessionLoading] = useState(true);
  const [url, setUrl] = useState('');
  const [job, setJob] = useState<ParseJob | null>(null);
  const [historyItems, setHistoryItems] = useState<ParseJob[]>([]);
  const [isParsing, setIsParsing] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [authMode, setAuthMode] = useState<'login' | 'register' | null>(null);
  const [notice, setNotice] = useState<{ type: 'error' | 'success' | 'info'; text: string } | null>(null);
  const [mobileMenu, setMobileMenu] = useState(false);

  const tx = (key: CopyKey) => t(locale, key);
  const isVip = Boolean(user?.plan === 'vip' && user.vipExpiresAt && new Date(user.vipExpiresAt) > new Date());

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const serviceState = await retryStartupRequest(health);
        if (!cancelled) setService(serviceState);
      } catch {
        if (!cancelled) setService(null);
      }
      if (!getToken()) {
        if (!cancelled) setSessionLoading(false);
        return;
      }
      try {
        const [currentUser, currentUsage] = await Promise.all([
          retryStartupRequest(me),
          retryStartupRequest(usage),
        ]);
        if (!cancelled) {
          setUser(currentUser);
          setUsageState(currentUsage);
        }
      } catch (error) {
        // Only an explicit 401 proves the token is invalid. A temporary API
        // startup/network failure must not silently sign the user out.
        if (error instanceof ApiError && error.status === 401) setToken(null);
        if (!cancelled) {
          if (error instanceof ApiError && error.status === 401) {
            setUser(null);
            setUsageState(null);
          } else {
            setNotice({ type: 'error', text: error instanceof Error ? error.message : tx('errorFallback') });
          }
        }
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem('junvideo_locale', locale);
    if (user) void saveLocale(locale).catch(() => undefined);
    document.documentElement.lang = locale === 'zh' ? 'zh-CN' : 'en';
  }, [locale, user]);

  useEffect(() => {
    if (view !== 'history' || !user) return;
    setIsLoadingHistory(true);
    void history()
      .then(setHistoryItems)
      .catch((error: unknown) => showError(error, tx, setNotice))
      .finally(() => setIsLoadingHistory(false));
  }, [view, user]);

  function go(nextView: ViewName) {
    setView(nextView);
    setMobileMenu(false);
    if (nextView === 'workspace') window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function toggleLocale() {
    setLocale((current) => (current === 'zh' ? 'en' : 'zh'));
  }

  async function handleParse(event?: FormEvent) {
    event?.preventDefault();
    setNotice(null);
    if (!url.trim()) {
      setNotice({ type: 'info', text: tx('invalidLink') });
      return;
    }
    if (!user) {
      setAuthMode('login');
      return;
    }
    await executeParse(url);
  }

  async function executeParse(sourceUrl: string) {
    setIsParsing(true);
    try {
      const parsed = await parseUrl(sourceUrl);
      setJob(parsed);
      const nextUsage = await usage().catch(() => null);
      if (nextUsage) setUsageState(nextUsage);
      if (parsed.status === 'failed') {
        setNotice({ type: 'error', text: parsed.errorMessage || tx('errorFallback') });
      } else {
        setNotice({ type: 'success', text: tx('ready') });
      }
    } catch (error) {
      showError(error, tx, setNotice, () => {
        setToken(null);
        setUser(null);
        setUsageState(null);
        setAuthMode('login');
      });
    } finally {
      setIsParsing(false);
    }
  }

  async function handleRefreshParse(sourceUrl: string) {
    if (!user) {
      setAuthMode('login');
      return;
    }
    setNotice(null);
    await executeParse(sourceUrl);
  }

  async function handleAuth(mode: 'login' | 'register', values: { name: string; email: string; password: string }) {
    setNotice(null);
    try {
      const result = mode === 'login'
        ? await login({ email: values.email, password: values.password })
        : await register(values);
      const currentUsage = await usage();
      setUser(result.user);
      setUsageState(currentUsage);
      setAuthMode(null);
      setNotice({ type: 'success', text: mode === 'login' ? tx('systemOnline') : tx('registerAction') });
    } catch (error) {
      showError(error, tx, setNotice);
    }
  }

  async function handleActivateVip() {
    if (!user) {
      setAuthMode('login');
      return;
    }
    try {
      const updated = await activateVip();
      setUser(updated);
      setUsageState(await usage());
      setNotice({ type: 'success', text: tx('activated') });
    } catch (error) {
      showError(error, tx, setNotice);
    }
  }

  function handleLogout() {
    setToken(null);
    setUser(null);
    setUsageState(null);
    setJob(null);
    go('workspace');
    setNotice({ type: 'info', text: tx('signOut') });
  }

  const quotaLabel = useMemo(() => {
    if (isVip || usageState?.limit === null) return tx('unlimited');
    return `${usageState?.remaining ?? 10} ${tx('timesLeft')}`;
  }, [isVip, usageState, locale]);

  return (
    <div className="app-shell">
      <div className="noise" aria-hidden="true" />
      <header className="topbar page-width">
        <button className="brand" onClick={() => go('workspace')} aria-label="JunVideo home">
          <span className="brand-mark"><span>J</span><span>V</span></span>
          <span className="brand-name">JunVideo</span>
        </button>
        <nav className={`main-nav ${mobileMenu ? 'is-open' : ''}`}>
          <NavButton active={view === 'workspace'} onClick={() => go('workspace')}>{tx('navWorkbench')}</NavButton>
          <NavButton active={view === 'history'} onClick={() => user ? go('history') : setAuthMode('login')}><HistoryIcon size={15} />{tx('navHistory')}</NavButton>
          <NavButton active={view === 'vip'} onClick={() => go('vip')}><Sparkles size={15} />{tx('navVip')}</NavButton>
        </nav>
        <div className="top-actions">
          <button className="language-toggle" onClick={toggleLocale} title="Change language"><Languages size={15} />{tx('language')}</button>
          {user ? (
            <div className="account-menu">
              <button className="user-pill" onClick={() => go('vip')}>
                <span className="avatar">{(user.name || user.email).slice(0, 1).toUpperCase()}</span>
                <span className="user-pill-copy"><strong>{user.name || user.email.split('@')[0]}</strong><small>{isVip ? 'VIP' : tx('account')}</small></span>
                <ChevronRight size={15} />
              </button>
              <button className="icon-button logout-button" onClick={handleLogout} title={tx('signOut')}><LogOut size={16} /></button>
            </div>
          ) : (
            <button className="outline-button sign-in-button" onClick={() => setAuthMode('login')}><LogIn size={16} />{tx('signIn')}</button>
          )}
          <button className="mobile-menu-button" onClick={() => setMobileMenu((open) => !open)} aria-label="Menu"><Menu size={20} /></button>
        </div>
      </header>

      {view === 'workspace' && (
        <main>
          <section className="hero page-width">
            <div className="hero-copy">
              <div className="eyebrow"><span className="eyebrow-dot" />{tx('eyebrow')}</div>
              <h1>{tx('title').split('\n').map((line, index) => <span key={line}>{index > 0 && <br />}{line}</span>)}</h1>
              <p>{tx('subtitle')}</p>
            </div>
            <div className="hero-aside">
              <div className="hero-orbit orbit-one" />
              <div className="hero-orbit orbit-two" />
              <div className="hero-note"><Sparkles size={15} /><span>public links<br /><strong>made lighter</strong></span></div>
              <div className="hero-number"><span>01</span><small>simple<br />by design</small></div>
            </div>
          </section>

          <section className="workspace-grid page-width">
            <div className="workspace-main">
              <form className="parse-card" onSubmit={handleParse}>
                <div className="card-heading">
                  <div><span className="section-kicker">01 / {tx('navWorkbench')}</span><h2>{tx('parse')}</h2></div>
                  <div className="support-badge"><ShieldCheck size={14} />{tx('supported')}</div>
                </div>
                <div className="url-field-wrap">
                  <Link2 size={20} className="url-icon" />
                  <input value={url} onChange={(event) => setUrl(event.target.value)} placeholder={tx('inputPlaceholder')} aria-label={tx('inputPlaceholder')} />
                  {url && <button type="button" className="clear-input" onClick={() => setUrl('')} aria-label={tx('close')}><X size={16} /></button>}
                  <button className="parse-button" type="submit" disabled={isParsing || sessionLoading}>
                    {isParsing ? <span className="button-spinner" /> : <ArrowRight size={17} />}
                    <span>{isParsing ? tx('parsing') : user ? tx('parse') : tx('loginToParse')}</span>
                  </button>
                </div>
                <div className="parse-card-footer"><span><CircleHelp size={14} />{tx('pasteTip')}</span><span className="shortcut">⌘ ↵</span></div>
              </form>

              {notice && <div className={`notice notice-${notice.type}`}><span className="notice-dot" />{notice.text}<button onClick={() => setNotice(null)} aria-label={tx('close')}><X size={14} /></button></div>}

              <ResultCard job={job} locale={locale} tx={tx} onRefresh={handleRefreshParse} />

              <section className="steps-section">
                <div className="section-heading-row"><div><span className="section-kicker">02 / HOW IT WORKS</span><h2>{tx('stepsTitle')}</h2></div><span className="heading-rule" /></div>
                <div className="steps-grid">
                  <StepCard number="01" icon={<Copy size={18} />} title={tx('stepOne')} hint={tx('stepOneHint')} />
                  <StepCard number="02" icon={<Zap size={18} />} title={tx('stepTwo')} hint={tx('stepTwoHint')} />
                  <StepCard number="03" icon={<Download size={18} />} title={tx('stepThree')} hint={tx('stepThreeHint')} />
                </div>
              </section>
            </div>

            <aside className="workspace-aside">
              <UsageCard user={user} usageState={usageState} isVip={isVip} quotaLabel={quotaLabel} tx={tx} onUpgrade={() => go('vip')} />
              <PlatformCard tx={tx} />
              <div className="side-note"><div className="side-note-icon"><ShieldCheck size={17} /></div><p>{tx('legal')}</p></div>
            </aside>
          </section>

          <section className="platforms-section page-width">
            <div className="section-heading-row"><div><span className="section-kicker">03 / SOURCES</span><h2>{tx('platformsTitle')}</h2><p>{tx('platformsHint')}</p></div><ArrowDownToLine size={20} className="section-heading-icon" /></div>
            <div className="platforms-grid">{platformCards.map((platform) => <PlatformBadge key={platform.key} platformKey={platform.key} code={platform.code} label={platform.label} tone={platform.tone} />)}</div>
          </section>
        </main>
      )}

      {view === 'history' && <HistoryView items={historyItems} isLoading={isLoadingHistory} locale={locale} tx={tx} onPick={(item) => { setJob(item); go('workspace'); }} />}
      {view === 'vip' && <VipView user={user} isVip={isVip} locale={locale} tx={tx} onActivate={handleActivateVip} onLogin={() => setAuthMode('login')} />}

      <footer className="footer page-width"><div className="footer-brand"><span className="brand-mark small"><span>J</span><span>V</span></span><span>JunVideo</span></div><p>{tx('footer')}</p><span className="footer-status"><i />{service?.ok ? tx('systemOnline') : tx('systemChecking')}</span></footer>

      {authMode && <AuthDialog mode={authMode} locale={locale} tx={tx} onClose={() => setAuthMode(null)} onSwitch={() => setAuthMode((mode) => mode === 'login' ? 'register' : 'login')} onSubmit={handleAuth} />}
    </div>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return <button className={`nav-button ${active ? 'active' : ''}`} onClick={onClick}>{children}</button>;
}

function UsageCard({ user, usageState, isVip, quotaLabel, tx, onUpgrade }: { user: User | null; usageState: Usage | null; isVip: boolean; quotaLabel: string; tx: (key: CopyKey) => string; onUpgrade: () => void }) {
  const used = usageState?.used ?? 0;
  const limit = usageState?.limit ?? 10;
  const percent = isVip || limit === null ? 100 : Math.min(100, (used / Math.max(limit, 1)) * 100);
  return <div className={`usage-card ${isVip ? 'is-vip' : ''}`}>
    <div className="usage-card-top"><div><span className="section-kicker">{tx('quotaTitle')}</span><h3>{isVip ? tx('activeVip') : quotaLabel}</h3></div><div className="quota-ring" style={{ '--quota': `${percent}%` } as React.CSSProperties}><span>{isVip ? '∞' : used}</span></div></div>
    <div className="quota-track"><span style={{ width: `${isVip ? 100 : percent}%` }} /></div>
    <p>{user ? tx('quotaHint') : tx('loginHint')}</p>
    {isVip ? <div className="vip-active-line"><Check size={14} />{user?.vipExpiresAt ? `${tx('vipExpires')} ${new Intl.DateTimeFormat('zh-CN').format(new Date(user.vipExpiresAt))}` : tx('activeVip')}</div> : <button className="text-button" onClick={onUpgrade}>{tx('upgrade')} <ArrowRight size={14} /></button>}
  </div>;
}

function PlatformCard({ tx }: { tx: (key: CopyKey) => string }) {
  return <div className="platform-card"><div className="side-card-heading"><span className="section-kicker">{tx('supported')}</span><span className="live-dot" /></div><div className="mini-platforms"><span className="mini-platform coral">抖</span><span className="mini-platform rose">小</span><span className="mini-platform blue">B</span><span className="mini-platform ink">+</span></div><div className="platform-card-copy"><strong>Douyin · Xiaohongshu · Bilibili</strong><span>{tx('platformsHint')}</span></div></div>;
}

function ResultCardBase({ job, locale, tx, onRefresh }: { job: ParseJob | null; locale: Locale; tx: (key: CopyKey) => string; onRefresh: (sourceUrl: string) => void }) {
  if (!job) return <div className="result-empty"><div className="empty-art"><span /><span /><span /></div><h3>{tx('noResult')}</h3><p>{tx('noResultHint')}</p></div>;
  if (job.status === 'failed') return <div className="result-card result-failed"><div className="result-header"><div><span className="section-kicker">{tx('resultTitle')}</span><h2>{tx('failed')}</h2></div><span className="status-pill failed">!</span></div><p className="result-error">{job.errorMessage || tx('errorFallback')}</p><div className="failed-meta"><span>{friendlyPlatform(job.platform)}</span><span>{formatDate(job.createdAt, locale)}</span></div></div>;
  const options = job.options ?? [];
  return <div className="result-card"><div className="result-header"><div><span className="section-kicker">{tx('resultTitle')}</span><h2>{job.title || tx('ready')}</h2></div><span className="status-pill"><Check size={14} />{tx('ready')}</span></div><div className="result-media"><div className="thumbnail-wrap">{job.thumbnailUrl ? <img src={job.thumbnailUrl} alt="" /> : <div className="thumbnail-fallback"><Play size={24} fill="currentColor" /></div>}<span className="thumbnail-platform">{friendlyPlatform(job.platform)}</span></div><div className="result-info"><div className="metadata-line"><span><Link2 size={13} />{tx('source')} · {friendlyPlatform(job.platform)}</span><span><Clock3 size={13} />{formatDuration(job.durationSeconds)}</span></div><p>{job.author || 'JunVideo'}</p><small>{formatDate(job.createdAt, locale)}</small></div></div><div className="download-options">{options.length > 0 ? options.map((option) => <DownloadOptionRow key={option.id} option={option} job={job} tx={tx} onRefresh={onRefresh} />) : <div className="option-placeholder"><span /><span /><span /></div>}</div></div>;
}

function ResultCard({ job, locale, tx, onRefresh }: { job: ParseJob | null; locale: Locale; tx: (key: CopyKey) => string; onRefresh: (sourceUrl: string) => void }) {
  return <>
    <ResultCardBase job={job} locale={locale} tx={tx} onRefresh={onRefresh} />
    {job && job.status !== 'failed' && <TranscriptPanel job={job} tx={tx} />}
  </>;
}

function TranscriptPanel({ job, tx }: { job: ParseJob; tx: (key: CopyKey) => string }) {
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcript, setTranscript] = useState<import('./types').TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function startTranscription() {
    setIsTranscribing(true);
    setError(null);
    try {
      setTranscript(await transcribeVideo(job));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : tx('transcriptionFailed'));
    } finally {
      setIsTranscribing(false);
    }
  }

  async function copyTranscript() {
    if (!transcript) return;
    await navigator.clipboard.writeText(transcript.correctedText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  return <section className="transcript-panel"><div className="transcript-heading"><div><span className="section-kicker">04 / {tx('transcriptTitle')}</span><h3><FileText size={17} />{tx('transcriptTitle')}</h3></div><button className="outline-button transcript-action" type="button" onClick={() => void startTranscription()} disabled={isTranscribing}>{isTranscribing ? <span className="button-spinner" /> : <FileText size={15} />}{isTranscribing ? tx('transcribing') : tx('transcribe')}</button></div>{error && <p className="transcript-error">{error}</p>}{transcript && <div className="transcript-result"><div className="transcript-result-top"><span>{transcript.correctionMode === 'openai' ? 'AI correction' : tx('correctedTranscript')}</span><button className="text-button" type="button" onClick={() => void copyTranscript()}><Copy size={14} />{copied ? tx('copied') : tx('copyTranscript')}</button></div><p>{transcript.correctedText}</p>{transcript.rawText !== transcript.correctedText && <details><summary>{tx('rawTranscript')}</summary><p>{transcript.rawText}</p></details>}</div>}</section>;
}

function DownloadOptionRow({ option, job, tx, onRefresh }: { option: DownloadOption; job: ParseJob; tx: (key: CopyKey) => string; onRefresh: (sourceUrl: string) => void }) {
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadError, setDownloadError] = useState(false);
  useEffect(() => setDownloadError(false), [job.id, option.id]);
  const isAudio = option.type === 'audio' || option.ext === 'mp3' || option.ext === 'm4a';
  const isImage = option.type === 'image';
  const href = downloadUrl(job, option.id);
  async function startDownload() {
    if (downloadError) {
      onRefresh(job.sourceUrl);
      return;
    }
    setDownloadError(false);
    setIsDownloading(true);
    try {
      const result = await downloadMedia(job, option.id);
      const objectUrl = URL.createObjectURL(result.blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = result.filename || `${job.title || 'junvideo-media'}.${option.ext || (isAudio ? 'm4a' : 'mp4')}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
    } catch {
      setDownloadError(true);
    } finally {
      setIsDownloading(false);
    }
  }
  return <div className="download-row"><div className={`download-icon ${isImage ? 'image' : isAudio ? 'audio' : 'video'}`}>{isImage ? <FileImage size={18} /> : isAudio ? <FileAudio size={18} /> : <FileVideo size={18} />}</div><div className="download-copy"><strong>{isImage ? tx('coverImage') : option.label || (isAudio ? tx('audio') : tx('video'))}</strong><span>{[option.ext?.toUpperCase(), option.quality, option.size].filter(Boolean).join(' · ') || tx('mediaStream')}</span></div><button className="download-link" type="button" onClick={() => void startDownload()} disabled={isDownloading} title={downloadError ? tx('refreshParse') : href}>{isDownloading ? <span className="button-spinner" /> : <><span>{downloadError ? tx('refreshParse') : tx('download')}</span>{downloadError ? <CircleHelp size={14} /> : <ExternalLink size={14} />}</>}</button></div>;
}

function StepCard({ number, icon, title, hint }: { number: string; icon: React.ReactNode; title: string; hint: string }) {
  return <div className="step-card"><div className="step-card-top"><span className="step-number">{number}</span><span className="step-icon">{icon}</span></div><h3>{title}</h3><p>{hint}</p></div>;
}

function PlatformBadge({ code, platformKey, label, tone }: { code: string; platformKey: string; label: string; tone: string }) {
  return <div className={`platform-badge ${tone}`}><span className="platform-code">{code}</span><span>{label}</span>{platformKey === 'more' ? <Plus size={14} /> : <Check size={14} className="platform-check" />}</div>;
}

function HistoryView({ items, isLoading, locale, tx, onPick }: { items: ParseJob[]; isLoading: boolean; locale: Locale; tx: (key: CopyKey) => string; onPick: (item: ParseJob) => void }) {
  return <main className="subpage page-width"><div className="subpage-heading"><div><span className="eyebrow"><span className="eyebrow-dot" />04 / ARCHIVE</span><h1>{tx('navHistory')}</h1><p>{tx('emptyHistoryHint')}</p></div><button className="outline-button" onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}><Link2 size={16} />{tx('navWorkbench')}</button></div><div className="history-list">{isLoading ? <div className="loading-block"><span className="button-spinner" />{tx('systemChecking')}</div> : items.length === 0 ? <div className="history-empty"><HistoryIcon size={28} /><h2>{tx('emptyHistory')}</h2><p>{tx('emptyHistoryHint')}</p></div> : items.map((item) => <button className="history-row" key={item.id} onClick={() => onPick(item)}><div className="history-thumb">{item.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" /> : <Play size={18} fill="currentColor" />}</div><div className="history-main"><strong>{item.title || item.sourceUrl}</strong><span>{friendlyPlatform(item.platform)} · {formatDate(item.createdAt, locale)}</span></div><span className={`history-status ${item.status}`}>{item.status === 'completed' ? <Check size={14} /> : item.status === 'failed' ? '!' : <span className="button-spinner" />}</span><ChevronRight size={18} /></button>)}</div></main>;
}

function VipView({ user, isVip, locale, tx, onActivate, onLogin }: { user: User | null; isVip: boolean; locale: Locale; tx: (key: CopyKey) => string; onActivate: () => void; onLogin: () => void }) {
  return <main className="vip-page page-width"><div className="vip-hero"><div><span className="eyebrow"><Sparkles size={15} />05 / MEMBERSHIP</span><h1>{tx('vipTitle')}</h1><p>{tx('vipSubtitle')}</p></div><div className="vip-spark"><Sparkles size={34} /><span>∞</span></div></div><div className="plan-card"><div className="plan-main"><div className="plan-icon"><Zap size={20} /></div><div><span className="section-kicker">JUNVIDEO VIP</span><h2>{tx('monthly')}</h2><p>{tx('devBillingNote')}</p></div></div><div className="plan-price"><strong>{tx('monthlyPrice')}</strong><span>{tx('monthlyUnit')}</span></div><div className="plan-features"><span><Check size={15} />{tx('vipFeatureOne')}</span><span><Check size={15} />{tx('vipFeatureTwo')}</span><span><Check size={15} />{tx('vipFeatureThree')}</span></div><button className={`primary-button plan-cta ${isVip ? 'is-active' : ''}`} onClick={onActivate}>{isVip ? <><Check size={17} />{tx('activated')}</> : <><Sparkles size={17} />{user ? tx('activate') : tx('signIn')}</>}</button></div><div className="vip-footnote"><ShieldCheck size={17} /><span>{tx('legal')}</span></div></main>;
}

function AuthDialog({ mode, locale, tx, onClose, onSwitch, onSubmit }: { mode: 'login' | 'register'; locale: Locale; tx: (key: CopyKey) => string; onClose: () => void; onSwitch: () => void; onSubmit: (mode: 'login' | 'register', values: { name: string; email: string; password: string }) => Promise<void> }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const isRegister = mode === 'register';
  async function submit(event: FormEvent) {
    event.preventDefault();
    setPending(true);
    try {
      await onSubmit(mode, { name, email, password });
    } finally {
      setPending(false);
    }
  }
  return <div className="modal-backdrop" role="dialog" aria-modal="true" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div className="auth-modal"><button className="modal-close" onClick={onClose} aria-label={tx('close')}><X size={18} /></button><div className="auth-visual"><span className="section-kicker">JUNVIDEO / 2026</span><div className="auth-visual-mark"><span>J</span><span>V</span></div><p>{tx('footer')}</p></div><div className="auth-form-panel"><div className="auth-heading"><span className="eyebrow-dot" /><h2>{isRegister ? tx('registerTitle') : tx('loginTitle')}</h2><p>{isRegister ? tx('registerHint') : tx('loginHint')}</p></div><form onSubmit={submit}>{isRegister && <label>{tx('name')}<div className="input-with-icon"><UserRound size={16} /><input value={name} onChange={(event) => setName(event.target.value)} placeholder={tx('namePlaceholder')} autoComplete="name" required /></div></label>}<label>{tx('email')}<div className="input-with-icon"><span className="input-symbol">@</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={tx('emailPlaceholder')} autoComplete="email" required /></div></label><label>{tx('password')}<div className="input-with-icon"><ShieldCheck size={16} /><input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={tx('passwordPlaceholder')} minLength={8} autoComplete={isRegister ? 'new-password' : 'current-password'} required /></div></label><button className="primary-button auth-submit" disabled={pending}>{pending ? <span className="button-spinner light" /> : <>{isRegister ? <Plus size={17} /> : <LogIn size={17} />}</>}{pending ? tx('parsing') : isRegister ? tx('registerAction') : tx('loginAction')}</button></form><button className="switch-auth" onClick={onSwitch}>{isRegister ? tx('switchToLogin') : tx('switchToRegister')}<ArrowRight size={14} /></button><div className="auth-privacy"><ShieldCheck size={14} />{tx('legal')}</div></div></div></div>;
}

function showError(error: unknown, tx: (key: CopyKey) => string, setNotice: (notice: { type: 'error' | 'success' | 'info'; text: string }) => void, onAuth?: () => void) {
  if (error instanceof ApiError && error.status === 401) {
    onAuth?.();
    setNotice({ type: 'error', text: error.message });
    return;
  }
  if (error instanceof ApiError && error.code === 'PARSER_UNAVAILABLE') {
    setNotice({ type: 'error', text: tx('parserUnavailable') });
    return;
  }
  setNotice({ type: 'error', text: error instanceof Error ? error.message : tx('errorFallback') });
}

export default App;
