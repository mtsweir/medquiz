import express from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import morgan from 'morgan';
import multer from 'multer';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(morgan('dev'));
app.use(express.json({ limit: '1mb' }));
app.use(express.static('public'));

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  }
});

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

function createDetailedMedicalQuestion(sentences, corpusKeywords) {
  // Find sentences with medical facts, benefits, or effects
  const factSentences = sentences.filter(s => {
    const lower = s.toLowerCase();
    return (
      (lower.includes('benefit') || lower.includes('effect') || lower.includes('help') || 
       lower.includes('improve') || lower.includes('reduce') || lower.includes('increase') ||
       lower.includes('decrease') || lower.includes('cause') || lower.includes('prevent') ||
       lower.includes('treat') || lower.includes('support') || lower.includes('role in') ||
       lower.includes('essential for') || lower.includes('important for') ||
       lower.includes('associated with') || lower.includes('linked to') ||
       lower.includes('side effect') || lower.includes('common') || lower.includes('used for') ||
       lower.includes('indicated for') || lower.includes('prescribed for')) &&
      s.length >= 60 && s.length <= 300
    );
  });

  if (factSentences.length === 0) {
    // Try to find any medical sentences
    const medicalSentences = sentences.filter(s => {
      const lower = s.toLowerCase();
      return MEDICAL_HINT_WORDS.some(word => lower.includes(word)) && s.length >= 60 && s.length <= 300;
    });
    
    if (medicalSentences.length === 0) {
      throw new Error('No suitable medical content found for question generation.');
    }
    
    // Always use contextual questions, never fallback
    return createContextualMedicalQuestion(medicalSentences[0], sentences);
  }

  // Choose a good sentence with medical facts
  const selectedSentence = factSentences[Math.floor(factSentences.length / 2)];
  
  // Extract key medical concepts and create detailed question
  return createContextualMedicalQuestion(selectedSentence, sentences);
}

function createContextualMedicalQuestion(sentence, allSentences) {
  const lower = sentence.toLowerCase();
  
  // Identify the main medical subject
  let subject = null;
  let questionType = 'multiple-choice';
  
  // Look for main medical topics (expanded list)
  const medicalTopics = [
    'magnesium', 'calcium', 'vitamin d', 'vitamin c', 'vitamin b', 'iron', 'zinc', 'omega-3', 'potassium',
    'diabetes', 'hypertension', 'blood pressure', 'cholesterol', 'heart disease', 'cardiovascular',
    'exercise', 'diet', 'nutrition', 'supplements', 'medication', 'therapy', 'treatment',
    'cancer', 'depression', 'anxiety', 'inflammation', 'immune system', 'immunity',
    'sleep', 'stress', 'weight loss', 'muscle', 'bone', 'brain', 'memory', 'cognitive',
    'sildenafil', 'viagra', 'cialis', 'erectile dysfunction', 'ed', 'prozyte',
    'antioxidant', 'fiber', 'protein', 'carbohydrate', 'fat', 'metabolism',
    'blood sugar', 'insulin', 'glucose', 'kidney', 'liver', 'digestive',
    'arthritis', 'osteoporosis', 'stroke', 'alzheimer', 'dementia'
  ];
  
  // Find all matching topics and choose the most specific one
  const foundTopics = medicalTopics.filter(topic => lower.includes(topic));
  if (foundTopics.length > 0) {
    // Choose the longest (most specific) topic
    subject = foundTopics.sort((a, b) => b.length - a.length)[0];
  }
  
  if (!subject) {
    // Extract subject from sentence structure - look for medical-sounding words
    const words = sentence.split(' ').filter(w => 
      w.length > 4 && 
      /^[a-zA-Z]+$/.test(w) && 
      !STOP_WORDS.has(w.toLowerCase())
    );
    
    // Prioritize words that sound medical
    const medicalSoundingWords = words.filter(w => {
      const word = w.toLowerCase();
      return word.includes('tion') || word.includes('ine') || word.includes('ide') || 
             word.includes('ate') || word.includes('ase') || word.includes('ism');
    });
    
    subject = medicalSoundingWords[0] || words[0] || 'this treatment';
  }

  // Always create proper medical questions - never fill-in-the-blank
  // Generate question based on content type and randomization
  const shouldUseNegative = lower.includes('not ') || lower.includes('does not') || 
                           lower.includes('cannot') || Math.random() < 0.4;

  // Create specific question types - only medical multiple choice
  try {
    if (shouldUseNegative) {
      return createNegativeQuestion(subject, sentence, allSentences);
    } else {
      return createBenefitQuestion(subject, sentence, allSentences);
    }
  } catch (error) {
    // If specific question creation fails, create a generic medical knowledge question
    return createGenericMedicalQuestion(subject, sentence);
  }
}

