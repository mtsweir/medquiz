import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import morgan from 'morgan';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

function isValidHttpUrl(candidate) {
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function extractMainText(html) {
  const $ = cheerio.load(html);

  // Remove non-content elements
  ['script', 'style', 'noscript', 'nav', 'footer', 'header', 'svg', 'iframe', 'form', 'button', 'input', 'aside'].forEach((sel) => $(sel).remove());

  let root = $('main').first();
  if (!root || !root.length) root = $('article').first();
  if (!root || !root.length) root = $('[role="main"]').first();
  if (!root || !root.length) root = $('body').first();

  const title = ($('title').first().text() || '').trim();

  const text = root
    .text()
    .replace(/\s+/g, ' ')
    .replace(/\u00a0/g, ' ')
    .trim();

  return { title, text };
}

const STOP_WORDS = new Set([
  'the','and','that','have','for','not','with','you','this','but','his','they','her','she','from','had','was','are','been','were','their','will','would','there','what','when','where','which','your','can','all','about','more','some','other','into','than','them','then','also','such','may','like','over','most','many','those','these','within','between','without','including','because','while','after','before','under','above','during','each','both','any','very','could','should','might','used','using','use','one','two','three','four','five','six','seven','eight','nine','ten','is','of','in','to','a','an','on','at','it','as','by','or','be','we','our','its'
]);

const MEDICAL_HINT_WORDS = [
  'symptom','symptoms','diagnosis','diagnose','treatment','treatments','therapy','therapies','dosage','dose','mg','ml','side effect','side effects','risk','risks','cause','causes','caused','prevention','prevent','vaccine','vaccination','disease','condition','disorder','syndrome','infection','infectious','pathogen','virus','bacteria','bacterial','viral','fungal','incidence','prevalence','mortality','morbidity','hypertension','diabetes','cancer','asthma','allergy','allergic','cardio','heart','renal','kidney','liver','hepatitis','covid','immunity','immune','inflammation','inflammatory','pain','fever','blood pressure','cholesterol','glucose','insulin'
];

function splitIntoSentences(text) {
  // Simple sentence splitter
  const parts = text
    .replace(/\s+/g, ' ')
    .split(/(?<=[\.!?])\s+(?=[A-Z0-9"'\(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts;
}

function findNumbers(str) {
  const matches = str.match(/(?:(?:\d{1,3}(?:,\d{3})+)|\d+)(?:\.\d+)?\s?(?:%|mg|ml|mmHg|kg|g|mcg|years|year|days|day|hours|hour|bpm)?/gi);
  return matches ? Array.from(new Set(matches.map((m) => m.trim()))) : [];
}

function extractKeywords(sentences, maxKeywords = 100) {
  const freq = new Map();
  for (const s of sentences) {
    const words = s
      .replace(/[^A-Za-z0-9\s\-]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w) && w.length >= 5);
    for (const w of words) freq.set(w, (freq.get(w) || 0) + 1);
  }
  const sorted = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxKeywords)
    .map(([w]) => w);
  return sorted;
}

function containsMedicalHint(sentence) {
  const lower = sentence.toLowerCase();
  return MEDICAL_HINT_WORDS.some((kw) => lower.includes(kw));
}

function chooseDistinctRandom(array, count, exclude = new Set()) {
  const pool = array.filter((x) => !exclude.has(x));
  const result = [];
  const used = new Set();
  while (result.length < count && pool.length > 0) {
    const idx = Math.floor(Math.random() * pool.length);
    const val = pool.splice(idx, 1)[0];
    if (!used.has(val)) {
      used.add(val);
      result.push(val);
    }
  }
  return result;
}

function createClozeQuestionFromSentence(sentence, corpusNumbers, corpusKeywords) {
  const sentenceNumbers = findNumbers(sentence);
  let answer = null;
  let distractorPool = [];
  let type = 'text';

  if (sentenceNumbers.length > 0) {
    answer = sentenceNumbers[0];
    type = 'number';
    distractorPool = corpusNumbers.filter((n) => n !== answer);
    if (distractorPool.length < 3) {
      // fabricate plausible numeric distractors
      const asNum = parseFloat(answer.replace(/[^0-9.]/g, ''));
      const units = (answer.match(/%|mg|ml|mmHg|kg|g|mcg|years|year|days|day|hours|hour|bpm/i) || [''])[0];
      const candidates = [asNum * 0.5, asNum * 0.75, asNum * 1.25, asNum * 1.5, asNum + 1, asNum + 5]
        .map((n) => {
          const rounded = n % 1 === 0 ? Math.round(n) : Math.round(n * 10) / 10;
          return units ? `${rounded}${units}` : String(rounded);
        })
        .filter((v) => v !== answer);
      distractorPool = Array.from(new Set([...distractorPool, ...candidates]));
    }
  } else {
    // Choose a keyword from this sentence
    const words = sentence
      .replace(/[^A-Za-z\s\-]/g, ' ')
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w) && w.length >= 5);
    if (words.length > 0) {
      answer = words.sort((a, b) => (corpusKeywords.indexOf(a) - corpusKeywords.indexOf(b)))[0] || words[0];
    } else {
      // fallback: take a long word
      const fallback = sentence
        .replace(/[^A-Za-z\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 4);
      answer = fallback[0] || sentence.split(' ')[0];
    }
    distractorPool = corpusKeywords.filter((k) => k !== answer).slice(0, 50);
  }

  // Build cloze prompt
  const answerRegex = new RegExp(answer.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
  const cloze = sentence.replace(answerRegex, '_____');

  const distractors = chooseDistinctRandom(distractorPool, 3, new Set([answer]));
  while (distractors.length < 3) {
    distractors.push(type === 'number' ? String(Math.floor(Math.random() * 100)) : corpusKeywords[Math.floor(Math.random() * corpusKeywords.length)] || 'N/A');
  }

  const options = [...distractors, answer].sort(() => Math.random() - 0.5);
  const correctIndex = options.findIndex((o) => o.toLowerCase() === answer.toLowerCase());

  return {
    prompt: `Fill in the blank: ${cloze}`,
    options,
    correctIndex: correctIndex >= 0 ? correctIndex : options.length - 1,
    answer,
    explanation: `According to the source: "${sentence}"`
  };
}

app.post('/api/quiz', async (req, res) => {
  const { url } = req.body || {};
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid http(s) URL.' });
  }

  try {
    const response = await axios.get(url, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MedicalQuizBot/1.0; +https://example.com)'
      },
      maxRedirects: 5,
      validateStatus: (s) => s >= 200 && s < 400
    });

    const { title, text } = extractMainText(response.data);
    if (!text || text.length < 200) {
      return res.status(422).json({ error: 'Source page has insufficient extractable content to build a quiz.' });
    }

    const sentences = splitIntoSentences(text);

    // Filter candidate sentences
    let candidateSentences = sentences.filter((s) => s.length >= 60 && s.length <= 250 && /[a-zA-Z]/.test(s));
    const medicalCandidates = candidateSentences.filter(containsMedicalHint);
    if (medicalCandidates.length >= 6) {
      candidateSentences = medicalCandidates;
    }

    // Build corpora
    const corpusNumbers = Array.from(new Set(candidateSentences.flatMap(findNumbers)));
    const corpusKeywords = extractKeywords(candidateSentences, 200);

    // Choose up to 4 distinct sentences spread out
    const step = Math.max(1, Math.floor(candidateSentences.length / 8));
    const spread = [];
    for (let i = 0; i < candidateSentences.length && spread.length < 12; i += step) {
      spread.push(candidateSentences[i]);
    }
    const chosen = chooseDistinctRandom(spread.length ? spread : candidateSentences, 4);

    const questions = chosen.map((s, idx) => {
      const q = createClozeQuestionFromSentence(s, corpusNumbers, corpusKeywords);
      return {
        id: `q${idx + 1}`,
        prompt: q.prompt,
        choices: q.options.map((text, i) => ({ id: `q${idx + 1}_c${i + 1}`, text })),
        correctChoiceId: `q${idx + 1}_c${q.correctIndex + 1}`,
        explanation: q.explanation
      };
    });

    const payload = {
      url,
      title: title || 'Medical Source',
      generatedAt: new Date().toISOString(),
      questions
    };

    res.json(payload);
  } catch (err) {
    console.error('Error building quiz:', err.message);
    res.status(500).json({ error: 'Failed to fetch or process the source URL.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});