# Aline Reading

A daily English read-aloud practice app for kids. The child picks a topic, gets a fresh story
split into pages, reads it aloud, and every word is checked against the text. The parent gets a
summary e-mail and a progress sheet, and opens phone time by hand.

Setup guide (Hebrew): [docs/SETUP.md](docs/SETUP.md)

## How it fits together

| Part | Where it runs | What it does |
| --- | --- | --- |
| `index.html`, `css/`, `js/` | GitHub Pages, in the child's Chrome | Screens, live word highlight, Microsoft speech, practice, questions |
| `server/*.gs` | Google Apps Script, as the parent | Keys, story generation (Gemini), speech tokens, scoring, sheet, e-mail |
| Google Sheet | Parent's Drive | Settings per child, daily log, pages, hard words, errors |

The phone never sees an API key or a correct answer. Microsoft gets audio directly from the phone
with a 10-minute token that the script issues.

### Front end (`js/`)

| File | Responsibility |
| --- | --- |
| `config.js` | Script URL and tuning numbers |
| `api.js` | All calls to the script |
| `state.js` | Current session and where to resume |
| `main.js` | Screen flow |
| `speech.js` | Speech SDK, token refresh, reading a page, checking one word |
| `scoring.js` | Aligning heard words to the page (omissions, insertions, mispronunciations), live position |
| `text.js` | Word splitting (must match `server/Util.gs`) |
| `reader.js` | Page rendering and word colours |
| `practice.js` | Hard words before a page, practice after it |
| `quiz.js` | Comprehension questions |
| `tts.js` | Saying a word out loud |
| `debug.js` | Diagnostics log (always kept in memory) and panel (`&debug=1`) |
| `report.js` | Sends errors seen on the phone, with the last log lines, to the errors tab |

### Server (`server/`)

| File | Responsibility |
| --- | --- |
| `Router.gs` | Entry point, one action per request |
| `Auth.gs` | Secret code → child, rate limit |
| `Settings.gs` | Settings tab, one column per child |
| `Stories.gs` | Gemini prompt, schema, validation |
| `SpeechToken.gs` | Short-lived Microsoft token |
| `Sessions.gs` | Daily session, progress, time window |
| `Scoring.gs` | Counting, pass rules, best attempt |
| `Logging.gs` | Log, pages, hard words, errors tabs |
| `Mailer.gs` | Summary e-mail |
| `Setup.gs` | `setup`, `addChild`, `selfTest`, `testStory` |
| `Util.gs` | Helpers, tokenizer, version |

## Tests

```
npm test           # unit + server: alignment, tokenizer parity, full server flows, request cost budgets
npm run test:e2e   # system: real page in Chromium against the server code, with injected faults
                   # (Google HTML error page, lost answers, timeouts, dropped speech), then a whole day
npm run perf       # estimated Google round-trip cost per server action
```

Every server answer carries `ms` (time in the script) and `lockMs` (waiting for another request),
shown in the debug log next to the phone's own round-trip time.
