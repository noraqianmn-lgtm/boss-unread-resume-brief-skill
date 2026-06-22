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
- Prefer reading the selected current list instead of navigating BOSS pages. Ask the user to place the page on the target position and unread-greetings list.
- Require per-user authentication. Never ask users to share BOSS cookies, browser profiles, QR-code sessions, Feishu tokens, or another user's `config.json`.
- Treat `config.json` as a local secret file. The repository should contain `config.example.json` only.

## First-Time Setup

When the user says `boss init`, `setup`, or asks how to install:

1. Check `node --version`, `boss --version`, and `lark-cli --version`.
2. If missing, tell the user to install:
   - `npm install -g @joohw/boss-cli`
   - `npm install -g @larksuite/cli`
3. If PowerShell blocks npm scripts, tell the user to run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.
4. Ask this user to run `boss login` on their own machine and log into the BOSS recruiter account they are allowed to use.
5. Ask this user to run `lark-cli auth login --as user` on their own machine if Feishu is not authenticated.
6. Copy `config.example.json` to local `config.json` and fill this user's Feishu folder/base/table/bot settings. If multiple interns write to one shared Feishu folder or Bitable, they must be granted Feishu permission to the resource; do not copy another user's token or config.

## Daily Workflow

1. Ask for the target position if absent.
2. Ask for rough job requirements if absent.
3. Before reading candidates, convert the rough requirements into A/B/C criteria:
   - A: strong match, should prioritize.
   - B: partial match or adjacent background, worth phone-screening.
   - C: clear mismatch, insufficient seniority, or missing must-have evidence.
   Read `references/screening-criteria.md` when criteria need structuring.
4. Show the criteria back to the user and ask whether to proceed. If the user says "沿用", use the last confirmed criteria in the thread.
5. Ask the user to open BOSS recruiting chat with their own logged-in recruiter session, choose the target position, and show the unread-greetings list. If login is needed, run `boss login` or ask the user to complete browser login on their own account.
6. Read online resumes with:

```powershell
node <skill-dir>\scripts\read-current-chat-online-resumes.js --position "<position>" --out online_resumes_<date>.json
```

Use `--browser-url http://127.0.0.1:<port>` if the default BOSS debug port is different. Use `--limit N` for a small test batch. Use `--only-unread` only if the BOSS row text exposes unread markers; otherwise rely on the user-selected unread list.

7. Inspect the JSON. If any record has `error`, retry once. If it still fails, include it in the report as "online resume not read; needs manual check".
8. Evaluate candidates using the confirmed criteria. Base judgments primarily on `detail`, `canvasText`, and `headerText` from the online resume output.
9. Generate a Markdown report:
   - date/time and target position;
   - confirmed A/B/C criteria;
   - total resumes read and read failures;
   - A/B/C count summary;
   - A-candidate priority list;
   - full candidate table with evidence and risk notes;
   - explicit statement that BOSS actions performed = 0.
10. Create a Feishu document and Bitable records. Read `references/feishu-output.md` for commands and JSON format.
11. Send the Feishu document link with `scripts/send-feishu-msg.js`.

## Online Resume Reading Notes

The BOSS online resume can be rendered through an iframe and canvas/wasm. The bundled script:

- connects to the existing BOSS recruiting browser through Chrome remote debugging;
- stabilizes the chat page against refresh/visibility navigation side effects;
- scans the current candidate list without navigating to recommendations;
- opens each candidate's "在线简历";
- captures structured resume detail where available;
- captures canvas text where available;
- writes incremental JSON after each candidate.

If the page keeps jumping, do not keep clicking manually. Ask the user to close the browser, run `boss login`, return to the target position unread list, then rerun the script with a small `--limit 3` test. The script no longer patches BOSS page visibility/reload behavior by default. Add `--stabilize` only as a last-resort fallback if the page still refreshes because the browser loses focus.

If rows are scanned but every candidate reports `online resume button not found`, do not immediately generate a chat-summary-only report. This usually means the candidate row was not selected and the right-side detail panel did not load. Ask the user to refresh/reopen BOSS, return to the target position unread list, update/reinstall this skill if needed, and rerun a `--limit 3` test. Only use chat summaries as the final basis if the recruiter explicitly accepts that online resumes could not be read.

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