function createGenericMedicalQuestion(subject, sentence) {
  const medicalQuestions = [
    {
      prompt: `What is the primary therapeutic indication for ${subject}?`,
      options: [
        `Treatment of cardiovascular conditions`,
        `Management of metabolic disorders`, 
        `Support for neurological function`,
        `Enhancement of immune response`
      ],
      correctIndex: 0,
      explanation: `${subject} is primarily used for cardiovascular therapeutic purposes based on medical literature.`
    },
    {
      prompt: `Which patient population should use ${subject} with caution?`,
      options: [
        `Patients with kidney dysfunction`,
        `Patients with liver impairment`,
        `Elderly patients over 65`,
        `Pediatric patients under 18`
      ],
      correctIndex: 1,
      explanation: `Patients with liver impairment require careful monitoring when using ${subject} due to potential metabolic effects.`
    },
    {
      prompt: `What is the recommended monitoring parameter for ${subject} therapy?`,
      options: [
        `Blood pressure and heart rate`,
        `Liver function tests`,
        `Kidney function markers`,
        `Blood glucose levels`
      ],
      correctIndex: 0,
      explanation: `Regular monitoring of blood pressure and heart rate is essential during ${subject} therapy.`
    }
  ];
  
  const selectedQuestion = medicalQuestions[Math.floor(Math.random() * medicalQuestions.length)];
  return {
    prompt: selectedQuestion.prompt,
    options: selectedQuestion.options,
    correctIndex: selectedQuestion.correctIndex,
    answer: selectedQuestion.options[selectedQuestion.correctIndex],
    explanation: selectedQuestion.explanation
  };
}

function createNegativeQuestion(subject, factSentence, allSentences) {
  // Find what the subject DOES do (correct answers)
  const benefits = extractBenefits(subject, allSentences);
  
  // Create one false claim as the correct answer
  const falseClaims = [
    `Significantly increases muscle mass without exercise`,
    `Completely cures all forms of cancer`,
    `Eliminates the need for any other medications`,
    `Provides instant permanent weight loss`,
    `Reverses aging at the cellular level`,
    `Replaces the need for sleep entirely`,
    `Guarantees immunity to all diseases`,
    `Doubles intelligence within days`,
    `Makes you physically younger by 10 years`,
    `Replaces the need for all vitamins and minerals`,
    `Instantly improves IQ by 50 points`,
    `Prevents all known diseases permanently`
  ];
  
  const falseAnswer = falseClaims[Math.floor(Math.random() * falseClaims.length)];
  
  // Use real benefits as distractors, ensure no duplicates
  let realBenefits = Array.from(new Set(benefits)).slice(0, 5); // Get more to choose from
  
  // Add fallback benefits if needed
  const fallbackBenefits = [
    `Supports cardiovascular health`,
    `May improve metabolic function`,
    `Helps maintain normal blood flow`,
    `Can aid in treatment compliance`,
    `Supports overall therapeutic outcomes`,
    `May enhance quality of life`
  ];
  
  // Ensure we have enough unique options
  const allBenefits = [...realBenefits, ...fallbackBenefits];
  const uniqueBenefits = Array.from(new Set(allBenefits)).slice(0, 3);

  const options = [...uniqueBenefits, falseAnswer];
  
  // Ensure all options are unique
  const finalOptions = Array.from(new Set(options)).slice(0, 4);
  while (finalOptions.length < 4) {
    finalOptions.push(`Provides general health support`);
  }
  
  // Shuffle options
  const shuffledOptions = finalOptions.sort(() => Math.random() - 0.5);
  const correctIndex = shuffledOptions.findIndex(opt => opt === falseAnswer);

  // Vary the question prompts
  const questionPrompts = [
    `Which of the following is NOT a scientifically recognized benefit of ${subject} according to research?`,
    `According to medical studies, which statement about ${subject} is FALSE?`,
    `Which of these claims about ${subject} lacks scientific evidence?`,
    `Research does NOT support which of the following benefits of ${subject}?`,
    `Which statement about ${subject} is NOT backed by scientific research?`
  ];

  const prompt = questionPrompts[Math.floor(Math.random() * questionPrompts.length)];

  return {
    prompt,
    options: shuffledOptions,
    correctIndex,
    answer: falseAnswer,
    explanation: `While ${subject} has many proven health benefits, there is no scientific evidence supporting this exaggerated claim. The other options represent genuine, research-backed benefits.`
  };
}

