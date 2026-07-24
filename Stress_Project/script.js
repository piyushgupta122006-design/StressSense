/* =========================================================
   StressSense — script.js
   All app logic: routing, typing tracker, stress engine,
   history, charts (Chart.js via CDN).
   ========================================================= */

'use strict';

/* ── Constants ─────────────────────────────────────────── */
const TYPING_PROMPT =
  'The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. ' +
  'How vexingly quick daft zebras jump! A completely focused mind writes seamlessly, ' +
  'while a busy one pauses and hesitates.';

const HISTORY_KEY     = 'stresssense_history';
const LAST_RESULT_KEY = 'stresssense_last_result';

const CAT_COLORS = { Low: '#10b981', Moderate: '#f59e0b', High: '#ef4444' };

/* ═══════════════════════════════════════════════════════════
   ROUTER
   ═══════════════════════════════════════════════════════════ */
const pages   = {};  // id → <section> element
const navLinks = {}; // id → <a> element
let currentPage = null;

function registerPage(id, el) { pages[id] = el; }
function registerNavLink(id, el) { navLinks[id] = el; }

function navigateTo(id) {
  // hide current
  if (currentPage && pages[currentPage]) {
    pages[currentPage].classList.remove('active');
  }
  Object.values(navLinks).forEach(a => a.classList.remove('active'));

  currentPage = id;
  const el = pages[id];
  if (!el) return;

  el.classList.add('active');
  if (navLinks[id]) navLinks[id].classList.add('active');

  // Re-animate children
  el.querySelectorAll('[class*="animate-"]').forEach(child => {
    child.style.animation = 'none';
    void child.offsetWidth; // reflow
    child.style.animation = '';
  });

  // Page lifecycle hooks
  if (id === 'results') onResultsEnter();
  if (id === 'test')    onTestEnter();

  window.scrollTo(0, 0);
}

/* ═══════════════════════════════════════════════════════════
   STRESS ENGINE
   ═══════════════════════════════════════════════════════════ */
function clamp01(val, min, max) {
  return Math.max(0, Math.min(1, (val - min) / (max - min)));
}

function analyzeStress(input) {
  const speedContrib  = 1 - clamp01(input.typingSpeed,    30,  70);
  const errorContrib  =     clamp01(input.errorRate,       0, 0.1);
  const rhythmContrib =     clamp01(input.rhythmVariation, 50, 300);
  const screenContrib =     clamp01(input.screenTime,      2,   10);
  const nightContrib  =     clamp01(input.nightUsage,      0,    3);
  const appContrib    =     clamp01(input.appSwitches,    20,  150);

  const rawScore =
    speedContrib  * 0.20 +
    errorContrib  * 0.20 +
    rhythmContrib * 0.15 +
    screenContrib * 0.20 +
    nightContrib  * 0.15 +
    appContrib    * 0.10;

  const score = Math.round(rawScore * 40);

  let category = 'Low';
  if (score >= 27) category = 'High';
  else if (score >= 14) category = 'Moderate';

  // Gaussian soft confidence
  const pLow  = Math.max(0, 1 - Math.abs(score - 7)  / 20);
  const pMod  = Math.max(0, 1 - Math.abs(score - 20) / 20);
  const pHigh = Math.max(0, 1 - Math.abs(score - 33) / 20);
  const sum   = pLow + pMod + pHigh || 1;

  const confidence = {
    low:      Math.round((pLow  / sum) * 100),
    moderate: Math.round((pMod  / sum) * 100),
    high:     Math.round((pHigh / sum) * 100),
  };
  const total = confidence.low + confidence.moderate + confidence.high;
  if (total !== 100) confidence.moderate += (100 - total);

  function impact(v) {
    if (v < 0.35) return 'positive';
    if (v > 0.65) return 'negative';
    return 'neutral';
  }

  const signals = [
    { name: 'Typing Rhythm',  value: `${Math.round(input.rhythmVariation)}ms var`, impact: impact(rhythmContrib), description: 'Consistency of keystroke timing' },
    { name: 'Typing Speed',   value: `${Math.round(input.typingSpeed)} WPM`,        impact: impact(speedContrib),  description: 'Words per minute compared to baseline' },
    { name: 'Error Rate',     value: `${(input.errorRate * 100).toFixed(1)}%`,       impact: impact(errorContrib),  description: 'Frequency of corrections and backspaces' },
    { name: 'Screen Time',    value: `${input.screenTime.toFixed(1)} hrs`,           impact: impact(screenContrib), description: 'Total daily device usage' },
    { name: 'Night Usage',    value: `${input.nightUsage.toFixed(1)} hrs`,           impact: impact(nightContrib),  description: 'Usage between 12AM and 5AM' },
    { name: 'App Switching',  value: `${input.appSwitches} times`,                   impact: impact(appContrib),    description: 'Frequency of jumping between applications' },
  ];

  return { score, category, confidence, signals, timestamp: Date.now(), input };
}

