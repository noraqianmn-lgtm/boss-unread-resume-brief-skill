---
name: boss-unread-resume-brief
description: Safe BOSS Zhipin unread-greeting recruitment brief workflow with online-resume reading and Feishu output. Use when a recruiter asks Codex or WorkBuddy to open/login BOSS, work on a specific job's unread greetings, read candidates' online resumes, clarify A/B/C screening criteria from rough job requirements, generate a daily recruiting report, write Feishu document/Bitable records, or send the report link to Feishu. BOSS-side disposition actions are forbidden unless the user later confirms an exact action list.
---

# BOSS Unread Resume Brief

Use this skill to produce a read-only recruiting brief from BOSS Zhipin unread greetings. The user must provide or confirm the target position and rough job requirements before candidate evaluation.

## Safety Rules

- Treat BOSS as read-only by default.
- Do not click "不合适", send messages, request resumes, greet candidates, mark candidates, or change status.
- If the user later asks for a disposition action, ask for explicit confirmation of the exact candidate list before acting.
- If BOSS triggers risk verification, stop and ask the user to complete it. Continue only after the user says they are back on the correct page.
- Prefer reading the selected current list instead of navigating BOSS pages. Ask the user to place the page on the target position's chat list; the agent may read only unread greetings or greetings since a specified date.
- Require per-user authentication. Never ask users to share BOSS cookies, browser profiles, QR-code sessions, Feishu tokens, or another user's `config.json`.
- Treat `config.json` as a local secret file. The repository should contain `config.example.json` only.

## First-Time Setup

When the user says `boss init`, `setup`, or asks how to install:

1. Keep setup deterministic. Do not explore WorkBuddy's internal Node.js under `.workbuddy`; it is not on PATH and may have write-permission issues.
2. Check `node --version`, `boss --version`, and `lark-cli --version`.
3. If `node` is missing, stop and ask the user to install system Node.js 20 LTS manually from the MSI. On China networks, use `https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-x64.msi`. Ask them to reopen CMD/WorkBuddy after installation.
4. If CLI packages are missing, use external CMD when WorkBuddy shell is unreliable. Run:

```cmd
npm install -g @joohw/boss-cli @larksuite/cli --registry=https://registry.npmmirror.com
```

5. For a user-friendly Windows setup, ask the user to run `scripts\setup-windows.cmd` from the installed skill folder in an external CMD window. The script is English-only to avoid Windows batch encoding issues.
6. Ask this user to run `boss login` on their own machine and log into the BOSS recruiter account they are allowed to use.
7. Ask this user to run Feishu login with the current lark-cli sequence:

```cmd
lark-cli config init --new
lark-cli auth login
```

8. Copy `config.example.json` to local `config.json` and fill this user's Feishu folder/base/table/bot settings. If multiple interns write to one shared Feishu folder or Bitable, they must be granted Feishu permission to the resource; do not copy another user's token or config.

## Daily Workflow

1. Ask for the target position if absent.
2. Ask for rough job requirements if absent.
3. Before reading candidates, convert the rough requirements into A/B/C criteria:
   - A: strong match, should prioritize.
   - B: partial match or adjacent background, worth phone-screening.
   - C: clear mismatch, insufficient seniority, or missing must-have evidence.
   Read `references/screening-criteria.md` when criteria need structuring.
4. Show the criteria back to the user and ask whether to proceed. If the user says "沿用", use the last confirmed criteria in the thread.
5. Ask the user to open BOSS recruiting chat with their own logged-in recruiter session and choose the target position. Ask whether to read only unread greetings or all greetings after a date if the user has not specified this.
6. Read online resumes automatically from the current position list. Default automation uses keyboard focus/Enter/Escape, not mouse events:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --out online_resumes_<date>.json
```

Use `--browser-url http://127.0.0.1:<port>` if the default BOSS debug port is different. Use `--limit N` for a small test batch.

Range options:

- only unread greetings:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --only-unread --out online_resumes_<date>.json
```

- greetings since a date:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --since-date 2026-06-20 --out online_resumes_<date>.json
```

Use `--include-unknown-date` only if the user accepts reading rows whose greeting date cannot be parsed from the visible BOSS row.

Use `read-current-chat-online-resumes-cdp.js` as the default reader. Do not use Puppeteer, CDP mouse input, DOM `dispatchEvent`, or `.click()` for BOSS candidate selection by default. Any synthetic mouse click can trigger the BOSS SPA to route to `/web/chat/recommend`.

