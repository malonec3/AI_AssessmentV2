/**
 * AI Literacy in Radiation Oncology — Static Assessment Application
 * Supports Track Selection (End-user, Evaluator, Full), Multilingual Toggle,
 * CSV hot-swapping, Supabase PostgreSQL storage, and client-side PDF generation.
 */

// ============================================================================
// 1. CONFIGURATION & CONSTANTS
// ============================================================================
const CONFIG = {
  // ── Language Toggle (Easy switch on GitHub) ──────────────────────────────
  // Set ENABLE_MULTILINGUAL to false to hide the language dropdown and use English only.
  // Set to true to show the language selector in the top navigation bar.
  ENABLE_MULTILINGUAL: false,
  ENABLED_LANGS: ['en', 'nl', 'es', 'fr', 'it', 'de', 'da'],

  // ── Supabase PostgreSQL Credentials ──────────────────────────────────────
  SUPABASE_URL: 'https://jmakkmmegompfymqgdtt.supabase.co',
  SUPABASE_ANON_KEY: 'sb_publishable_PUnv5qoxt0-TNd2MIc_A2w_unVyi5vm',
  SUPABASE_TABLE: 'quiz_submissions',

  // ── CSV Question Bank Paths ──────────────────────────────────────────────
  CSV_PATHS: ['./questions_multilingual.csv', './questions_multilingual (3).csv'],

  // ── Question bank version ────────────────────────────────────────────────
  // Change this whenever you edit the CSV, so every saved result records which
  // wording the participant answered.
  QUESTION_BANK_VERSION: '2026-10-28',

  // ── Scoring & Storage ────────────────────────────────────────────────────
  PASS_THRESHOLD: 0.65, // 65% required to pass
  DEFAULT_TRACK: 'end_user',
  STORAGE_KEY: 'ro_ai_literacy_quiz_state_v2'
};

// Mirrors TRACKS from config.py
const TRACKS = {
  end_user: {
    id: 'end_user',
    label: 'End-user',
    blurb: 'Core AI literacy for anyone using AI tools in the clinic.',
    certTitle: 'Certificate of AI Literacy — End-User',
    certNote: '',
    certifiedLabel: 'AI End-User'
  },
  evaluator: {
    id: 'evaluator',
    label: 'Evaluator / Monitor of AI tools',
    blurb:
      'Advanced literacy for evaluating, commissioning and monitoring AI tools. Taken in addition to the End-user assessment.',
    certTitle: 'Certificate of AI Literacy — Evaluator / Monitor of AI Tools',
    certNote:
      'This certificate covers the Evaluator / Monitor track only and is complete only when held together with the End-User certificate.',
    certifiedLabel: 'AI Evaluator / Monitor'
  },
  full: {
    id: 'full',
    label: 'Comprehensive Assessment (End-user + Evaluator)',
    blurb:
      'Complete both the foundational End-user core and the advanced Evaluator / Monitor curriculum in a single sitting.',
    certTitle: 'Certificate of AI Literacy — Comprehensive (End-User & Evaluator)',
    certNote: '',
    certifiedLabel: 'AI End-User & Evaluator'
  },
  // Course tracks: questions are chosen by a CSV column rather than by the
  // "track" column. Put 1 in that column for each question to include.
  // Background survey questions (category 0) are always included.
  // To add another course later, copy this block, give it a new id and
  // selectColumn, add a matching column to the CSV and add the id to TRACK_ORDER.
  estro_ai: {
    id: 'estro_ai',
    label: 'ESTRO AI',
    blurb: 'The question set selected for participants on the ESTRO AI course.',
    certTitle: 'Certificate of AI Literacy — ESTRO AI',
    certNote: '',
    certifiedLabel: 'ESTRO AI',
    selectColumn: 'estro_ai'
  }
};

const TRACK_ORDER = ['end_user', 'evaluator', 'full', 'estro_ai'];

const CATEGORIES = {
  0: {
    name: 'Background & Self-Assessment',
    shortName: 'Background Survey',
    scored: false,
    badgeClass: 'bg-slate-100 text-slate-700'
  },
  1: {
    name: 'Foundations, Data & Inputs',
    shortName: '1. Foundations & Data',
    scored: true,
    badgeClass: 'bg-sky-100 text-brand-navy'
  },
  2: {
    name: 'Clinical Commissioning, QA & Human Factors',
    shortName: '2. Clinical QA & Safety',
    scored: true,
    badgeClass: 'bg-teal-100 text-teal-900'
  },
  3: {
    name: 'Model Building, Metrics & Uncertainty',
    shortName: '3. Models, Metrics & Risk',
    scored: true,
    badgeClass: 'bg-indigo-100 text-indigo-900'
  }
};

// Order in which sections are shown and numbered.
const CATEGORY_ORDER = [0, 1, 2, 3];

const SUPPORTED_LANGS = ['en', 'nl', 'es', 'fr', 'it', 'de', 'da'];

// ============================================================================
// 2. APPLICATION STATE
// ============================================================================
let allQuestions = []; // All rows parsed from CSV
let supabaseClient = null;
let reviewFilter = 'all'; // 'all' | 'missed'

let state = getInitialState();