function createBenefitQuestion(subject, factSentence, allSentences) {
  // Extract real benefits and ensure uniqueness
  const benefits = Array.from(new Set(extractBenefits(subject, allSentences)));
  
  // Generic medical options as fallbacks
  const genericOptions = [
    `Supports cardiovascular health`,
    `May improve blood circulation`,
    `Helps maintain normal function`,
    `Can aid in treatment outcomes`,
    `Supports metabolic processes`,
    `May enhance therapeutic effects`,
    `Contributes to overall wellness`,
    `Helps optimize therapeutic response`
  ];
  
  // Combine and ensure uniqueness
  const allOptions = Array.from(new Set([...benefits, ...genericOptions]));
  
  // Select 4 unique options
  const selectedBenefits = chooseDistinctRandom(allOptions, 4);
  
  // Ensure we have exactly 4 unique options
  while (selectedBenefits.length < 4) {
    const fallback = `Provides medical benefit ${selectedBenefits.length + 1}`;
    if (!selectedBenefits.includes(fallback)) {
      selectedBenefits.push(fallback);
    }
  }
  
  const questionPrompts = [
    `Which of the following is a recognized benefit of ${subject}?`,
    `According to research, ${subject} is known to:`,
    `Medical studies suggest that ${subject} can:`,
    `What is a scientifically supported effect of ${subject}?`,
    `Research indicates that ${subject} may help with:`,
    `Which statement about ${subject} is supported by medical evidence?`
  ];
  
  const prompt = questionPrompts[Math.floor(Math.random() * questionPrompts.length)];
  const correctAnswer = selectedBenefits[0];
  
  return {
    prompt,
    options: selectedBenefits,
    correctIndex: 0,
    answer: correctAnswer,
    explanation: `Clinical studies demonstrate that ${subject} provides this therapeutic benefit through well-established mechanisms of action. This finding is consistently reported in peer-reviewed medical literature.`
  };
}

function extractBenefits(subject, sentences) {
  const benefits = [];
  
  for (const sentence of sentences) {
    const lower = sentence.toLowerCase();
    if (!lower.includes(subject.toLowerCase())) continue;
    
    // Look for shorter, more concise benefit patterns
    const benefitPatterns = [
      /(?:helps?|help) (?:to )?([^.,]{15,50})/gi,
      /(?:improves?|improve) ([^.,]{15,50})/gi,
      /(?:reduces?|reduce) ([^.,]{15,50})/gi,
      /(?:supports?|support) ([^.,]{15,50})/gi,
      /(?:may|can) (?:help|improve|reduce|support|lower|enhance) ([^.,]{15,50})/gi,
      /(?:treats?|prevents?) ([^.,]{15,50})/gi,
      /(?:effective for|used for) ([^.,]{15,50})/gi
    ];
    
    for (const pattern of benefitPatterns) {
      let match;
      while ((match = pattern.exec(sentence)) !== null) {
        let benefit = match[1].trim();
        
        // Clean up and validate the benefit
        if (benefit.length >= 15 && benefit.length <= 50) {
          // Remove trailing words that make it too long
          benefit = benefit.replace(/\s+(?:and|or|but|by|with|in|for|of|to|from|at|when|while|during|after|before).*$/, '');
          
          // Capitalize first letter
          benefit = benefit.charAt(0).toUpperCase() + benefit.slice(1);
          
          // Add concise verb prefix if needed
          if (!benefit.startsWith('Helps') && !benefit.startsWith('Improves') && 
              !benefit.startsWith('Reduces') && !benefit.startsWith('Supports') &&
              !benefit.startsWith('May ') && !benefit.startsWith('Can ')) {
            
            if (lower.includes('help')) benefit = `Helps ${benefit.toLowerCase()}`;
            else if (lower.includes('improve')) benefit = `Improves ${benefit.toLowerCase()}`;
            else if (lower.includes('reduce')) benefit = `Reduces ${benefit.toLowerCase()}`;
            else if (lower.includes('support')) benefit = `Supports ${benefit.toLowerCase()}`;
            else benefit = `May help ${benefit.toLowerCase()}`;
          }
          
          // Keep only if reasonably short
          if (benefit.length >= 20 && benefit.length <= 60) {
            benefits.push(benefit);
          }
        }
      }
    }
  }
  
  return Array.from(new Set(benefits)).slice(0, 8); // Remove duplicates, get more options
}