/* ═══════════════════════════════════════════════════════════
   HISTORY (localStorage)
   ═══════════════════════════════════════════════════════════ */
function saveResult(result) {
  try {
    localStorage.setItem(LAST_RESULT_KEY, JSON.stringify(result));
    const history = getHistory();
    history.unshift(result);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch (e) { console.error('Failed to save result', e); }
}

function getHistory() {
  try {
    const d = localStorage.getItem(HISTORY_KEY);
    return d ? JSON.parse(d) : [];
  } catch (e) { return []; }
}

function getLastResult() {
  try {
    const d = localStorage.getItem(LAST_RESULT_KEY);
    return d ? JSON.parse(d) : null;
  } catch (e) { return null; }
}

/* ═══════════════════════════════════════════════════════════
   TYPING TRACKER STATE
   ═══════════════════════════════════════════════════════════ */
let typing = {
  startTime:      null,
  keystrokes:     [],
  backspaces:     0,
  totalChars:     0,
  wpm:            0,
  errorRate:      0,
  rhythmVariation:0,
  wordCount:      0,
  isActive:       false,
};

function resetTyping() {
  typing = {
    startTime: null, keystrokes: [], backspaces: 0, totalChars: 0,
    wpm: 0, errorRate: 0, rhythmVariation: 0, wordCount: 0, isActive: false,
  };
}

function handleKeyDown(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Tab','Escape'].includes(e.key)) return;

  const now = performance.now();
  if (!typing.startTime) { typing.startTime = now; typing.isActive = true; }

  const elapsed = (now - typing.startTime) / 1000; // seconds

  if (e.key === 'Backspace') {
    typing.backspaces++;
  } else if (e.key.length === 1) {
    typing.totalChars++;
  }

  typing.keystrokes.push(now);

  if (typing.totalChars > 0) {
    typing.errorRate = typing.backspaces / (typing.totalChars + typing.backspaces);
  }

  const words = typing.totalChars / 5;
  typing.wordCount = Math.floor(words);

  if (elapsed > 0) {
    typing.wpm = Math.round((words / elapsed) * 60);
  }

  // Rhythm variation = std dev of inter-keystroke intervals
  const ks = typing.keystrokes;
  if (ks.length > 2) {
    const intervals = [];
    for (let i = 1; i < ks.length; i++) intervals.push(ks[i] - ks[i-1]);
    const mean  = intervals.reduce((a,b) => a+b, 0) / intervals.length;
    const vari  = intervals.reduce((a,b) => a + Math.pow(b-mean,2), 0) / intervals.length;
    typing.rhythmVariation = Math.sqrt(vari);
  }

  updateTypingUI();
}

/* ═══════════════════════════════════════════════════════════
   TEST PAGE
   ═══════════════════════════════════════════════════════════ */
let sliderValues = { screenTime: 6, nightUsage: 0.5, appSwitches: 45 };

function onTestEnter() {
  resetTyping();

  const textarea = document.getElementById('typing-textarea');
  if (textarea) {
    textarea.value = '';
    textarea.focus();
  }

  // Reset stat boxes
  setEl('stat-wpm',   '0 <span>WPM</span>');
  setEl('stat-error', '0.0<span>%</span>');
  setEl('stat-words', '0<span>/20</span>');

  updateAnalyzeBtn();
  updateSliderUI('screen-time',   sliderValues.screenTime,   0, 16,   v => `${v.toFixed(1)} hrs`);
  updateSliderUI('night-usage',   sliderValues.nightUsage,   0,  5,   v => `${v.toFixed(1)} hrs`);
  updateSliderUI('app-switches',  sliderValues.appSwitches,  0, 200,  v => `${v}`);
}

function updateTypingUI() {
  const wpmEl   = document.getElementById('stat-wpm');
  const errEl   = document.getElementById('stat-error');
  const wordsEl = document.getElementById('stat-words');

  if (wpmEl)   wpmEl.innerHTML   = `${typing.wpm} <span>WPM</span>`;
  if (errEl)   errEl.innerHTML   = `${(typing.errorRate * 100).toFixed(1)}<span>%</span>`;
  if (wordsEl) {
    wordsEl.innerHTML = `${typing.wordCount}<span>/20</span>`;
    wordsEl.classList.toggle('ready', typing.wordCount >= 20);
  }

  updateAnalyzeBtn();
}

function updateAnalyzeBtn() {
  const btn  = document.getElementById('analyze-btn');
  const hint = document.getElementById('analyze-hint');
  if (!btn) return;
  const ready = typing.wordCount >= 20;
  btn.disabled = !ready;
  if (hint) hint.style.display = ready ? 'none' : 'block';
}

function updateSliderUI(id, val, min, max, fmt) {
  const input = document.getElementById(`slider-${id}`);
  const label = document.getElementById(`val-${id}`);
  if (input) {
    input.value = val;
    const pct = ((val - min) / (max - min)) * 100;
    input.style.setProperty('--pct', `${pct}%`);
  }
  if (label) label.textContent = fmt(val);
}

function setEl(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

/* ═══════════════════════════════════════════════════════════
   RESULTS PAGE
   ═══════════════════════════════════════════════════════════ */
let donutChart = null;
let lineChart  = null;

function onResultsEnter() {
  const result = getLastResult();
  if (!result) { navigateTo('test'); return; }

  renderScoreCard(result);
  renderSignals(result);
  renderDonut(result);
  renderHistory();
}

function renderScoreCard(result) {
  const color = CAT_COLORS[result.category];

  const bar = document.getElementById('score-bar');
  if (bar) bar.style.backgroundColor = color;

  setEl('score-number', `${result.score}<span class="score-card__denom">/40</span>`);

  const badge = document.getElementById('category-badge');
  if (badge) {
    badge.className = `category-badge badge--${result.category}`;
    badge.innerHTML = `<span class="category-dot dot--${result.category}"></span>${result.category}`;
  }

  setEl('result-label', 'Estimated Stress Level');
}

function renderSignals(result) {
  const grid = document.getElementById('signals-grid');
  if (!grid) return;

  const arrowUp   = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 19V5M5 12l7-7 7 7"/></svg>`;
  const arrowDown = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12l7 7 7-7"/></svg>`;
  const dash      = `<div style="width:8px;height:2px;background:currentColor;border-radius:2px"></div>`;

  grid.innerHTML = result.signals.map((s, i) => {
    const dotClass = `signal-dot--${s.impact}`;
    const icon     = s.impact === 'negative' ? arrowUp : s.impact === 'positive' ? arrowDown : dash;
    return `
      <div class="signal-card animate-fadeup" style="animation-delay:${i * 0.07}s">
        <div class="signal-card__header">
          <span class="signal-card__name">${s.name}</span>
          <div class="signal-dot ${dotClass}">${icon}</div>
        </div>
        <div class="signal-card__value">${s.value}</div>
        <div class="signal-card__desc">${s.description}</div>
      </div>`;
  }).join('');
}

function renderDonut(result) {
  const canvas = document.getElementById('donut-chart');
  if (!canvas) return;

  const conf   = result.confidence;
  const maxPct = Math.max(conf.low, conf.moderate, conf.high);

  // Center label
  const centerEl = document.getElementById('donut-center-val');
  if (centerEl) centerEl.textContent = `${maxPct}%`;

  // Legend
  const legendEl = document.getElementById('conf-legend');
  if (legendEl) {
    legendEl.innerHTML = [
      { label: 'Low',      pct: conf.low,      color: CAT_COLORS.Low },
      { label: 'Moderate', pct: conf.moderate,  color: CAT_COLORS.Moderate },
      { label: 'High',     pct: conf.high,      color: CAT_COLORS.High },
    ].map(r => `
      <div class="conf-legend-row">
        <span class="conf-legend-dot" style="background:${r.color}"></span>
        <span class="conf-legend-label">${r.label}</span>
        <span class="conf-legend-pct">${r.pct}%</span>
      </div>`).join('');
  }

  if (donutChart) { donutChart.destroy(); donutChart = null; }

  donutChart = new Chart(canvas, {
    type: 'doughnut',
    data: {
      labels: ['Low', 'Moderate', 'High'],
      datasets: [{
        data: [conf.low, conf.moderate, conf.high],
        backgroundColor: [CAT_COLORS.Low, CAT_COLORS.Moderate, CAT_COLORS.High],
        borderWidth: 0,
        hoverOffset: 4,
      }],
    },
    options: {
      cutout: '68%',
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => ` ${ctx.label}: ${ctx.parsed}%` }
      }},
      animation: { animateRotate: true, duration: 700 },
    },
  });
}

