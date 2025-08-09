# Medical Information Trivia Quiz

A minimal Tailwind + Express app that generates a 4-question multiple choice quiz from any medical information webpage you provide.

Features:
- Enter a URL as the quiz source
- Auto-generates 4 cloze questions with one correct answer and 3 distractors
- Per-question explanation citing the source sentence
- Refresh to regenerate from the same source
- Start over to enter a new URL
- Previous quizzes stored in localStorage and shown in a table
- Simple scoring system

## Run

```bash
npm install
npm run dev
```

Open http://localhost:3000

Note: The server fetches the URL on your behalf (avoids browser CORS) and extracts readable text with cheerio.