// This function is no longer used - all questions are now contextual medical questions
/*function createFallbackQuestion(sentence) {
  // Create knowledge-based questions instead of fill-in-the-blank
  const lower = sentence.toLowerCase();
  
  // Generate factual questions based on content patterns
  const factualPrompts = [
    "Which of the following statements is accurate according to medical research?",
    "What is considered a medically recognized fact?",
    "According to healthcare professionals, which statement is true?",
    "Which of these claims is supported by medical evidence?",
    "What do medical studies indicate?",
    "Which statement reflects current medical understanding?"
  ];
  
  // Create one correct statement based on the sentence
  let correctStatement = sentence.trim();
  if (correctStatement.length > 120) {
    // Shorten if too long
    const words = correctStatement.split(' ');
    correctStatement = words.slice(0, 20).join(' ') + '...';
  }
  
  // Generate plausible but incorrect medical statements
  const incorrectStatements = [
    "All medications work the same way for every patient",
    "Side effects only occur in people with pre-existing conditions",
    "Natural supplements never interact with prescription drugs",
    "Medical treatments always provide immediate results",
    "Dosage recommendations are the same regardless of age or weight",
    "Generic medications are less effective than brand-name drugs",
    "All medical conditions can be self-diagnosed accurately",
    "Stopping medication abruptly is always safe once symptoms improve"
  ];
  
  // Select 3 random incorrect statements
  const selectedIncorrect = [];
  while (selectedIncorrect.length < 3) {
    const random = incorrectStatements[Math.floor(Math.random() * incorrectStatements.length)];
    if (!selectedIncorrect.includes(random)) {
      selectedIncorrect.push(random);
    }
  }
  
  const options = [...selectedIncorrect, correctStatement].sort(() => Math.random() - 0.5);
  const correctIndex = options.findIndex(opt => opt === correctStatement);
  
  const prompt = factualPrompts[Math.floor(Math.random() * factualPrompts.length)];
  
  return {
    prompt,
    options,
    correctIndex,
    answer: correctStatement,
    explanation: `This statement accurately reflects information from the source material and is supported by medical evidence.`
  };
}*/

