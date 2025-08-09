const entrySection = document.getElementById('entry-section');
const quizSection = document.getElementById('quiz-section');
const urlInput = document.getElementById('url-input');
const createQuizBtn = document.getElementById('create-quiz');
const entryError = document.getElementById('entry-error');
const quizTitle = document.getElementById('quiz-title');
const quizSource = document.getElementById('quiz-source');
const quizForm = document.getElementById('quiz-form');
const submitQuizBtn = document.getElementById('submit-quiz');
const scoreArea = document.getElementById('score-area');
const refreshBtn = document.getElementById('refresh-quiz');
const startOverBtn = document.getElementById('start-over');
const historyTbody = document.getElementById('history-tbody');
const clearHistoryBtn = document.getElementById('clear-history');

const questionTpl = document.getElementById('question-template');

let currentQuiz = null;
let currentSelections = new Map();

function saveHistoryItem(item) {
  const key = 'medical_quiz_history';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  list.unshift(item);
  localStorage.setItem(key, JSON.stringify(list.slice(0, 50)));
}

function updateLastScoreInHistory(id, score) {
  const key = 'medical_quiz_history';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  const idx = list.findIndex((x) => x.id === id);
  if (idx >= 0) {
    list[idx].score = score;
    localStorage.setItem(key, JSON.stringify(list));
  }
}