function renderHistory() {
  const history     = getHistory().slice().reverse(); // oldest first
  const section     = document.getElementById('trend-section');
  const canvas      = document.getElementById('line-chart');
  if (!section || !canvas) return;

  if (history.length < 2) { section.style.display = 'none'; return; }
  section.style.display = 'block';

  const labels = history.map(h =>
    new Date(h.timestamp).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' })
  );
  const scores = history.map(h => h.score);

  if (lineChart) { lineChart.destroy(); lineChart = null; }

  lineChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Stress Score',
        data: scores,
        borderColor: '#3d7a72',
        backgroundColor: 'rgba(61,122,114,.08)',
        borderWidth: 3,
        pointRadius: 5,
        pointBackgroundColor: '#3d7a72',
        pointBorderWidth: 0,
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: {
          min: 0, max: 40,
          grid: { color: 'rgba(0,0,0,.06)' },
          ticks: { color: '#6b857f', font: { size: 11 } },
          border: { display: false },
        },
        x: {
          grid: { display: false },
          ticks: { color: '#6b857f', font: { size: 10 }, maxTicksLimit: 8 },
          border: { display: false },
        },
      },
    },
  });
}

/* ═══════════════════════════════════════════════════════════
   DOM INIT
   ═══════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {

  /* ── Register pages ─────────────────────────────────── */
  ['home','test','results','how-it-works'].forEach(id => {
    const el = document.getElementById(`page-${id}`);
    if (el) registerPage(id, el);
  });

  /* ── Register nav links ─────────────────────────────── */
  document.querySelectorAll('[data-nav]').forEach(a => {
    registerNavLink(a.dataset.nav, a);
    a.addEventListener('click', e => { e.preventDefault(); navigateTo(a.dataset.nav); });
  });

  /* ── Typing textarea ────────────────────────────────── */
  const textarea = document.getElementById('typing-textarea');
  if (textarea) {
    textarea.addEventListener('keydown', handleKeyDown);
  }

  /* ── Slider: screen time ───────────────────────────── */
  const sliderScreen = document.getElementById('slider-screen-time');
  if (sliderScreen) {
    sliderScreen.addEventListener('input', () => {
      sliderValues.screenTime = parseFloat(sliderScreen.value);
      updateSliderUI('screen-time', sliderValues.screenTime, 0, 16, v => `${v.toFixed(1)} hrs`);
    });
  }

  /* ── Slider: night usage ────────────────────────────── */
  const sliderNight = document.getElementById('slider-night-usage');
  if (sliderNight) {
    sliderNight.addEventListener('input', () => {
      sliderValues.nightUsage = parseFloat(sliderNight.value);
      updateSliderUI('night-usage', sliderValues.nightUsage, 0, 5, v => `${v.toFixed(1)} hrs`);
    });
  }

  /* ── Slider: app switches ───────────────────────────── */
  const sliderApps = document.getElementById('slider-app-switches');
  if (sliderApps) {
    sliderApps.addEventListener('input', () => {
      sliderValues.appSwitches = parseInt(sliderApps.value, 10);
      updateSliderUI('app-switches', sliderValues.appSwitches, 0, 200, v => `${v}`);
    });
  }

  /* ── Analyze button ─────────────────────────────────── */
  const analyzeBtn = document.getElementById('analyze-btn');
  if (analyzeBtn) {
    analyzeBtn.addEventListener('click', () => {
      if (typing.wordCount < 20) return;
      const result = analyzeStress({
        typingSpeed:     typing.wpm,
        errorRate:       typing.errorRate,
        rhythmVariation: typing.rhythmVariation,
        screenTime:      sliderValues.screenTime,
        nightUsage:      sliderValues.nightUsage,
        appSwitches:     sliderValues.appSwitches,
      });
      saveResult(result);
      navigateTo('results');
    });
  }

  /* ── Retake test buttons ─────────────────────────────── */
  document.querySelectorAll('[data-action="retake"]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo('test'));
  });

  /* ── Start now (from home) ──────────────────────────── */
  document.querySelectorAll('[data-action="start"]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo('test'));
  });

  /* ── How it works links ─────────────────────────────── */
  document.querySelectorAll('[data-action="how"]').forEach(btn => {
    btn.addEventListener('click', () => navigateTo('how-it-works'));
  });

  /* ── Start on home ──────────────────────────────────── */
  navigateTo('home');
});
