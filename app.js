/**
 * AI Literacy in Radiation Oncology — Static Assessment Application
 * Stack: Vanilla JS + Tailwind CSS + PapaParse + Supabase + jsPDF + canvas-confetti
 */

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  // Replace with your Supabase Project URL and public anon key:
  SUPABASE_URL: 'YOUR_SUPABASE_PROJECT_URL',
  SUPABASE_ANON_KEY: 'YOUR_SUPABASE_ANON_KEY',
  SUPABASE_TABLE: 'quiz_submissions',

  // Primary CSV path + automatic fallback to the uploaded filename:
  CSV_PATHS: ['./questions_multilingual.csv', './questions_multilingual (3).csv'],

  PASS_THRESHOLD: 0.65, // 65% required to pass
  STORAGE_KEY: 'ro_ai_literacy_quiz_state_v1'
};

const CATEGORIES = {
  0: {
    name: 'Background & Self-Assessment',
    shortName: 'Background Survey',
    scored: false,
    badgeClass: 'bg-slate-100 text-slate-700'
  },
  1: {
    name: 'Foundational AI & ML Concepts',
    shortName: '1. Foundational AI & ML',
    scored: true,
    badgeClass: 'bg-sky-100 text-brand-navy'
  },
  2: {
    name: 'Clinical Integration, QA & Validation',
    shortName: '2. Clinical QA & Validation',
    scored: true,
    badgeClass: 'bg-teal-100 text-teal-900'
  },
  3: {
    name: 'Model Development & Training',
    shortName: '3. Model Training & Dev',
    scored: true,
    badgeClass: 'bg-indigo-100 text-indigo-900'
  }
};

const SUPPORTED_LANGS = ['en', 'nl', 'es', 'fr', 'it', 'de', 'da'];

// ============================================================================
// 2. APPLICATION STATE
// ============================================================================
let questions = []; // Parsed from CSV
let supabaseClient = null;
let reviewFilter = 'all'; // 'all' | 'missed'

let state = getInitialState();

function getInitialState() {
  return {
    stage: 'welcome', // 'welcome' | 'quiz' | 'results'
    lang: 'en',
    participant: {
      name: '',
      email: '',
      consent: false
    },
    currentIndex: 0,
    answers: {}, // { [questionId]: selectedOptionNumber (1..4) }
    milestonesShown: { q25: false, q50: false, q75: false },
    verificationId: generateVerificationId(),
    completedAt: null,
    dbSynced: false,
    lastReport: null
  };
}

function generateVerificationId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = 'ROAI-';
  for (let i = 0; i < 6; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

// ============================================================================
// 3. INITIALIZATION & CSV PARSING
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  initSupabase();
  bindEvents();
  await loadCSVWithFallback();
});

function initSupabase() {
  if (
    window.supabase &&
    CONFIG.SUPABASE_URL &&
    CONFIG.SUPABASE_URL !== 'YOUR_SUPABASE_PROJECT_URL' &&
    CONFIG.SUPABASE_ANON_KEY &&
    CONFIG.SUPABASE_ANON_KEY !== 'YOUR_SUPABASE_ANON_KEY'
  ) {
    try {
      supabaseClient = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
    } catch (err) {
      console.warn('Supabase initialization skipped:', err);
    }
  }
}

/**
 * Clean Windows-1252 smart quotes / encoding artifacts present in CSV cells
 */