function loadHistory() {
  const key = 'medical_quiz_history';
  const list = JSON.parse(localStorage.getItem(key) || '[]');
  historyTbody.innerHTML = '';
  for (const item of list) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="px-4 py-2 whitespace-nowrap">${new Date(item.generatedAt).toLocaleString()}</td>
      <td class="px-4 py-2 max-w-[320px] truncate" title="${item.title}">${item.title}</td>
      <td class="px-4 py-2 max-w-[360px] truncate"><a class="text-sky-600 hover:underline" href="${item.url}" target="_blank" rel="noopener">${item.url}</a></td>
      <td class="px-4 py-2">${item.score ?? '—'}</td>
      <td class="px-4 py-2">
        <button class="text-sm text-sky-700 hover:underline mr-3" data-action="reopen" data-id="${item.id}">Reopen</button>
        <button class="text-sm text-slate-700 hover:underline" data-action="copyurl" data-url="${item.url}">Copy URL</button>
      </td>
    `;
    historyTbody.appendChild(tr);
  }
}

historyTbody.addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const action = btn.getAttribute('data-action');
  if (action === 'reopen') {
    const id = btn.getAttribute('data-id');
    const list = JSON.parse(localStorage.getItem('medical_quiz_history') || '[]');
    const item = list.find((x) => x.id === id);
    if (item) {
      urlInput.value = item.url;
      createQuizBtn.click();
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  } else if (action === 'copyurl') {
    const url = btn.getAttribute('data-url');
    navigator.clipboard.writeText(url);
  }
});

clearHistoryBtn.addEventListener('click', () => {
  localStorage.removeItem('medical_quiz_history');
  loadHistory();
});

function validateUrl(u) {
  try {
    const parsed = new URL(u);
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function setLoading(isLoading) {
  createQuizBtn.disabled = isLoading;
  refreshBtn.disabled = isLoading;
  submitQuizBtn.disabled = isLoading;
}

async function buildQuiz(url) {
  setLoading(true);
  entryError.classList.add('hidden');
  try {
    const res = await fetch('/api/quiz', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create quiz');
    currentQuiz = { ...data, id: crypto.randomUUID() };
    currentSelections = new Map();
    renderQuiz(currentQuiz);
    saveHistoryItem({ id: currentQuiz.id, url: currentQuiz.url, title: currentQuiz.title, generatedAt: currentQuiz.generatedAt });
  } catch (err) {
    entryError.textContent = err.message;
    entryError.classList.remove('hidden');
  } finally {
    setLoading(false);
  }
}

function renderQuiz(quiz) {
  entrySection.classList.add('hidden');
  quizSection.classList.remove('hidden');
  quizTitle.textContent = quiz.title;
  quizSource.innerHTML = `Source: <a class="text-sky-600 hover:underline" href="${quiz.url}" target="_blank" rel="noopener">${quiz.url}</a>`;

  quizForm.innerHTML = '';
  quiz.questions.forEach((q, qi) => {
    const node = questionTpl.content.cloneNode(true);
    const promptEl = node.querySelector('.font-medium');
    const optionsEl = node.querySelector('.grid');
    const explanationEl = node.querySelector('.text-sm');

    promptEl.textContent = `${qi + 1}. ${q.prompt}`;

    q.choices.forEach((choice, ci) => {
      const id = `${q.id}_${ci}`;
      const label = document.createElement('label');
      label.className = 'flex items-center gap-2 p-2 rounded-md border hover:bg-slate-50 cursor-pointer';
      label.innerHTML = `
        <input type="radio" name="${q.id}" value="${choice.id}" class="h-4 w-4 text-sky-600 focus:ring-sky-500" />
        <span>${choice.text}</span>
      `;
      optionsEl.appendChild(label);
    });

    // Store explanation element for later reveal
    explanationEl.setAttribute('data-explanation-for', q.id);
    explanationEl.textContent = q.explanation;

    quizForm.appendChild(node);
  });

  scoreArea.textContent = '';
}

createQuizBtn.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (!validateUrl(url)) {
    entryError.textContent = 'Please enter a valid http(s) URL.';
    entryError.classList.remove('hidden');
    return;
  }
  buildQuiz(url);
});

refreshBtn.addEventListener('click', () => {
  if (!currentQuiz) return;
  buildQuiz(currentQuiz.url);
});

startOverBtn.addEventListener('click', () => {
  currentQuiz = null;
  currentSelections = new Map();
  quizSection.classList.add('hidden');
  entrySection.classList.remove('hidden');
  scoreArea.textContent = '';
  quizForm.innerHTML = '';
  urlInput.focus();
});

quizForm.addEventListener('change', (e) => {
  const input = e.target.closest('input[type="radio"]');
  if (!input) return;
  const qid = input.name;
  const value = input.value;
  currentSelections.set(qid, value);
});

submitQuizBtn.addEventListener('click', (e) => {
  e.preventDefault();
  if (!currentQuiz) return;

  let correct = 0;
  currentQuiz.questions.forEach((q, qi) => {
    const chosen = currentSelections.get(q.id);
    const explanationEl = quizForm.querySelector(`[data-explanation-for="${q.id}"]`);
    explanationEl.classList.remove('hidden');

    const optionLabels = Array.from(quizForm.querySelectorAll(`input[name="${q.id}"]`)).map((inp) => inp.closest('label'));

    optionLabels.forEach((lab) => {
      lab.classList.remove('bg-green-50', 'border-green-400', 'bg-rose-50', 'border-rose-400');
    });

    // highlight correct and incorrect selections
    const correctInput = quizForm.querySelector(`input[name="${q.id}"][value="${q.correctChoiceId}"]`);
    if (correctInput) correctInput.closest('label').classList.add('bg-green-50', 'border-green-400');

    if (chosen === q.correctChoiceId) {
      correct += 1;
    } else if (chosen) {
      const chosenInput = quizForm.querySelector(`input[name="${q.id}"][value="${chosen}"]`);
      if (chosenInput) chosenInput.closest('label').classList.add('bg-rose-50', 'border-rose-400');
    }
  });

  const scorePct = Math.round((correct / currentQuiz.questions.length) * 100);
  scoreArea.textContent = `Score: ${correct}/${currentQuiz.questions.length} (${scorePct}%)`;
  updateLastScoreInHistory(currentQuiz.id, `${correct}/${currentQuiz.questions.length} (${scorePct}%)`);
  loadHistory();
});

// Initialize
loadHistory();