function getInitialState() {
  return {
    stage: 'welcome', // 'welcome' | 'quiz' | 'results'
    lang: 'en',
    track: CONFIG.DEFAULT_TRACK, // 'end_user' | 'evaluator' | 'full'
    participant: {
      name: '',
      email: '',
      consent: false
    },
    currentIndex: 0,
    answers: {}, // { [questionId]: selectedOptionNumber (1..4) }
    helpOpened: {}, // { [questionId]: true } once the key-terms panel was opened
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

/**
 * Returns the filtered list of questions active for the chosen track.
 * Always includes Category 0 (background survey) + the track's scored questions.
 */
function isFlagged(value) {
  return ['1', 'true', 'yes', 'y', 'x'].includes(String(value ?? '').trim().toLowerCase());
}

/**
 * Unscored rows (correct_option -1) in a scored section (category 1-3) are
 * end-of-section self-ratings, such as "how many answers were guesses?".
 */
function isSectionRating(q) {
  return q.category !== 0 && q.correct_option === -1;
}

/**
 * Puts questions in section order (CATEGORY_ORDER), then by id, with each
 * section's self-rating last. Self-ratings for sections that have no scored
 * questions in this track are dropped. Numbering follows this order.
 */
function orderQuestions(list) {
  const rank = (c) => {
    const i = CATEGORY_ORDER.indexOf(c);
    return i === -1 ? CATEGORY_ORDER.length : i;
  };
  const scoredSections = new Set(list.filter((q) => q.correct_option > 0).map((q) => q.category));
  return list
    .filter((q) => !isSectionRating(q) || scoredSections.has(q.category))
    .slice()
    .sort(
      (a, b) =>
        rank(a.category) - rank(b.category) ||
        Number(isSectionRating(a)) - Number(isSectionRating(b)) ||
        a.id - b.id
    );
}

function getActiveQuestions(track = state.track) {
  const meta = TRACKS[track];
  if (meta && meta.selectColumn) {
    return orderQuestions(
      allQuestions.filter(
        (q) => q.category === 0 || q.correct_option === -1 || isFlagged(q.raw[meta.selectColumn])
      )
    );
  }

  const hasExplicitTracks = allQuestions.some(
    (q) => q.track === 'end_user' || q.track === 'evaluator'
  );

  if (!hasExplicitTracks || track === 'full') {
    return orderQuestions(allQuestions);
  }

  return orderQuestions(
    allQuestions.filter((q) => {
      if (q.category === 0 || q.correct_option === -1 || q.track === 'all') {
        return true;
      }
      return q.track === track;
    })
  );
}

// ============================================================================
// 3. INITIALIZATION & CSV PARSING
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  applyLanguageConfig();
  initSupabase();
  bindEvents();
  await loadCSVWithFallback();
});

function applyLanguageConfig() {
  const wrapper = document.getElementById('lang-selector-wrapper');
  const select = document.getElementById('lang-selector');
  if (!wrapper || !select) return;

  if (!CONFIG.ENABLE_MULTILINGUAL) {
    state.lang = 'en';
    wrapper.classList.add('hidden');
    wrapper.classList.remove('flex');
  } else {
    wrapper.classList.remove('hidden');
    wrapper.classList.add('flex');
    Array.from(select.options).forEach((opt) => {
      opt.hidden = !CONFIG.ENABLED_LANGS.includes(opt.value);
    });
  }
}

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
      `Unable to automatically fetch "./questions_multilingual.csv" (${lastError}). If you opened index.html directly from your computer (file://), browsers block local file fetching for security. Use the file selector below or host on GitHub Pages.`
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
          track: cleanText(row.track || 'all').toLowerCase(),
          topic: cleanText(row.topic || ''),
          correct_option: parseInt(row.correct_option, 10),
          raw: row
        }))
        .filter((q) => !Number.isNaN(q.id));

      if (parsed.length === 0) {
        showCSVError('The CSV file was loaded, but no valid question rows were found.');
        return;
      }

      allQuestions = parsed.sort((a, b) => a.id - b.id);
      document.getElementById('loading-state').classList.add('hidden');
      document.getElementById('error-state').classList.add('hidden');

      renderTrackOptions();
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

function getLocalizedQuestion(q, lang = state.lang) {
  const row = q.raw;
  const activeLang =
    CONFIG.ENABLE_MULTILINGUAL && SUPPORTED_LANGS.includes(lang) ? lang : 'en';

  const questionText = cleanText(row[`question_${activeLang}`] || row.question_en);
  const options = [1, 2, 3, 4].map((idx) =>
    cleanText(row[`option_${idx}_${activeLang}`] || row[`option_${idx}_en`])
  );
  const explanation = cleanText(row[`explanation_${activeLang}`] || row.explanation_en || '');
  const clinicalContext = cleanText(
    row[`clinical_context_${activeLang}`] || row.clinical_context_en || ''
  );
  const helpTerms = parseHelpTerms(row[`help_terms_${activeLang}`] || row.help_terms_en || '');

  return {
    id: q.id,
    category: q.category,
    track: q.track,
    topic: q.topic,
    correctOption: q.correct_option,
    isScored: q.correct_option > 0,
    questionText,
    options,
    explanation,
    clinicalContext,
    helpTerms
  };
}

/** "Term: definition | Term: definition" -> [{ term, definition }] */
function parseHelpTerms(raw) {
  return cleanText(raw)
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const i = s.indexOf(':');
      return i > 0
        ? { term: s.slice(0, i).trim(), definition: s.slice(i + 1).trim() }
        : { term: s, definition: '' };
    });
}