function cleanText(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw)
    .replace(/[\u0091\u0092\u2018\u2019]/g, "'")
    .replace(/[\u0093\u0094\u201C\u201D]/g, '"')
    .replace(/[\u0096\u0097\u2013\u2014]/g, '—')
    .replace(/\uFFFD/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function loadCSVWithFallback() {
  let csvText = null;
  let lastError = null;

  for (const path of CONFIG.CSV_PATHS) {
    try {
      const response = await fetch(encodeURI(path), { cache: 'no-cache' });
      if (response.ok) {
        csvText = await response.text();
        break;
      } else {
        lastError = `HTTP ${response.status} (${path})`;
      }
    } catch (err) {
      lastError = err.message;
    }
  }

  if (!csvText) {
    showCSVError(
      `Unable to automatically fetch "./questions_multilingual.csv" (${lastError}). If you opened index.html directly from your computer (file://), browsers block local file fetching for security. Use the file selector below or run a local web server / GitHub Pages.`
    );
    return;
  }

  parseCSVContent(csvText);
}

function parseCSVContent(csvText) {
  Papa.parse(csvText, {
    header: true,
    skipEmptyLines: true,
    complete: (results) => {
      const parsed = (results.data || [])
        .map((row) => ({
          id: parseInt(row.id, 10),
          category: parseInt(row.category, 10),
          correct_option: parseInt(row.correct_option, 10),
          raw: row
        }))
        .filter((q) => !Number.isNaN(q.id));

      if (parsed.length === 0) {
        showCSVError('The CSV file was loaded, but no valid question rows were found.');
        return;
      }

      questions = parsed.sort((a, b) => a.id - b.id);
      document.getElementById('loading-state').classList.add('hidden');
      document.getElementById('error-state').classList.add('hidden');

      checkSavedSessionAndBoot();
    },
    error: (err) => {
      showCSVError(`CSV Parse Error: ${err.message}`);
    }
  });
}

function showCSVError(msg) {
  document.getElementById('loading-state').classList.add('hidden');
  const errBox = document.getElementById('error-state');
  errBox.classList.remove('hidden');
  document.getElementById('error-message').textContent = msg;
}

/**
 * Retrieve localized question & options for the active language (falls back to English)
 */
function getLocalizedQuestion(q, lang = state.lang) {
  const row = q.raw;
  const code = SUPPORTED_LANGS.includes(lang) ? lang : 'en';

  const questionText = cleanText(row[`question_${code}`] || row.question_en);
  const options = [1, 2, 3, 4].map((idx) =>
    cleanText(row[`option_${idx}_${code}`] || row[`option_${idx}_en`])
  );

  return {
    id: q.id,
    category: q.category,
    correctOption: q.correct_option,
    isScored: q.correct_option > 0,
    questionText,
    options
  };
}

// ============================================================================
// 4. LOCAL STORAGE & SESSION RESUME
// ============================================================================
function saveStateToStorage() {
  try {
    localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('Could not save state to localStorage:', e);
  }
}

function clearSavedStorage() {
  try {
    localStorage.removeItem(CONFIG.STORAGE_KEY);
  } catch (e) {
    console.warn('Could not clear localStorage:', e);
  }
}

function checkSavedSessionAndBoot() {
  try {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      if (saved && saved.lang && SUPPORTED_LANGS.includes(saved.lang)) {
        state.lang = saved.lang;
        document.getElementById('lang-selector').value = state.lang;
      }

      const answeredCount = saved && saved.answers ? Object.keys(saved.answers).length : 0;
      if (saved && (saved.stage === 'quiz' || saved.stage === 'results') && answeredCount > 0) {
        const banner = document.getElementById('resume-banner');
        const text = document.getElementById('resume-progress-text');
        banner.classList.remove('hidden');
        text.textContent =
          saved.stage === 'results'
            ? `Completed session for ${saved.participant?.name || 'Participant'} (${answeredCount}/${questions.length} answered).`
            : `Welcome back, ${saved.participant?.name || 'Participant'} — ${answeredCount} of ${questions.length} questions answered.`;
      }
    }
  } catch (e) {
    console.warn('Failed to read saved session:', e);
  }

  showStage('welcome');
}