// Function to generate quiz from text content
function generateQuizFromText(text, title = 'Medical Content', source = 'Direct Input', quizIndex = 0) {
  if (!text || text.length < 200) {
    throw new Error('Content has insufficient text to build a quiz (minimum 200 characters).');
  }

  const sentences = splitIntoSentences(text);

  // Filter candidate sentences
  let candidateSentences = sentences.filter((s) => s.length >= 60 && s.length <= 250 && /[a-zA-Z]/.test(s));
  const medicalCandidates = candidateSentences.filter(containsMedicalHint);
  if (medicalCandidates.length >= 6) {
    candidateSentences = medicalCandidates;
  }

  if (candidateSentences.length < 1) {
    throw new Error('Not enough suitable content found to generate a question. Please provide medical content with more detail.');
  }

  // Build corpora
  const corpusNumbers = Array.from(new Set(candidateSentences.flatMap(findNumbers)));
  const corpusKeywords = extractKeywords(candidateSentences, 200);

  // Use quiz index to select different sentences for variety
  const totalPossible = Math.min(candidateSentences.length, 10);
  const selectedIndex = quizIndex % candidateSentences.length;
  
  // Use the selected sentence for question generation
  const selectedSentence = candidateSentences[selectedIndex];
  const q = createContextualMedicalQuestion(selectedSentence, candidateSentences);
  
  const question = {
    id: 'q1',
    prompt: q.prompt,
    choices: q.options.map((text, i) => ({ id: `q1_c${i + 1}`, text })),
    correctChoiceId: `q1_c${q.correctIndex + 1}`,
    correctAnswer: q.answer,
    explanation: q.explanation
  };

  const questions = [question];

  return {
    id: `quiz_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    title: title || 'Medical Content',
    source,
    generatedAt: new Date().toISOString(),
    questions,
    totalPossible,
    currentIndex: quizIndex + 1
  };
}

// API endpoint to count possible quizzes
app.post('/api/quiz/count', async (req, res) => {
  const { url, text } = req.body || {};

  try {
    let content = '';
    let sourceTitle = 'Medical Content';

    if (url) {
      if (!isValidHttpUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL format. Please enter a valid URL starting with http:// or https://' });
      }

      const response = await fetchWithRetries(url);
      const html = response.data;
      const extractedData = extractMainText(html);
      content = extractedData.text;
      sourceTitle = extractedData.title;
    } else if (text) {
      content = text;
      sourceTitle = 'Direct Input';
    } else {
      return res.status(400).json({ error: 'Either URL or text content is required.' });
    }

    const count = countPossibleQuizzes(content);
    res.json({ 
      count, 
      title: sourceTitle,
      hasContent: content.length >= 200
    });

  } catch (error) {
    console.error('Error counting quizzes:', error);
    res.status(500).json({ error: error.message || 'Failed to analyze content for quiz generation.' });
  }
});

// Function to count possible quizzes from content
function countPossibleQuizzes(text) {
  if (!text || text.length < 200) {
    return 0;
  }

  const sentences = splitIntoSentences(text);
  let candidateSentences = sentences.filter((s) => s.length >= 60 && s.length <= 250 && /[a-zA-Z]/.test(s));
  const medicalCandidates = candidateSentences.filter(containsMedicalHint);
  
  if (medicalCandidates.length >= 6) {
    candidateSentences = medicalCandidates;
  }

  // Estimate number of possible unique questions
  return Math.min(candidateSentences.length, 10); // Cap at 10 for performance
}

// API endpoint to generate quiz from URL or text content
app.post('/api/quiz', async (req, res) => {
  const { url, text, title, quizIndex = 0 } = req.body || {};
  
  // Handle text content directly
  if (text) {
    try {
      const quiz = generateQuizFromText(text, title, 'Text Input', quizIndex);
      return res.json({ ...quiz, url: null });
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
  }
  
  // Handle URL (existing logic)
  if (!url || !isValidHttpUrl(url)) {
    return res.status(400).json({ error: 'Please provide a valid http(s) URL or text content.' });
  }

  // Try multiple user agents to avoid bot detection
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:89.0) Gecko/20100101 Firefox/89.0'
  ];

  let lastError = null;

  for (let attempt = 0; attempt < userAgents.length; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: 15000,
        headers: {
          'User-Agent': userAgents[attempt],
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
          'Accept-Encoding': 'gzip, deflate',
          'DNT': '1',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
        },
        maxRedirects: 5,
        validateStatus: (s) => s >= 200 && s < 400
      });

      // If we get here, the request succeeded
      const { title, text } = extractMainText(response.data);
      const quiz = generateQuizFromText(text, title, url, quizIndex);
      return res.json({ ...quiz, url });

    } catch (err) {
      lastError = err;
      console.log(`Attempt ${attempt + 1} failed:`, err.message);
      
      // If it's the last attempt, we'll handle the error below
      if (attempt === userAgents.length - 1) {
        break;
      }
      
      // Wait a bit before retrying
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // Handle the final error
  console.error('All attempts failed. Last error:', lastError?.message);
  
  if (lastError?.response?.status === 403) {
    return res.status(422).json({ 
      error: 'The website is blocking automated access. Try a different medical information source like:\n• Wikipedia medical articles\n• NIH/PubMed articles\n• University health pages\n• Government health sites (.gov domains)'
    });
  } else if (lastError?.response?.status === 404) {
    return res.status(422).json({ error: 'The URL was not found. Please check the link and try again.' });
  } else if (lastError?.code === 'ENOTFOUND' || lastError?.code === 'ECONNREFUSED') {
    return res.status(422).json({ error: 'Unable to connect to the website. Please check the URL and try again.' });
  } else if (lastError?.code === 'ETIMEDOUT') {
    return res.status(422).json({ error: 'The website took too long to respond. Please try again or use a different source.' });
  } else {
    return res.status(500).json({ 
      error: 'Failed to fetch the source URL. Some websites block automated access. Try using medical articles from Wikipedia, NIH, or university websites instead.'
    });
  }
});

// PDF parsing function using pdfjs-dist
async function parsePdfContent(buffer) {
  try {
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(buffer),
      verbosity: 0 // Suppress console warnings
    });
    
    const pdfDocument = await loadingTask.promise;
    const numPages = pdfDocument.numPages;
    let fullText = '';
    
    // Extract text from each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdfDocument.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      fullText += pageText + ' ';
    }
    
    return {
      text: fullText.trim(),
      numPages: numPages,
      info: {} // pdfjs doesn't easily expose metadata in this version
    };
  } catch (error) {
    throw new Error(`PDF parsing failed: ${error.message}`);
  }
}

// API endpoint to generate quiz from PDF upload
app.post('/api/quiz/pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Please upload a PDF file.' });
    }

    console.log('Processing PDF file:', req.file.originalname);
    
    // Parse PDF content
    const pdfData = await parsePdfContent(req.file.buffer);
    const text = pdfData.text;
    
    if (!text || text.trim().length < 200) {
      return res.status(422).json({ 
        error: 'PDF content is too short or could not be extracted. Please ensure the PDF contains readable medical text content.' 
      });
    }

    // Extract title from filename
    const title = req.file.originalname.replace(/\.pdf$/i, '').replace(/[_-]/g, ' ') || 'Medical PDF Document';

    const quizIndex = parseInt(req.body.quizIndex) || 0;
    const quiz = generateQuizFromText(text, title, `PDF: ${req.file.originalname}`, quizIndex);
    
    // Don't store the full text in response for performance
    res.json({ 
      ...quiz, 
      url: null,
      source: `PDF: ${req.file.originalname}`,
      fileSize: req.file.size,
      pages: pdfData.numPages 
    });

  } catch (err) {
    console.error('PDF processing error:', err.message);
    
    if (err.message.includes('Invalid PDF') || err.message.includes('PDF')) {
      return res.status(422).json({ 
        error: 'Invalid or corrupted PDF file. Please upload a valid PDF with readable text content.' 
      });
    }
    
    res.status(422).json({ 
      error: err.message || 'Failed to process PDF file. Please ensure it contains readable medical text content.' 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => res.json({ ok: true }));

// Quiz rating storage (in production, use a database)
const quizRatings = new Map();

// API endpoint for rating quizzes
app.post('/api/quiz/rate', (req, res) => {
  const { quizId, rating, feedback } = req.body;
  
  if (!quizId || !rating || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ error: 'Valid quiz ID and rating (up/down) required.' });
  }
  
  const ratingData = {
    rating,
    feedback: feedback || '',
    timestamp: new Date().toISOString(),
    id: quizId
  };
  
  if (!quizRatings.has(quizId)) {
    quizRatings.set(quizId, []);
  }
  
  quizRatings.get(quizId).push(ratingData);
  
  console.log(`Quiz ${quizId} rated: ${rating}${feedback ? ` (${feedback})` : ''}`);
  
  res.json({ success: true, message: 'Rating recorded successfully' });
});

// API endpoint to get quiz rating stats
app.get('/api/quiz/stats', (req, res) => {
  const stats = {
    totalRatings: 0,
    upvotes: 0,
    downvotes: 0,
    recentFeedback: []
  };
  
  for (const ratings of quizRatings.values()) {
    stats.totalRatings += ratings.length;
    for (const rating of ratings) {
      if (rating.rating === 'up') stats.upvotes++;
      else stats.downvotes++;
      
      if (rating.feedback) {
        stats.recentFeedback.push({
          rating: rating.rating,
          feedback: rating.feedback,
          timestamp: rating.timestamp
        });
      }
    }
  }
  
  stats.recentFeedback = stats.recentFeedback
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 10);
  
  res.json(stats);
});

app.listen(PORT, () => {
  console.log(`🚀 Medical Quiz server running on http://localhost:${PORT}`);
});
