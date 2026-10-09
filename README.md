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
| `Bridge.gs` | For the new server: settings, rows and mails, behind a secret |
| `StoryTexts.gs` | Readable copy of each story the new server writes (tab "טקסט סיפורים") |
| `Setup.gs` | `setup`, `addChild`, `selfTest`, `testStory` |
| `Util.gs` | Helpers, tokenizer, version |

### New server (`worker/`, Cloudflare)

The same actions and answers as `server/Router.gs`, so the page works with either server
(`js/config.js`: `NEW_SERVER_URL`, `DEFAULT_SERVER`; one phone switches with `?server=new|old`).
State lives in Cloudflare D1 (SQLite); the sheet stays the source of settings and the place of
the parent's log, hard words, errors and mail, reached through `server/Bridge.gs` (secret-protected)
in the background, with retries. Setup guide (Hebrew): [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md).

| File | Responsibility |
| --- | --- |
| `index.js` | Entry point, CORS, scheduled job |
| `router.js` | One action per request |
| `auth.js` | Code → child, rate limit |
| `settings.js` | Settings from the sheet, cached 10 minutes, last known if the sheet is down |
| `store.js` | D1 tables, sessions with an optimistic lock, small cached values |
| `sessions.js` | Daily session, time window, what the phone sees |
| `stories.js` | Gemini prompt, model fallback, validation |
| `speech.js` | Microsoft token |
| `scoring.js` | Counting, pass rules, best attempt |
| `reports.js` | Rows and mails waiting for the sheet, sent in order with retries |
| `bridge.js` | Calls to `server/Bridge.gs` |

`worker/dist/worker.js` is the single file to paste into Cloudflare's editor
(`npm run build:worker`; a test fails if it is out of date).

## Tests

```
npm test           # unit + server: alignment, tokenizer parity, full server flows, request cost budgets
npm run test:e2e   # system: real page in Chromium, with injected faults (Google HTML error page,
                   # lost answers, timeouts, dropped speech) and a whole day — against both servers
npm run perf       # estimated Google round-trip cost per server action
```

Every server answer carries `ms` (time in the script) and `lockMs` (waiting for another request),
shown in the debug log next to the phone's own round-trip time.