// ============================================================================
// 4. WELCOME SCREEN TRACK SELECTOR RENDERING
// ============================================================================
function renderTrackOptions() {
  const container = document.getElementById('track-options-container');
  if (!container) return;
  container.innerHTML = '';

  TRACK_ORDER.forEach((trackKey) => {
    const meta = TRACKS[trackKey];
    const trackQuestions = getActiveQuestions(trackKey);
    const scoredCount = trackQuestions.filter((q) => q.correct_option > 0).length;
    const surveyCount = trackQuestions.filter((q) => q.correct_option === -1).length;

    // A course track with no questions marked in its CSV column is hidden.
    if (meta.selectColumn && scoredCount === 0) {
      console.info(`Track "${trackKey}" hidden: no questions marked in CSV column "${meta.selectColumn}".`);
      if (state.track === trackKey) state.track = CONFIG.DEFAULT_TRACK;
      return;
    }

    // Estimate duration similar to app.py (_track_caption)
    const lo = Math.max(5, Math.round((scoredCount * 0.6) / 5) * 5);
    const hi = Math.max(lo + 5, Math.round((scoredCount * 1.1) / 5) * 5);
    const isChecked = state.track === trackKey;

    const labelEl = document.createElement('label');
    labelEl.className = `block p-4 rounded-xl border-2 cursor-pointer transition ${
      isChecked
        ? 'border-brand-teal bg-brand-light/60'
        : 'border-slate-200 bg-white hover:border-slate-300'
    }`;

    labelEl.innerHTML = `
      <div class="flex items-start gap-3">
        <input
          type="radio"
          name="assessment_track"
          value="${trackKey}"
          ${isChecked ? 'checked' : ''}
          class="mt-1 h-4 w-4 text-brand-teal border-slate-300 focus:ring-brand-teal"
        />
        <div class="flex-1">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <span class="text-sm font-bold text-brand-navy">${escapeHTML(meta.label)}</span>
            <span class="text-[11px] font-semibold px-2.5 py-0.5 rounded-full bg-white border border-slate-200 text-slate-600">
              ${scoredCount} scored topics + ${surveyCount} survey · ~${lo}–${hi} mins
            </span>
          </div>
          <p class="text-xs text-slate-600 mt-1 leading-relaxed">${escapeHTML(meta.blurb)}</p>
        </div>
      </div>
    `;

    const radioInput = labelEl.querySelector('input[type="radio"]');
    radioInput.addEventListener('change', () => {
      state.track = trackKey;
      renderTrackOptions();
    });

    container.appendChild(labelEl);
  });
}

// ============================================================================
// 5. LOCAL STORAGE & SESSION RESUME
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
      if (
        CONFIG.ENABLE_MULTILINGUAL &&
        saved?.lang &&
        SUPPORTED_LANGS.includes(saved.lang)
      ) {
        state.lang = saved.lang;
        document.getElementById('lang-selector').value = state.lang;
      }

      const activeForSaved = getActiveQuestions(saved?.track || CONFIG.DEFAULT_TRACK);
      const answeredCount = saved?.answers
        ? activeForSaved.filter((q) => saved.answers[q.id] !== undefined).length
        : 0;

      if (saved && (saved.stage === 'quiz' || saved.stage === 'results') && answeredCount > 0) {
        const banner = document.getElementById('resume-banner');
        const text = document.getElementById('resume-progress-text');
        const trackLabel = TRACKS[saved.track]?.label || 'End-user';
        banner.classList.remove('hidden');
        text.textContent =
          saved.stage === 'results'
            ? `Completed ${trackLabel} session for ${saved.participant?.name || 'Participant'} (${answeredCount}/${activeForSaved.length} answered).`
            : `Welcome back, ${saved.participant?.name || 'Participant'} — ${answeredCount} of ${activeForSaved.length} questions complete (${trackLabel} track).`;
      }
    }
  } catch (e) {
    console.warn('Failed to read saved session:', e);
  }

  showStage('welcome');
}