// ============================================================================
// 5. STAGE NAVIGATION & UI RENDERING
// ============================================================================
function showStage(stageName) {
  state.stage = stageName;

  const welcomeEl = document.getElementById('stage-welcome');
  const quizEl = document.getElementById('stage-quiz');
  const resultsEl = document.getElementById('stage-results');
  const sidebarEl = document.getElementById('quiz-sidebar');
  const mobileToggleEl = document.getElementById('mobile-sidebar-toggle');

  welcomeEl.classList.add('hidden');
  quizEl.classList.add('hidden');
  resultsEl.classList.add('hidden');

  if (stageName === 'welcome') {
    welcomeEl.classList.remove('hidden');
    sidebarEl.classList.add('hidden');
    sidebarEl.classList.remove('flex');
    mobileToggleEl.classList.add('hidden');
  } else if (stageName === 'quiz') {
    quizEl.classList.remove('hidden');
    sidebarEl.classList.remove('hidden');
    sidebarEl.classList.add('flex');
    mobileToggleEl.classList.remove('hidden');
    renderSidebar();
    renderCurrentQuestion();
  } else if (stageName === 'results') {
    resultsEl.classList.remove('hidden');
    sidebarEl.classList.remove('hidden');
    sidebarEl.classList.add('flex');
    mobileToggleEl.classList.remove('hidden');
    renderSidebar();
    renderResultsStage();
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderSidebar() {
  const total = questions.length;
  const answeredCount = Object.keys(state.answers).length;
  const pct = total > 0 ? Math.round((answeredCount / total) * 100) : 0;

  document.getElementById('sidebar-progress-text').textContent = `${answeredCount} / ${total} complete`;
  document.getElementById('sidebar-progress-bar').style.width = `${pct}%`;

  const container = document.getElementById('sidebar-checklist');
  container.innerHTML = '';

  // Group questions by category (0, 1, 2, 3)
  [0, 1, 2, 3].forEach((catId) => {
    const catQuestions = questions.filter((q) => q.category === catId);
    if (catQuestions.length === 0) return;

    const catMeta = CATEGORIES[catId] || { shortName: `Category ${catId}`, scored: true };
    const groupDiv = document.createElement('div');

    const header = document.createElement('div');
    header.className = 'text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between';
    const catDone = catQuestions.filter((q) => state.answers[q.id] !== undefined).length;
    header.innerHTML = `<span>${catMeta.shortName}</span><span class="text-[11px] font-medium">${catDone}/${catQuestions.length}</span>`;
    groupDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'space-y-1';

    catQuestions.forEach((q) => {
      const qIndex = questions.findIndex((item) => item.id === q.id);
      const isCurrent = state.stage === 'quiz' && qIndex === state.currentIndex;
      const isAnswered = state.answers[q.id] !== undefined;
      const loc = getLocalizedQuestion(q);

      let icon = '⚪';
      if (state.stage === 'results' && loc.isScored) {
        icon = state.answers[q.id] === loc.correctOption ? '✅' : '🟡';
      } else if (isCurrent) {
        icon = '🔵';
      } else if (isAnswered) {
        icon = '✅';
      }

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `w-full text-left px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-2 transition ${
        isCurrent
          ? 'bg-brand-light text-brand-navy font-bold border border-brand-teal/30'
          : 'text-slate-600 hover:bg-slate-100'
      }`;

      const shortTitle =
        loc.questionText.length > 42 ? `${loc.questionText.slice(0, 42)}…` : loc.questionText;

      btn.innerHTML = `<span class="shrink-0">${icon}</span><span class="truncate">Q${q.id}. ${escapeHTML(shortTitle)}</span>`;

      btn.addEventListener('click', () => {
        if (state.stage === 'quiz') {
          state.currentIndex = qIndex;
          saveStateToStorage();
          renderSidebar();
          renderCurrentQuestion();
          closeMobileSidebar();
        }
      });

      list.appendChild(btn);
    });

    groupDiv.appendChild(list);
    container.appendChild(groupDiv);
  });
}

function renderCurrentQuestion() {
  const q = questions[state.currentIndex];
  if (!q) return;

  const loc = getLocalizedQuestion(q);
  const catMeta = CATEGORIES[loc.category] || CATEGORIES[1];

  // Animate card subtly
  const card = document.getElementById('question-card');
  card.classList.add('card-enter');
  requestAnimationFrame(() => {
    setTimeout(() => card.classList.remove('card-enter'), 30);
  });

  // Top badges
  const badgeEl = document.getElementById('q-category-badge');
  badgeEl.className = `px-3 py-1 rounded-full text-xs font-semibold ${catMeta.badgeClass}`;
  badgeEl.textContent = catMeta.name;

  const pillEl = document.getElementById('q-type-pill');
  if (loc.isScored) {
    pillEl.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
    pillEl.textContent = 'Scored Knowledge Question';
  } else {
    pillEl.className = 'px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600';
    pillEl.textContent = 'Part 1: Background Survey (Unscored)';
  }

  document.getElementById('q-counter').textContent = `Question ${state.currentIndex + 1} of ${questions.length}`;
  document.getElementById('q-text').textContent = loc.questionText;

  // Options
  const optionsContainer = document.getElementById('options-container');
  optionsContainer.innerHTML = '';
  const selectedVal = state.answers[q.id];

  loc.options.forEach((optText, idx) => {
    const optNum = idx + 1;
    const isSelected = selectedVal === optNum;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', isSelected ? 'true' : 'false');
    btn.className = `option-btn w-full text-left p-4 rounded-xl border-2 flex items-start gap-3.5 focus:outline-none ${
      isSelected
        ? 'border-brand-teal bg-brand-light/70 text-brand-navy shadow-sm'
        : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50/70 text-slate-800'
    }`;

    btn.innerHTML = `
      <span class="w-7 h-7 rounded-lg text-xs font-bold flex items-center justify-center shrink-0 mt-0.5 ${
        isSelected ? 'bg-brand-teal text-white' : 'bg-slate-100 text-slate-600'
      }">${optNum}</span>
      <span class="text-sm sm:text-base font-medium leading-relaxed">${escapeHTML(optText)}</span>
    `;

    btn.addEventListener('click', () => selectOption(q.id, optNum));
    optionsContainer.appendChild(btn);
  });

  // Buttons state
  document.getElementById('btn-prev').disabled = state.currentIndex === 0;
  const nextBtn = document.getElementById('btn-next');
  const isLast = state.currentIndex === questions.length - 1;
  nextBtn.textContent = isLast ? 'Submit Assessment ✓' : 'Next Question →';
  nextBtn.className = isLast
    ? 'px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm transition'
    : 'px-6 py-2.5 rounded-xl bg-brand-navy hover:bg-brand-teal text-white text-sm font-semibold shadow-sm transition';
}

function selectOption(questionId, optionNumber) {
  state.answers[questionId] = optionNumber;
  document.getElementById('unanswered-warning').classList.add('hidden');

  checkAndTriggerMilestones();
  saveStateToStorage();
  renderSidebar();
  renderCurrentQuestion();
}

function checkAndTriggerMilestones() {
  const total = questions.length;
  const done = Object.keys(state.answers).length;
  if (total < 8) return;

  const q25 = Math.round(total * 0.25);
  const q50 = Math.round(total * 0.5);
  const q75 = Math.round(total * 0.75);

  if (done === q25 && !state.milestonesShown.q25) {
    state.milestonesShown.q25 = true;
    showToast('🚀 A quarter of the way — nice momentum!');
  } else if (done === q50 && !state.milestonesShown.q50) {
    state.milestonesShown.q50 = true;
    showToast('⚡ Halfway there! Your progress is automatically saved.');
  } else if (done === q75 && !state.milestonesShown.q75) {
    state.milestonesShown.q75 = true;
    showToast('🏁 Three quarters done — home stretch!');
  }
}

function showToast(message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className =
    'bg-brand-navy text-white text-xs sm:text-sm font-medium px-4 py-3 rounded-xl shadow-lg border border-white/15 flex items-center gap-2 transition-all duration-300 opacity-0 translate-y-2';
  toast.innerHTML = `<span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('opacity-0', 'translate-y-2');
  });

  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ============================================================================
// 6. SCORING, DATABASE SUBMISSION & RESULTS STAGE
// ============================================================================
function calculateAssessmentReport() {
  const scoredQuestions = questions.filter((q) => q.correct_option > 0);
  const surveyQuestions = questions.filter((q) => q.correct_option === -1);

  let correctCount = 0;
  const categoryStats = {
    1: { correct: 0, total: 0, name: CATEGORIES[1].name },
    2: { correct: 0, total: 0, name: CATEGORIES[2].name },
    3: { correct: 0, total: 0, name: CATEGORIES[3].name }
  };

  const detailedAnswers = {};
  const demographics = {};

  // Process Category 0 Survey Questions
  surveyQuestions.forEach((q) => {
    const chosen = state.answers[q.id] || null;
    const locEn = getLocalizedQuestion(q, 'en');
    demographics[`q_${q.id}`] = {
      question: locEn.questionText,
      selected_option: chosen,
      selected_text: chosen ? locEn.options[chosen - 1] : null
    };
  });

  // Process Categories 1-3 Scored Questions
  scoredQuestions.forEach((q) => {
    const chosen = state.answers[q.id] || null;
    const isCorrect = chosen === q.correct_option;
    if (isCorrect) correctCount += 1;

    if (categoryStats[q.category]) {
      categoryStats[q.category].total += 1;
      if (isCorrect) categoryStats[q.category].correct += 1;
    }

    detailedAnswers[`q_${q.id}`] = {
      question_id: q.id,
      category: q.category,
      selected_option: chosen,
      correct_option: q.correct_option,
      is_correct: isCorrect
    };
  });

  const totalScored = scoredQuestions.length;
  const scoreFraction = totalScored > 0 ? correctCount / totalScored : 0;
  const scorePct = Math.round(scoreFraction * 1000) / 10; // e.g., 77.3%
  const passed = scoreFraction >= CONFIG.PASS_THRESHOLD;

  const domainResults = [1, 2, 3].map((catId) => {
    const st = categoryStats[catId];
    const pct = st.total > 0 ? Math.round((st.correct / st.total) * 1000) / 10 : 0;
    return {
      categoryId: catId,
      name: st.name,
      correct: st.correct,
      total: st.total,
      pct
    };
  });

  const sortedDomains = [...domainResults].sort((a, b) => b.pct - a.pct);

  return {
    participantName: state.participant.name,
    participantEmail: state.participant.email,
    language: state.lang,
    dateFormatted: new Date(state.completedAt || Date.now()).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }),
    verificationId: state.verificationId,
    rawScore: correctCount,
    totalScored,
    scorePct,
    passed,
    competencyLevel: passed ? 'Safe AI End-User' : 'Needs Review',
    domainResults,
    strongestDomain: sortedDomains[0],
    weakestDomain: sortedDomains[sortedDomains.length - 1],
    categoryScoresJson: {
      cat_1_foundational: domainResults[0].pct,
      cat_2_clinical_qa: domainResults[1].pct,
      cat_3_model_training: domainResults[2].pct
    },
    demographics,
    detailedAnswers
  };
}

async function submitToSupabase(report) {
  const badge = document.getElementById('db-sync-badge');
  const retryBtn = document.getElementById('btn-retry-sync');

  if (state.dbSynced) {
    badge.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300';
    badge.textContent = '✓ Saved to Database';
    retryBtn.classList.add('hidden');
    return;
  }

  if (!supabaseClient) {
    badge.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-300';
    badge.textContent = 'ℹ️ Local Mode (Supabase keys not set)';
    retryBtn.classList.add('hidden');
    return;
  }

  badge.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-50 text-brand-navy border border-sky-200';
  badge.textContent = '⏳ Saving results to database…';
  retryBtn.classList.add('hidden');

  try {
    const payload = {
      participant_name: report.participantName,
      participant_email: report.participantEmail,
      language: report.language,
      passed: report.passed,
      score_pct: report.scorePct,
      raw_score: report.rawScore,
      total_scored: report.totalScored,
      category_scores: report.categoryScoresJson,
      demographics: report.demographics,
      detailed_answers: report.detailedAnswers
    };

    const { error } = await supabaseClient.from(CONFIG.SUPABASE_TABLE).insert([payload]);
    if (error) throw error;

    state.dbSynced = true;
    saveStateToStorage();
    badge.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300';
    badge.textContent = '✓ Saved to Database';
  } catch (err) {
    console.error('Supabase insert error:', err);
    badge.className = 'px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300';
    badge.textContent = '⚠️ Offline — Saved Locally';
    retryBtn.classList.remove('hidden');
  }
}

function renderResultsStage() {
  if (!state.completedAt) {
    state.completedAt = new Date().toISOString();
  }
  const report = calculateAssessmentReport();
  state.lastReport = report;
  saveStateToStorage();

  // Confetti celebration on pass
  if (report.passed && typeof window.confetti === 'function') {
    window.confetti({
      particleCount: 90,
      spread: 70,
      origin: { y: 0.6 }
    });
  }

  // Top Banner
  const banner = document.getElementById('results-banner');
  const badge = document.getElementById('results-badge');
  const title = document.getElementById('results-title');
  const subtitle = document.getElementById('results-subtitle');

  if (report.passed) {
    banner.className = 'rounded-2xl p-6 sm:p-8 border shadow-sm bg-emerald-50 border-emerald-200 text-emerald-950';
    badge.className = 'inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-2 bg-emerald-200 text-emerald-900';
    badge.textContent = 'Certified — Safe AI End-User';
    title.textContent = 'Assessment Complete — PASS';
    subtitle.textContent = 'Congratulations! You demonstrated solid foundational and clinical AI literacy across the core radiation oncology domains.';
  } else {
    banner.className = 'rounded-2xl p-6 sm:p-8 border shadow-sm bg-amber-50 border-amber-200 text-amber-950';
    badge.className = 'inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-2 bg-amber-200 text-amber-900';
    badge.textContent = 'Action Required — Review Focus Areas';
    title.textContent = 'Assessment Complete — Needs Review';
    subtitle.textContent = 'You did not reach the 65% pass threshold on this attempt. Download your personalised study summary below to review the missed concepts.';
  }

  // Metrics
  document.getElementById('metric-score').textContent = `${report.scorePct.toFixed(1)}%`;
  document.getElementById('metric-raw').textContent = `${report.rawScore} of ${report.totalScored} correct`;
  document.getElementById('metric-passmark').textContent = `${Math.round(CONFIG.PASS_THRESHOLD * 100)}%`;
  document.getElementById('metric-completed').textContent = `${report.totalScored} / ${report.totalScored}`;
  document.getElementById('metric-cert-id').textContent = `Verification ID: ${report.verificationId}`;

  // Candidate Metadata
  document.getElementById('candidate-summary').innerHTML = `
    <div><span class="font-semibold text-slate-800">Participant:</span> ${escapeHTML(report.participantName)} (${escapeHTML(report.participantEmail)})</div>
    <div><span class="font-semibold text-slate-800">Date:</span> ${escapeHTML(report.dateFormatted)}</div>
    <div><span class="font-semibold text-slate-800">Result Status:</span> <span class="font-semibold ${report.passed ? 'text-emerald-700' : 'text-amber-700'}">${escapeHTML(report.competencyLevel)}</span></div>
  `;

  // Certificate Button Lock/Unlock
  const certBtn = document.getElementById('btn-download-cert');
  const certLockedMsg = document.getElementById('cert-locked-msg');
  if (report.passed) {
    certBtn.disabled = false;
    certLockedMsg.classList.add('hidden');
  } else {
    certBtn.disabled = true;
    certLockedMsg.classList.remove('hidden');
  }

  // Domain Progress Bars
  const domainContainer = document.getElementById('domain-bars-container');
  domainContainer.innerHTML = '';
  report.domainResults.forEach((d) => {
    const barColor = d.pct >= 65 ? 'bg-brand-teal' : 'bg-amber-500';
    const row = document.createElement('div');
    row.innerHTML = `
      <div class="flex items-center justify-between text-sm mb-1.5">
        <span class="font-semibold text-slate-800">${escapeHTML(d.name)}</span>
        <span class="font-bold text-slate-700">${d.pct.toFixed(0)}% <span class="text-xs font-normal text-slate-500">(${d.correct}/${d.total})</span></span>
      </div>
      <div class="w-full bg-slate-100 h-3 rounded-full overflow-hidden">
        <div class="${barColor} h-full rounded-full transition-all duration-500" style="width: ${d.pct}%"></div>
      </div>
    `;
    domainContainer.appendChild(row);
  });

  document.getElementById('domain-strongest').textContent = `${report.strongestDomain.name} (${report.strongestDomain.pct.toFixed(0)}%)`;
  document.getElementById('domain-weakest').textContent = `${report.weakestDomain.name} (${report.weakestDomain.pct.toFixed(0)}%)`;

  renderReviewAccordion();
  submitToSupabase(report);
}

function renderReviewAccordion() {
  const container = document.getElementById('review-accordion-container');
  container.innerHTML = '';

  const scoredQuestions = questions.filter((q) => q.correct_option > 0);
  const filtered = scoredQuestions.filter((q) => {
    if (reviewFilter === 'missed') {
      return state.answers[q.id] !== q.correct_option;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-900 font-medium">
        🎉 Perfect score! You didn't miss any scored questions.
      </div>
    `;
    return;
  }

  filtered.forEach((q) => {
    const loc = getLocalizedQuestion(q);
    const userChoice = state.answers[q.id];
    const isCorrect = userChoice === loc.correctOption;
    const catMeta = CATEGORIES[loc.category] || CATEGORIES[1];

    const details = document.createElement('details');
    details.className = `group rounded-xl border ${
      isCorrect ? 'border-slate-200 bg-white' : 'border-red-200 bg-red-50/20'
    } overflow-hidden`;

    const userText = userChoice ? loc.options[userChoice - 1] : 'No answer selected';
    const correctText = loc.options[loc.correctOption - 1];

    details.innerHTML = `
      <summary class="px-4 py-3.5 cursor-pointer flex items-start justify-between gap-3 hover:bg-slate-50 select-none">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-base">${isCorrect ? '🟢' : '🔴'}</span>
          <div>
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">${escapeHTML(catMeta.name)} · Q${q.id}</span>
            <span class="text-sm font-semibold text-slate-800">${escapeHTML(loc.questionText)}</span>
          </div>
        </div>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-md shrink-0 ${
          isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
        }">${isCorrect ? 'Correct' : 'Missed'}</span>
      </summary>
      <div class="px-4 pb-4 pt-2 border-t border-slate-100 text-xs sm:text-sm space-y-2.5 bg-white">
        <div class="p-3 rounded-lg ${isCorrect ? 'bg-emerald-50 text-emerald-900 border border-emerald-200' : 'bg-red-50 text-red-900 border border-red-200'}">
          <span class="font-bold block mb-0.5">Your Answer:</span>
          <span>${escapeHTML(userText)}</span>
        </div>
        ${
          !isCorrect
            ? `<div class="p-3 rounded-lg bg-emerald-50 text-emerald-900 border border-emerald-200">
                 <span class="font-bold block mb-0.5">✓ Correct Answer:</span>
                 <span>${escapeHTML(correctText)}</span>
               </div>`
            : ''
        }
      </div>
    `;
    container.appendChild(details);
  });
}

// ============================================================================
// 7. CLIENT-SIDE PDF GENERATORS (jsPDF)
// ============================================================================
function downloadCertificatePDF() {
  const report = state.lastReport || calculateAssessmentReport();
  if (!report.passed) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Outer decorative border
  doc.setDrawColor(26, 58, 92); // #1a3a5c
  doc.setLineWidth(1.2);
  doc.rect(12, 12, 186, 273);
  doc.setDrawColor(44, 110, 159); // #2c6e9f
  doc.setLineWidth(0.4);
  doc.rect(15, 15, 180, 267);

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(26);
  doc.setTextColor(26, 58, 92);
  doc.text('Certificate of Completion', 105, 55, { align: 'center' });

  // Subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(15);
  doc.setTextColor(44, 110, 159);
  doc.text('AI Literacy in Radiation Oncology', 105, 66, { align: 'center' });

  // Divider line
  doc.setDrawColor(44, 110, 159);
  doc.setLineWidth(0.8);
  doc.line(35, 74, 175, 74);

  // Body
  doc.setFontSize(13);
  doc.setTextColor(60, 60, 60);
  doc.text('This certifies that', 105, 96, { align: 'center' });

  // Candidate Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(26, 58, 92);
  doc.text(report.participantName || 'Participant', 105, 112, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(60, 60, 60);
  doc.text('has successfully completed the', 105, 128, { align: 'center' });

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(15);
  doc.setTextColor(26, 58, 92);
  doc.text('Certificate of AI Literacy in Radiation Oncology', 105, 138, { align: 'center' });

  // Domain Breakdown Box
  doc.setFillColor(240, 246, 250);
  doc.roundedRect(35, 152, 140, 42, 3, 3, 'F');
  doc.setFontSize(11);
  doc.setTextColor(26, 58, 92);
  doc.text('Domain Performance Breakdown', 105, 161, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(50, 50, 50);
  report.domainResults.forEach((d, idx) => {
    const y = 170 + idx * 7;
    doc.text(`${d.name}: ${d.pct.toFixed(0)}% (${d.correct}/${d.total})`, 105, y, { align: 'center' });
  });

  // Details Footer
  doc.setFontSize(12);
  doc.setTextColor(50, 50, 50);
  doc.text(`Overall Score: ${report.scorePct.toFixed(1)}% (${report.rawScore}/${report.totalScored})`, 105, 215, {
    align: 'center'
  });
  doc.text(`Competency Level: ${report.competencyLevel}`, 105, 224, { align: 'center' });
  doc.text(`Date Issued: ${report.dateFormatted}`, 105, 233, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.text(`Verification ID: ${report.verificationId}`, 105, 242, { align: 'center' });

  const safeName = (report.participantName || 'participant').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  doc.save(`certificate_${safeName}.pdf`);
}

function downloadStudySummaryPDF() {
  const report = state.lastReport || calculateAssessmentReport();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let y = 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(26, 58, 92);
  doc.text('Personalised Learning Plan & Study Summary', 15, y);

  y += 8;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(90, 90, 90);
  doc.text(
    `Prepared for ${report.participantName} · ${report.dateFormatted} · Score: ${report.scorePct.toFixed(1)}% (${report.VerificationId || report.verificationId})`,
    15,
    y
  );

  y += 6;
  doc.setDrawColor(200, 200, 200);
  doc.line(15, y, 195, y);

  y += 8;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(44, 110, 159);
  doc.text('Domain Summary', 15, y);

  y += 6;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(40, 40, 40);
  report.domainResults.forEach((d) => {
    doc.text(`• ${d.name}: ${d.pct.toFixed(0)}% (${d.correct}/${d.total} correct)`, 18, y);
    y += 5.5;
  });

  const missed = questions.filter(
    (q) => q.correct_option > 0 && state.answers[q.id] !== q.correct_option
  );

  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(26, 58, 92);
  doc.text(
    missed.length > 0
      ? `Topics to Review (${missed.length} Missed Questions)`
      : 'All Scored Questions Answered Correctly!',
    15,
    y
  );
  y += 6;

  missed.forEach((q) => {
    const loc = getLocalizedQuestion(q);
    const userChoice = state.answers[q.id];
    const userText = userChoice ? loc.options[userChoice - 1] : 'Not answered';
    const correctText = loc.options[loc.correctOption - 1];

    const qLines = doc.splitTextToSize(`Q${q.id}. ${loc.questionText}`, 175);
    const uLines = doc.splitTextToSize(`Your answer: ${userText}`, 170);
    const cLines = doc.splitTextToSize(`Correct answer: ${correctText}`, 170);

    const blockHeight = (qLines.length + uLines.length + cLines.length) * 4.5 + 10;
    if (y + blockHeight > 280) {
      doc.addPage();
      y = 20;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10);
    doc.setTextColor(26, 58, 92);
    doc.text(qLines, 15, y);
    y += qLines.length * 4.5 + 1;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(164, 38, 44);
    doc.text(uLines, 18, y);
    y += uLines.length * 4.5 + 1;

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(22, 101, 52);
    doc.text(cLines, 18, y);
    y += cLines.length * 4.5 + 5;
  });

  const safeName = (report.participantName || 'participant').replace(/[^a-z0-9]/gi, '_').toLowerCase();
  doc.save(`learning_plan_${safeName}.pdf`);
}

function downloadJSONBackup() {
  const report = state.lastReport || calculateAssessmentReport();
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `ro_ai_assessment_${report.verificationId}.json`);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============================================================================
// 8. EVENT LISTENERS & HELPERS
// ============================================================================
function bindEvents() {
  // Language switcher
  document.getElementById('lang-selector').addEventListener('change', (e) => {
    state.lang = e.target.value;
    saveStateToStorage();
    if (state.stage === 'quiz') {
      renderSidebar();
      renderCurrentQuestion();
    } else if (state.stage === 'results') {
      renderSidebar();
      renderReviewAccordion();
    }
  });

  // Local CSV file input fallback
  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => parseCSVContent(evt.target.result);
    reader.readAsText(file);
  });

  // Resume / Discard banner buttons
  document.getElementById('btn-Resume').addEventListener('click', () => {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (raw) {
      state = { ...getInitialState(), ...JSON.parse(raw) };
      document.getElementById('lang-selector').value = state.lang;
      showStage(state.stage === 'results' ? 'results' : 'quiz');
    }
  });

  document.getElementById('btn-start-fresh').addEventListener('click', () => {
    clearSavedStorage();
    state = getInitialState();
    document.getElementById('resume-banner').classList.add('hidden');
  });

  // Welcome Start Form
  document.getElementById('start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('input-name').value.trim();
    const email = document.getElementById('input-email').value.trim();
    const consent = document.getElementById('input-consent').checked;
    const errEl = document.getElementById('form-error');

    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!name) {
      errEl.textContent = 'Please enter your full name to begin.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!emailRegex.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!consent) {
      errEl.textContent = 'Please confirm you have read and agree to the privacy notice.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    state = getInitialState();
    state.lang = document.getElementById('lang-selector').value;
    state.participant = { name, email, consent };
    saveStateToStorage();
    showStage('quiz');
  });

  // Quiz Navigation
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.currentIndex > 0) {
      state.currentIndex -= 1;
      saveStateToStorage();
      renderSidebar();
      renderCurrentQuestion();
    }
  });

  document.getElementById('btn-next').addEventListener('click', () => {
    handleNextOrSubmit();
  });

  // Keyboard shortcuts (1-4 to pick option, ArrowLeft/ArrowRight/Enter to navigate)
  document.addEventListener('keydown', (e) => {
    if (state.stage !== 'quiz') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;

    const q = questions[state.currentIndex];
    if (!q) return;

    if (['1', '2', '3', '4'].includes(e.key)) {
      e.preventDefault();
      selectOption(q.id, parseInt(e.key, 10));
    } else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      e.preventDefault();
      handleNextOrSubmit();
    } else if (e.key === 'ArrowLeft' && state.currentIndex > 0) {
      e.preventDefault();
      state.currentIndex -= 1;
      saveStateToStorage();
      renderSidebar();
      renderCurrentQuestion();
    }
  });

  // Mobile Sidebar drawer toggles
  document.getElementById('mobile-sidebar-toggle').addEventListener('click', () => {
    const sb = document.getElementById('quiz-sidebar');
    const bd = document.getElementById('sidebar-backdrop');
    sb.classList.toggle('-translate-x-full');
    bd.classList.toggle('hidden');
  });

  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);

  // Results Actions
  document.getElementById('btn-download-cert').addEventListener('click', downloadCertificatePDF);
  document.getElementById('btn-download-study').addEventListener('click', downloadStudySummaryPDF);
  document.getElementById('btn-download-json').addEventListener('click', downloadJSONBackup);

  document.getElementById('btn-retry-sync').addEventListener('click', () => {
    if (state.lastReport) submitToSupabase(state.lastReport);
  });

  // Review Filter Toggles
  const btnAll = document.getElementById('filter-review-all');
  const btnMissed = document.getElementById('filter-review-missed');

  btnAll.addEventListener('click', () => {
    reviewFilter = 'all';
    btnAll.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-brand-navy shadow-sm transition';
    btnMissed.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    renderReviewAccordion();
  });

  btnMissed.addEventListener('click', () => {
    reviewFilter = 'missed';
    btnMissed.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-brand-navy shadow-sm transition';
    btnAll.className = 'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    renderReviewAccordion();
  });

  // Restart button
  document.getElementById('btn-restart').addEventListener('click', () => {
    clearSavedStorage();
    state = getInitialState();
    state.lang = document.getElementById('lang-selector').value;
    document.getElementById('resume-banner').classList.add('hidden');
    showStage('welcome');
  });
}