Do not add `--bring-to-front` or `--reset-to-top` by default. `--bring-to-front` can trigger BOSS to route to `/web/chat/recommend`, and `--reset-to-top` can force the virtual list into a loading state with zero rendered rows. Use the browser exactly where the user placed it: target position plus the desired candidate list.

7. If keyboard automation cannot open the candidate panel or online resume, run a small diagnostic scan:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --scan-only --limit 10 --out scan_test.json
```

Only use the legacy DOM-click path when the user explicitly asks for debugging and accepts the refresh risk:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --auto-method dom --limit 3 --out dom_click_test.json
```

Throttle online-resume reads:
- `--min-delay-ms 10000 --max-delay-ms 18000` between candidates;
- `--batch-pause-every 5 --batch-pause-ms 90000` for longer pauses;
- `--throttle-cooldown-ms 90000 --max-retries 1` when BOSS appears to throttle or returns a weak/empty resume.

If online resumes are frequently unread because BOSS throttles, rerun more slowly, for example:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes-cdp.js --position "<position>" --min-delay-ms 15000 --max-delay-ms 30000 --batch-pause-every 4 --batch-pause-ms 120000 --throttle-cooldown-ms 180000 --out online_resumes_<date>.json
```

When interpreting output JSON, do not treat `opened: true` as success by itself. Count the online resume as read only when `source` is `"online-resume"` or `rawDetail` / `canvasText` is present. If `source` is `"panel-or-fallback"`, the text may come from BOSS's candidate analyzer or a throttling/intercept page.

8. Inspect the JSON. If any record has `error`, retry once after a cooldown. If it still fails, include it in the report as "online resume not read; needs manual check".
9. Evaluate candidates using the confirmed criteria. Base judgments primarily on `detail`, `canvasText`, and `headerText` from the online resume output.
10. Generate a Markdown report:
   - date/time and target position;
   - confirmed A/B/C criteria;
   - total resumes read and read failures;
   - A/B/C count summary;
   - A-candidate priority list;
   - full candidate table with evidence and risk notes;
   - explicit statement that BOSS actions performed = 0.
11. Create a Feishu document and Bitable records. Read `references/feishu-output.md` for commands and JSON format.
12. Send the Feishu document link with `scripts/send-feishu-msg.js`.

## Online Resume Reading Notes

The BOSS online resume can be rendered through an iframe and canvas/wasm. The bundled script:

- connects to the existing BOSS recruiting browser through Chrome remote debugging page websocket;
- leaves BOSS native page behavior intact by default; `--stabilize` is a last-resort fallback for refresh/visibility issues;
- reads the current candidate list with `--scan-only` without selecting candidates;
- automatically selects visible candidate rows and opens online resumes with keyboard focus/Enter/Escape by default;
- supports `--only-unread`, `--since-date YYYY-MM-DD`, and `--include-unknown-date`;
- keeps `--current-open-resume` only as a fallback for one already-open resume;
- does not call `page.bringToFront()`, does not send CDP mouse input, does not send DOM mouse events, and does not reset the list to top in the default mode;
- avoids the old two-pass "scan all rows, then find them again" pattern because BOSS uses virtual scrolling and previously scanned rows may no longer exist in the DOM;
- slows down by default to avoid online-resume throttling and records throttle signals in JSON;
- marks analyzer/intercept-only content as weak fallback instead of a successful online-resume read;
- captures structured resume detail where available;
- captures canvas text where available;
- writes incremental JSON after each candidate.

If the page keeps jumping, stop automated reading. Ask the user to close the browser, run `boss login`, return to the target position unread list, then rerun `read-current-chat-online-resumes-cdp.js --scan-only --limit 3`. Do not switch to Puppeteer mouse-click based scripts.

If the script reports that BOSS is on `/web/chat/recommend`, stop and ask the user to manually switch back to the target position's unread chat list. Do not try to navigate the SPA automatically.

If rows are scanned but online resumes are not read, do not generate a chat-summary-only report. First retry with a small `--limit 3` keyboard run and slower delays. Only use `--current-open-resume --append` as a fallback for isolated candidates, and only use chat summaries as the final basis if the recruiter explicitly accepts that online resumes could not be read.

## Output Contract

Final user response must include:

- Feishu document link;
- Bitable link or statement that table writing was skipped;
- count of online resumes read;
- count of read failures;
- A/B/C counts;
- top A candidates;
- BOSS-side action count, normally `0`;
- any manual follow-up needed.