// ============================================================================
// 6. STAGE NAVIGATION & UI RENDERING
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
    renderTrackOptions();
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
  const activeQuestions = getActiveQuestions();
  const total = activeQuestions.length;
  const answeredCount = activeQuestions.filter((q) => state.answers[q.id] !== undefined).length;
  const pct = total > 0 ? Math.round((answeredCount / total) * 100) : 0;

  const trackMeta = TRACKS[state.track] || TRACKS.end_user;
  document.getElementById('sidebar-track-label').textContent = `Track: ${trackMeta.label}`;
  document.getElementById('sidebar-progress-text').textContent = `${answeredCount} / ${total} complete`;
  document.getElementById('sidebar-progress-bar').style.width = `${pct}%`;

  const container = document.getElementById('sidebar-checklist');
  container.innerHTML = '';

  CATEGORY_ORDER.forEach((catId) => {
    const catQuestions = activeQuestions.filter((q) => q.category === catId);
    if (catQuestions.length === 0) return;

    const catMeta = CATEGORIES[catId] || { shortName: `Category ${catId}`, scored: true };
    const groupDiv = document.createElement('div');

    const header = document.createElement('div');
    header.className =
      'text-xs font-bold uppercase tracking-wider text-slate-400 mb-2 flex items-center justify-between';
    const catDone = catQuestions.filter((q) => state.answers[q.id] !== undefined).length;
    header.innerHTML = `<span>${escapeHTML(catMeta.shortName)}</span><span class="text-[11px] font-medium">${catDone}/${catQuestions.length}</span>`;
    groupDiv.appendChild(header);

    const list = document.createElement('div');
    list.className = 'space-y-1';

    catQuestions.forEach((q) => {
      const qIndex = activeQuestions.findIndex((item) => item.id === q.id);
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

      const labelSource = loc.topic || loc.questionText;
      const shortTitle =
        labelSource.length > 38 ? `${labelSource.slice(0, 38)}…` : labelSource;

      btn.innerHTML = `<span class="shrink-0">${icon}</span><span class="truncate">${qIndex + 1}. ${escapeHTML(shortTitle)}</span>`;

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
  const activeQuestions = getActiveQuestions();
  if (state.currentIndex >= activeQuestions.length) {
    state.currentIndex = Math.max(0, activeQuestions.length - 1);
  }
  const q = activeQuestions[state.currentIndex];
  if (!q) return;

  const loc = getLocalizedQuestion(q);
  const catMeta = CATEGORIES[loc.category] || CATEGORIES[1];

  const card = document.getElementById('question-card');
  card.classList.add('card-enter');
  requestAnimationFrame(() => {
    setTimeout(() => card.classList.remove('card-enter'), 30);
  });

  const badgeEl = document.getElementById('q-category-badge');
  badgeEl.className = `px-3 py-1 rounded-full text-xs font-semibold ${catMeta.badgeClass}`;
  badgeEl.textContent = catMeta.name;

  const topicPill = document.getElementById('q-topic-pill');
  if (loc.topic) {
    topicPill.textContent = loc.topic;
    topicPill.classList.remove('hidden');
  } else {
    topicPill.classList.add('hidden');
  }

  const pillEl = document.getElementById('q-type-pill');
  if (loc.isScored) {
    pillEl.className =
      'px-2.5 py-0.5 rounded-md text-[11px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200';
    pillEl.textContent = 'Scored Topic';
  } else {
    pillEl.className =
      'px-2.5 py-0.5 rounded-md text-[11px] font-medium bg-slate-100 text-slate-600';
    pillEl.textContent = isSectionRating(q) ? 'Self-rating (Unscored)' : 'Background Survey (Unscored)';
  }

  document.getElementById('q-counter').textContent = `Question ${state.currentIndex + 1} of ${activeQuestions.length}`;
  document.getElementById('q-text').textContent = loc.questionText;

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

  renderQuestionAside(q, loc);

  document.getElementById('btn-prev').disabled = state.currentIndex === 0;
  const nextBtn = document.getElementById('btn-next');
  const isLast = state.currentIndex === activeQuestions.length - 1;
  nextBtn.textContent = isLast ? 'Submit Assessment ✓' : 'Next Question →';
  nextBtn.className = isLast
    ? 'px-6 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold shadow-sm transition'
    : 'px-6 py-2.5 rounded-xl bg-brand-navy hover:bg-brand-teal text-white text-sm font-semibold shadow-sm transition';
}

function renderQuestionAside(q, loc) {
  const grid = document.getElementById('quiz-grid');
  const aside = document.getElementById('question-aside');
  const hasContext = Boolean(loc.clinicalContext);
  const hasHelp = loc.helpTerms.length > 0;

  document.getElementById('context-box').classList.toggle('hidden', !hasContext);
  document.getElementById('context-text').textContent = loc.clinicalContext;

  document.getElementById('help-box').classList.toggle('hidden', !hasHelp);
  document.getElementById('help-list').innerHTML = loc.helpTerms
    .map(
      (t) => `
      <div>
        <dt class="font-semibold text-brand-navy">${escapeHTML(t.term)}</dt>
        <dd class="text-slate-600 mt-0.5 leading-relaxed">${escapeHTML(t.definition)}</dd>
      </div>`
    )
    .join('');
  setHelpOpen(Boolean(state.helpOpened && state.helpOpened[q.id]));

  const showAside = hasContext || hasHelp;
  aside.classList.toggle('hidden', !showAside);
  grid.classList.toggle('xl:grid-cols-[minmax(0,1fr)_18rem]', showAside);
}

function setHelpOpen(open) {
  const btn = document.getElementById('help-toggle');
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  document.getElementById('help-list').classList.toggle('hidden', !open);
  document.getElementById('help-chevron').classList.toggle('rotate-180', open);
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
  const activeQuestions = getActiveQuestions();
  const total = activeQuestions.length;
  const done = activeQuestions.filter((q) => state.answers[q.id] !== undefined).length;
  if (total < 8) return;

  const q25 = Math.round(total * 0.25);
  const q50 = Math.round(total * 0.5);
  const q75 = Math.round(total * 0.75);

  if (done === q25 && !state.milestonesShown.q25) {
    state.milestonesShown.q25 = true;
    showToast(`🚀 A quarter of the way — nice momentum (${done} of ${total} complete)`);
  } else if (done === q50 && !state.milestonesShown.q50) {
    state.milestonesShown.q50 = true;
    showToast(`⚡ Halfway there! Good moment for a short break if needed — progress is saved.`);
  } else if (done === q75 && !state.milestonesShown.q75) {
    state.milestonesShown.q75 = true;
    showToast(`🏁 Three quarters done — home stretch (${done} of ${total} complete)`);
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
  }, 4200);
}

// ============================================================================
// 7. SCORING, DATABASE SUBMISSION & RESULTS STAGE
// ============================================================================
function calculateAssessmentReport() {
  const activeQuestions = getActiveQuestions();
  const scoredQuestions = activeQuestions.filter((q) => q.correct_option > 0);
  const surveyQuestions = activeQuestions.filter((q) => q.correct_option === -1);
  const trackMeta = TRACKS[state.track] || TRACKS.end_user;

  let correctCount = 0;
  const categoryStats = {
    1: { correct: 0, total: 0, name: CATEGORIES[1].name },
    2: { correct: 0, total: 0, name: CATEGORIES[2].name },
    3: { correct: 0, total: 0, name: CATEGORIES[3].name }
  };

  const detailedAnswers = {};
  const demographics = {
    assessment_track: state.track,
    assessment_track_label: trackMeta.label,
    question_bank_version: CONFIG.QUESTION_BANK_VERSION,
    verification_id: state.verificationId
  };

  surveyQuestions.forEach((q) => {
    const chosen = state.answers[q.id] || null;
    const locEn = getLocalizedQuestion(q, 'en');
    demographics[`q_${q.id}`] = {
      topic: locEn.topic || `Survey Q${q.id}`,
      question: locEn.questionText,
      selected_option: chosen,
      selected_text: chosen ? locEn.options[chosen - 1] : null
    };
  });

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
      topic: q.topic || '',
      category: q.category,
      track: q.track,
      selected_option: chosen,
      correct_option: q.correct_option,
      is_correct: isCorrect,
      help_opened: Boolean(state.helpOpened && state.helpOpened[q.id])
    };
  });

  const totalScored = scoredQuestions.length;
  const scoreFraction = totalScored > 0 ? correctCount / totalScored : 0;
  const scorePct = Math.round(scoreFraction * 1000) / 10;
  const passed = scoreFraction >= CONFIG.PASS_THRESHOLD;

  const domainResults = [1, 2, 3]
    .map((catId) => {
      const st = categoryStats[catId];
      const pct = st.total > 0 ? Math.round((st.correct / st.total) * 1000) / 10 : 0;
      return {
        categoryId: catId,
        name: st.name,
        correct: st.correct,
        total: st.total,
        pct
      };
    })
    .filter((d) => d.total > 0);

  const sortedDomains = [...domainResults].sort((a, b) => b.pct - a.pct);

  return {
    participantName: state.participant.name,
    participantEmail: state.participant.email,
    language: state.lang,
    track: state.track,
    trackLabel: trackMeta.label,
    certTitle: trackMeta.certTitle,
    certNote: trackMeta.certNote,
    dateFormatted: new Date(state.completedAt || Date.now()).toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric'
    }),
    verificationId: state.verificationId,
    rawScore: correctCount,
    totalScored,
    requiredRaw: Math.ceil(totalScored * CONFIG.PASS_THRESHOLD),
    scorePct,
    passed,
    competencyLevel: passed ? trackMeta.certifiedLabel : 'Not Yet Ready',
    domainResults,
    strongestDomain: sortedDomains[0] || { name: '—', pct: 0 },
    weakestDomain: sortedDomains[sortedDomains.length - 1] || { name: '—', pct: 0 },
    categoryScoresJson: {
      track: state.track,
      cat_1_foundations_data: categoryStats[1].total
        ? Math.round((categoryStats[1].correct / categoryStats[1].total) * 1000) / 10
        : null,
      cat_2_clinical_qa_safety: categoryStats[2].total
        ? Math.round((categoryStats[2].correct / categoryStats[2].total) * 1000) / 10
        : null,
      cat_3_models_metrics_risk: categoryStats[3].total
        ? Math.round((categoryStats[3].correct / categoryStats[3].total) * 1000) / 10
        : null
    },
    demographics,
    detailedAnswers
  };
}