function handleNextOrSubmit() {
  const currentQ = questions[state.currentIndex];
  const warnEl = document.getElementById('unanswered-warning');

  if (state.answers[currentQ.id] === undefined) {
    warnEl.textContent = 'Please select an answer option before continuing.';
    warnEl.classList.remove('hidden');
    return;
  }

  warnEl.classList.add('hidden');

  if (state.currentIndex < questions.length - 1) {
    state.currentIndex += 1;
    saveStateToStorage();
    renderSidebar();
    renderCurrentQuestion();
  } else {
    // Check if any question was skipped via sidebar jumping
    const firstMissingIdx = questions.findIndex((q) => state.answers[q.id] === undefined);
    if (firstMissingIdx !== -1) {
      state.currentIndex = firstMissingIdx;
      renderSidebar();
      renderCurrentQuestion();
      warnEl.textContent = `Please complete Question ${questions[firstMissingIdx].id} before final submission.`;
      warnEl.classList.remove('hidden');
      return;
    }

    state.completedAt = new Date().toISOString();
    saveStateToStorage();
    showStage('results');
  }
}

function closeMobileSidebar() {
  document.getElementById('quiz-sidebar').classList.add('-translate-x-full');
  document.getElementById('sidebar-backdrop').classList.add('hidden');
}

function escapeHTML(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}