async function submitToSupabase(report) {
  const badge = document.getElementById('db-sync-badge');
  const retryBtn = document.getElementById('btn-retry-sync');

  if (state.dbSynced) {
    badge.className =
      'px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300';
    badge.textContent = '✓ Saved to Database';
    retryBtn.classList.add('hidden');
    return;
  }

  if (!supabaseClient) {
    badge.className =
      'px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 border border-slate-300';
    badge.textContent = 'ℹ️ Local Mode (Supabase keys not set)';
    retryBtn.classList.add('hidden');
    return;
  }

  badge.className =
    'px-3 py-1.5 rounded-xl text-xs font-semibold bg-sky-50 text-brand-navy border border-sky-200';
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
    badge.className =
      'px-3 py-1.5 rounded-xl text-xs font-semibold bg-emerald-100 text-emerald-900 border border-emerald-300';
    badge.textContent = '✓ Saved to Database';
  } catch (err) {
    console.error('Supabase insert error:', err);
    badge.className =
      'px-3 py-1.5 rounded-xl text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-300';
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

  if (report.passed && typeof window.confetti === 'function') {
    window.confetti({
      particleCount: 90,
      spread: 70,
      origin: { y: 0.6 }
    });
  }

  const banner = document.getElementById('results-banner');
  const badge = document.getElementById('results-badge');
  const title = document.getElementById('results-title');
  const subtitle = document.getElementById('results-subtitle');

  if (report.passed) {
    banner.className =
      'rounded-2xl p-6 sm:p-8 border shadow-sm bg-emerald-50 border-emerald-200 text-emerald-950';
    badge.className =
      'inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-2 bg-emerald-200 text-emerald-900';
    badge.textContent = `Certified — ${report.competencyLevel}`;
    title.textContent = 'Assessment Complete — PASS';
    subtitle.textContent = `You passed the ${report.trackLabel} assessment. Your certificate and personalised learning plan are ready below.`;
  } else {
    banner.className =
      'rounded-2xl p-6 sm:p-8 border shadow-sm bg-amber-50 border-amber-200 text-amber-950';
    badge.className =
      'inline-block px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider mb-2 bg-amber-200 text-amber-900';
    badge.textContent = 'Result — Not Yet Ready';
    title.textContent = 'Assessment Complete — FAIL';
    subtitle.textContent =
      'You did not reach the 65% pass threshold on this sitting. Download your personalised learning plan below to review the topics you missed.';
  }

  // Evaluator track companion info banner (mirrors app.py)
  const evalNotice = document.getElementById('evaluator-track-notice');
  if (report.passed && report.track === 'evaluator') {
    evalNotice.classList.remove('hidden');
  } else {
    evalNotice.classList.add('hidden');
  }

  // Metrics
  document.getElementById('metric-score').textContent = `${report.scorePct.toFixed(1)}%`;
  document.getElementById('metric-raw').textContent = `${report.rawScore} of ${report.totalScored} correct`;
  document.getElementById('metric-passmark').textContent = `${Math.round(CONFIG.PASS_THRESHOLD * 100)}%`;
  document.getElementById('metric-pass-detail').textContent = `${report.requiredRaw} of ${report.totalScored} required to pass`;
  document.getElementById('metric-completed').textContent = `${report.totalScored} / ${report.totalScored}`;
  document.getElementById('metric-cert-id').textContent = `Certificate ID: ${report.verificationId}`;

  document.getElementById('candidate-summary').innerHTML = `
    <div><span class="font-semibold text-slate-800">Name:</span> ${escapeHTML(report.participantName)} (${escapeHTML(report.participantEmail)})</div>
    <div><span class="font-semibold text-slate-800">Assessment Track:</span> ${escapeHTML(report.trackLabel)}</div>
    <div><span class="font-semibold text-slate-800">Date:</span> ${escapeHTML(report.dateFormatted)}</div>
    <div><span class="font-semibold text-slate-800">Result:</span> <span class="font-semibold ${report.passed ? 'text-emerald-700' : 'text-amber-700'}">${escapeHTML(report.competencyLevel)}</span></div>
  `;

  const certBtn = document.getElementById('btn-download-cert');
  const certLockedMsg = document.getElementById('cert-locked-msg');
  if (report.passed) {
    certBtn.disabled = false;
    certLockedMsg.classList.add('hidden');
  } else {
    certBtn.disabled = true;
    certLockedMsg.classList.remove('hidden');
  }

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

  const activeQuestions = getActiveQuestions();
  const scoredQuestions = activeQuestions.filter((q) => q.correct_option > 0);
  document.getElementById('filter-review-all').textContent = `All Scored (${scoredQuestions.length})`;

  const filtered = scoredQuestions.filter((q) => {
    if (reviewFilter === 'missed') {
      return state.answers[q.id] !== q.correct_option;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="p-6 text-center bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-900 font-medium">
        🎉 Full marks! You answered every scored question in this track correctly.
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
    const topicLabel = loc.topic ? ` · ${loc.topic}` : '';

    details.innerHTML = `
      <summary class="px-4 py-3.5 cursor-pointer flex items-start justify-between gap-3 hover:bg-slate-50 select-none">
        <div class="flex items-start gap-3">
          <span class="mt-0.5 text-base">${isCorrect ? '🟢' : '🔴'}</span>
          <div>
            <span class="text-[11px] font-bold uppercase tracking-wider text-slate-400 block">${escapeHTML(catMeta.name)}${escapeHTML(topicLabel)}</span>
            <span class="text-sm font-semibold text-slate-800">${escapeHTML(loc.questionText)}</span>
          </div>
        </div>
        <span class="text-xs font-semibold px-2.5 py-1 rounded-md shrink-0 ${
          isCorrect ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
        }">${isCorrect ? 'Correct' : 'Review'}</span>
      </summary>
      <div class="px-4 pb-4 pt-2 border-t border-slate-100 text-xs sm:text-sm space-y-2.5 bg-white">
        <div class="p-3 rounded-lg ${
          isCorrect
            ? 'bg-emerald-50 text-emerald-900 border border-emerald-200'
            : 'bg-red-50 text-red-900 border border-red-200'
        }">
          <span class="font-bold block mb-0.5">Your Answer:</span>
          <span>${escapeHTML(userText)}</span>
        </div>
        ${
          !isCorrect
            ? `<div class="p-3 rounded-lg bg-emerald-50 text-emerald-900 border border-emerald-200">
                 <span class="font-bold block mb-0.5">✓ Expected Concept:</span>
                 <span>${escapeHTML(correctText)}</span>
               </div>`
            : ''
        }
        ${
          loc.explanation
            ? `<div class="p-3 rounded-lg bg-sky-50 text-brand-navy border border-sky-200">
                 <span class="font-bold block mb-0.5">💡 Key Clinical Takeaway:</span>
                 <span>${escapeHTML(loc.explanation)}</span>
               </div>`
            : ''
        }
      </div>
    `;
    container.appendChild(details);
  });
}

// ============================================================================
// 8. CLIENT-SIDE PDF GENERATORS (Mirrors report.py)
// ============================================================================
function downloadCertificatePDF() {
  const report = state.lastReport || calculateAssessmentReport();
  if (!report.passed) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  // Outer & Inner Borders
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
  doc.text('Certificate of Completion', 105, 52, { align: 'center' });

  // Subtitle
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(15);
  doc.setTextColor(44, 110, 159);
  doc.text('AI Literacy in Radiation Oncology', 105, 63, { align: 'center' });

  doc.setDrawColor(44, 110, 159);
  doc.setLineWidth(0.8);
  doc.line(35, 71, 175, 71);

  doc.setFontSize(13);
  doc.setTextColor(60, 60, 60);
  doc.text('This certifies that', 105, 92, { align: 'center' });

  // Candidate Name
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(24);
  doc.setTextColor(26, 58, 92);
  doc.text(report.participantName || 'Participant', 105, 108, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(13);
  doc.setTextColor(60, 60, 60);
  doc.text('has successfully completed the', 105, 124, { align: 'center' });

  // Track-specific Certificate Title (from config.py)
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.setTextColor(26, 58, 92);
  const titleLines = doc.splitTextToSize(report.certTitle, 160);
  doc.text(titleLines, 105, 134, { align: 'center' });

  // Domain Breakdown Box
  doc.setFillColor(240, 246, 250);
  doc.roundedRect(30, 148, 150, 42, 3, 3, 'F');
  doc.setFontSize(11);
  doc.setTextColor(26, 58, 92);
  doc.text('Domain Performance Breakdown', 105, 157, { align: 'center' });

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(50, 50, 50);
  report.domainResults.forEach((d, idx) => {
    const y = 166 + idx * 7;
    doc.text(`${d.name}: ${d.pct.toFixed(0)}% (${d.correct}/${d.total})`, 105, y, { align: 'center' });
  });

  // Details Footer
  doc.setFontSize(12);
  doc.setTextColor(50, 50, 50);
  doc.text(
    `Score: ${report.scorePct.toFixed(1)}% (${report.rawScore}/${report.totalScored})`,
    105,
    208,
    { align: 'center' }
  );
  doc.text(`Competency level: ${report.competencyLevel}`, 105, 217, { align: 'center' });
  doc.text(`Date: ${report.dateFormatted}`, 105, 226, { align: 'center' });
  doc.setFont('helvetica', 'bold');
  doc.text(`Certificate ID: ${report.verificationId}`, 105, 235, { align: 'center' });

  // Evaluator track note (mirrors report.py)
  if (report.certNote) {
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(9.5);
    doc.setTextColor(164, 38, 44); // #a4262c
    const noteLines = doc.splitTextToSize(report.certNote, 150);
    doc.text(noteLines, 105, 250, { align: 'center' });
  }

  const safeName = (report.participantName || 'participant')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();
  doc.save(`certificate_${report.track}_${safeName}.pdf`);
}

function downloadStudySummaryPDF() {
  const report = state.lastReport || calculateAssessmentReport();
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  let y = 20;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.setTextColor(26, 58, 92);
  doc.text('Personalised Learning Plan', 15, y);

  y += 7;
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  doc.text(`AI Literacy in Radiation Oncology — ${report.trackLabel} track`, 15, y);

  y += 5;
  doc.text(
    `Prepared for ${report.participantName} · ${report.dateFormatted} · Score: ${report.scorePct.toFixed(1)}% (${report.competencyLevel})`,
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

  const activeQuestions = getActiveQuestions();
  const missed = activeQuestions.filter(
    (q) => q.correct_option > 0 && state.answers[q.id] !== q.correct_option
  );

  y += 4;
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(12);
  doc.setTextColor(26, 58, 92);
  doc.text(
    missed.length > 0
      ? `Focus Areas to Review (${missed.length} Topics)`
      : 'All Assessed Topics Answered Correctly!',
    15,
    y
  );
  y += 6;

  missed.forEach((q) => {
    const loc = getLocalizedQuestion(q);
    const userChoice = state.answers[q.id];
    const userText = userChoice ? loc.options[userChoice - 1] : 'Not answered';
    const correctText = loc.options[loc.correctOption - 1];

    const heading = loc.topic ? `${loc.topic}` : `Question ${q.id}`;
    const qLines = doc.splitTextToSize(`Scenario: ${loc.questionText}`, 175);
    const uLines = doc.splitTextToSize(`Your answer: ${userText}`, 170);
    const cLines = doc.splitTextToSize(`Correct concept: ${correctText}`, 170);
    const eLines = loc.explanation
      ? doc.splitTextToSize(`Key takeaway: ${loc.explanation}`, 170)
      : [];

    const blockHeight =
      6 + (qLines.length + uLines.length + cLines.length + eLines.length) * 4.4 + 10;
    if (y + blockHeight > 280) {
      doc.addPage();
      y = 20;
    }

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(11);
    doc.setTextColor(26, 58, 92);
    doc.text(heading, 15, y);
    y += 5;

    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9.5);
    doc.setTextColor(50, 50, 50);
    doc.text(qLines, 15, y);
    y += qLines.length * 4.3 + 1.5;

    doc.setTextColor(164, 38, 44);
    doc.text(uLines, 18, y);
    y += uLines.length * 4.3 + 1.5;

    doc.setFont('helvetica', 'bold');
    doc.setTextColor(22, 101, 52);
    doc.text(cLines, 18, y);
    y += cLines.length * 4.3 + 1.5;

    if (eLines.length > 0) {
      doc.setFont('helvetica', 'italic');
      doc.setTextColor(44, 110, 159);
      doc.text(eLines, 18, y);
      y += eLines.length * 4.3 + 1.5;
    }

    doc.setDrawColor(230, 230, 230);
    doc.line(15, y + 1, 195, y + 1);
    y += 6;
  });

  const safeName = (report.participantName || 'participant')
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase();
  doc.save(`learning_plan_${report.track}_${safeName}.pdf`);
}

function downloadJSONBackup() {
  const report = state.lastReport || calculateAssessmentReport();
  const dataStr =
    'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(report, null, 2));
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', `ro_ai_assessment_${report.verificationId}.json`);
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// ============================================================================
// 9. EVENT LISTENERS & HELPERS
// ============================================================================
function bindEvents() {
  document.getElementById('lang-selector').addEventListener('change', (e) => {
    if (!CONFIG.ENABLE_MULTILINGUAL) return;
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

  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => parseCSVContent(evt.target.result);
    reader.readAsText(file);
  });

  document.getElementById('btn-resume').addEventListener('click', () => {
    const raw = localStorage.getItem(CONFIG.STORAGE_KEY);
    if (raw) {
      state = { ...getInitialState(), ...JSON.parse(raw) };
      if (!CONFIG.ENABLE_MULTILINGUAL) state.lang = 'en';
      document.getElementById('lang-selector').value = state.lang;
      showStage(state.stage === 'results' ? 'results' : 'quiz');
    }
  });

  document.getElementById('btn-start-fresh').addEventListener('click', () => {
    clearSavedStorage();
    state = getInitialState();
    document.getElementById('resume-banner').classList.add('hidden');
    renderTrackOptions();
  });

  document.getElementById('start-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = document.getElementById('input-name').value.trim();
    const email = document.getElementById('input-email').value.trim();
    const consent = document.getElementById('input-consent').checked;
    const selectedTrack =
      document.querySelector('input[name="assessment_track"]:checked')?.value ||
      CONFIG.DEFAULT_TRACK;
    const errEl = document.getElementById('form-error');

    const emailRegex = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!name) {
      errEl.textContent = 'Please enter your name to begin.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!emailRegex.test(email)) {
      errEl.textContent = 'Please enter a valid email address.';
      errEl.classList.remove('hidden');
      return;
    }
    if (!consent) {
      errEl.textContent =
        'Please confirm you have read and agree to the privacy notice to begin.';
      errEl.classList.remove('hidden');
      return;
    }

    errEl.classList.add('hidden');
    state = getInitialState();
    state.lang = CONFIG.ENABLE_MULTILINGUAL
      ? document.getElementById('lang-selector').value
      : 'en';
    state.track = selectedTrack;
    state.participant = { name, email, consent };
    saveStateToStorage();
    showStage('quiz');
  });

  document.getElementById('help-toggle').addEventListener('click', () => {
    const q = getActiveQuestions()[state.currentIndex];
    if (!q) return;
    const open = document.getElementById('help-toggle').getAttribute('aria-expanded') !== 'true';
    setHelpOpen(open);
    if (open) {
      if (!state.helpOpened) state.helpOpened = {};
      state.helpOpened[q.id] = true;
      saveStateToStorage();
    }
  });

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

  document.addEventListener('keydown', (e) => {
    if (state.stage !== 'quiz') return;
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    if (document.activeElement?.closest('#question-aside')) return;

    const activeQuestions = getActiveQuestions();
    const q = activeQuestions[state.currentIndex];
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

  document.getElementById('mobile-sidebar-toggle').addEventListener('click', () => {
    const sb = document.getElementById('quiz-sidebar');
    const bd = document.getElementById('sidebar-backdrop');
    sb.classList.toggle('-translate-x-full');
    bd.classList.toggle('hidden');
  });

  document.getElementById('sidebar-backdrop').addEventListener('click', closeMobileSidebar);

  document.getElementById('btn-download-cert').addEventListener('click', downloadCertificatePDF);
  document.getElementById('btn-download-study').addEventListener('click', downloadStudySummaryPDF);
  document.getElementById('btn-download-json').addEventListener('click', downloadJSONBackup);

  document.getElementById('btn-retry-sync').addEventListener('click', () => {
    if (state.lastReport) submitToSupabase(state.lastReport);
  });

  const btnAll = document.getElementById('filter-review-all');
  const btnMissed = document.getElementById('filter-review-missed');

  btnAll.addEventListener('click', () => {
    reviewFilter = 'all';
    btnAll.className =
      'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-brand-navy shadow-sm transition';
    btnMissed.className =
      'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    renderReviewAccordion();
  });

  btnMissed.addEventListener('click', () => {
    reviewFilter = 'missed';
    btnMissed.className =
      'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-brand-navy shadow-sm transition';
    btnAll.className =
      'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition';
    renderReviewAccordion();
  });

  document.getElementById('btn-restart').addEventListener('click', () => {
    clearSavedStorage();
    state = getInitialState();
    state.lang = CONFIG.ENABLE_MULTILINGUAL
      ? document.getElementById('lang-selector').value
      : 'en';
    document.getElementById('resume-banner').classList.add('hidden');
    showStage('welcome');
  });
}

function handleNextOrSubmit() {
  const activeQuestions = getActiveQuestions();
  const currentQ = activeQuestions[state.currentIndex];
  const warnEl = document.getElementById('unanswered-warning');

  if (state.answers[currentQ.id] === undefined) {
    warnEl.textContent = 'Please select an answer option before continuing.';
    warnEl.classList.remove('hidden');
    return;
  }

  warnEl.classList.add('hidden');

  if (state.currentIndex < activeQuestions.length - 1) {
    state.currentIndex += 1;
    saveStateToStorage();
    renderSidebar();
    renderCurrentQuestion();
  } else {
    const firstMissingIdx = activeQuestions.findIndex(
      (q) => state.answers[q.id] === undefined
    );
    if (firstMissingIdx !== -1) {
      state.currentIndex = firstMissingIdx;
      renderSidebar();
      renderCurrentQuestion();
      warnEl.textContent = `Please complete Question ${firstMissingIdx + 1} before final submission.`;
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
