# BOSS Unread Resume Brief Skill

This repository packages a Codex/WorkBuddy skill for safe BOSS Zhipin recruiting briefs.

It helps an AI agent:

- open or reuse the BOSS recruiting login flow;
- work on the position and unread-greetings list that the recruiter has selected;
- safely read each candidate's "online resume" without sending messages or changing candidate status;
- clarify A/B/C screening criteria before evaluation;
- generate a Feishu daily recruiting document and optional Bitable records;
- send the final report link through a Feishu bot.

## Safety Boundary

The skill is read-only by default on BOSS. It must not click "not suitable", send messages, request resumes, greet candidates, or change candidate status unless the recruiter explicitly confirms the exact action list in a later step.

## Per-User Accounts And Tokens

Each intern must use their own local BOSS and Feishu authentication.

- Do not share BOSS cookies, browser profiles, QR-code sessions, or recruiter account sessions.
- Do not commit or share `config.json`; only `config.example.json` belongs in GitHub.
- Each user runs `boss login` on their own computer and logs into the BOSS recruiter account they are allowed to use.
- Each user runs `lark-cli config init --new` and `lark-cli auth login` on their own computer, producing their own Feishu token.
- Each user fills their own local `config.json` with the Feishu folder, Bitable, bot, and user settings they are allowed to write to.
- If several interns should write into the same recruiting Feishu folder or Bitable, grant them Feishu permissions to that resource; do not copy another person's token.

## Install In Codex

In Codex, ask:

```text
Use $skill-installer to install https://github.com/noraqianmn-lgtm/boss-unread-resume-brief-skill/tree/main/skills/boss-unread-resume-brief
```

Or run the installer script directly:

```powershell
python "$env:USERPROFILE\.codex\skills\.system\skill-installer\scripts\install-skill-from-github.py" --url https://github.com/noraqianmn-lgtm/boss-unread-resume-brief-skill/tree/main/skills/boss-unread-resume-brief
```

Restart Codex after installation so the new skill is discovered.

## Install In WorkBuddy

WorkBuddy uses the local machine's session state: local skills, local browser login, local BOSS recruiter session, and local Feishu token. Install the skill on each intern's computer, then restart WorkBuddy or start a new WorkBuddy conversation so the skill list reloads.

WorkBuddy can have a bundled Node.js, but this skill should use system Node.js from PATH. Do not install npm packages inside `%USERPROFILE%\.workbuddy`; that path is versioned and can have write-permission issues.

Preferred WorkBuddy install prompt:

```text
Use $skill-installer to install https://github.com/noraqianmn-lgtm/boss-unread-resume-brief-skill/tree/main/skills/boss-unread-resume-brief
```

If WorkBuddy cannot invoke `$skill-installer`, install manually in PowerShell:

```powershell
$skillUrl = "https://github.com/noraqianmn-lgtm/boss-unread-resume-brief-skill/archive/refs/heads/main.zip"
$zip = "$env:TEMP\boss-unread-resume-brief-skill.zip"
$extract = "$env:TEMP\boss-unread-resume-brief-skill"
$dest = "$env:USERPROFILE\.codex\skills\boss-unread-resume-brief"
$skillsDir = "$env:USERPROFILE\.codex\skills"
Remove-Item $zip -Force -ErrorAction SilentlyContinue
Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
curl.exe -L $skillUrl -o $zip
Expand-Archive $zip -DestinationPath $extract
Copy-Item "$extract\boss-unread-resume-brief-skill-main\skills\boss-unread-resume-brief" $dest -Recurse
```

After manual installation, restart WorkBuddy or open a new WorkBuddy chat. Then invoke:

```text
Use $boss-unread-resume-brief.
```

WorkBuddy run notes:

- Keep the BOSS browser already on the target position's candidate/chat list before asking WorkBuddy to read resumes. Use `--only-unread` when the user wants only unread greetings.
- Do not ask WorkBuddy to bring BOSS to the front, click candidates with mouse automation, dispatch DOM clicks, or navigate to the position automatically.
- Use `read-current-chat-online-resumes-cdp.js`, the raw CDP reader. Default auto-read mode uses keyboard focus/Enter/Escape, supports `--only-unread` and `--since-date`, and avoids mouse events.
- If WorkBuddy reports that the skill was installed but still cannot see it, restart WorkBuddy rather than continuing in the same chat.

## First-Time Setup

First check whether system Node.js is available:

```cmd
node --version
```

If `node` is not found, install Node.js manually:

1. Open `https://npmmirror.com/mirrors/node/v20.18.0/node-v20.18.0-x64.msi`
2. Download the MSI.
3. Double-click it and keep the default settings: Next, Next, Install, Finish.
4. Open a new CMD window. Old terminal windows will not see the new PATH.

Then install command-line dependencies:

```cmd
npm install -g @joohw/boss-cli @larksuite/cli --registry=https://registry.npmmirror.com
```

If WorkBuddy's PowerShell tool is broken or returns garbled output, do not keep debugging inside WorkBuddy. Ask the user to open external CMD and run the same commands there.

The installed skill also includes an English-only Windows helper script:

```cmd
<installed-skill-path>\scripts\setup-windows.cmd
```

Then authenticate:

```cmd
boss login
lark-cli config init --new
lark-cli auth login
```

These commands must be run by each intern on their own machine. Copy `config.example.json` to `config.json` inside the installed skill folder and fill in that user's Feishu folder/base/table/bot settings. Keep `config.json` local and private.

## BOSS Page Keeps Refreshing

If BOSS keeps refreshing or the script says it cannot find the "online resume" button:

1. Stop the running script.
2. Close the BOSS browser opened by `boss login`.
3. Run `boss login` again and finish login/risk verification.
4. In BOSS, manually switch to the target position and the unread-greetings list.
5. Ask the agent to scan a small test batch first. Do not add `--stabilize` on the first retry:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --scan-only --limit 3 --out test_online_resumes.json
```

Only add `--stabilize` as a last-resort fallback when the page still refreshes because the browser loses focus. The default mode avoids patching BOSS page visibility/reload behavior so candidate-list rendering is less likely to break.

Do not add `--bring-to-front` by default. On some BOSS sessions, bringing the page to front triggers the SPA route to jump to `/web/chat/recommend`.

Do not add `--reset-to-top` by default. BOSS uses a virtual scrolling list; forcing the list back to the top can leave the DOM in a temporary loading state with zero candidate rows. Put the page on the target position's unread list manually, then let the script start from the currently visible rows.

Do not downgrade to chat-summary-only reporting unless the recruiter explicitly accepts that online resumes could not be read.

The recommended reader is `read-current-chat-online-resumes-cdp.js`. Its default auto-read mode does not use CDP mouse input, DOM `dispatchEvent`, `.click()`, bring the page to front, or reset the list position. It focuses visible candidate rows and online-resume buttons, then uses keyboard Enter/Escape.

Auto-read the current position:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --out online_resumes.json
```

Only unread greetings:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --only-unread --out online_resumes.json
```

Greetings since a date:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --since-date 2026-06-20 --out online_resumes.json
```

Use `--include-unknown-date` only if the recruiter accepts reading rows whose greeting date cannot be parsed from the visible BOSS row.

Diagnostic scan without opening resumes:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --scan-only --limit 10 --out scan_test.json
```

The reader is intentionally slow to avoid BOSS throttling. Defaults:

- wait 10-18 seconds after each candidate;
- pause 90-120 seconds after every 5 candidates;
- if BOSS shows signs like "操作频繁", "稍后再试", "安全验证", or only returns a very short resume, cool down and retry once.

For a safer full run, use:

```powershell
node <installed-skill-path>\scripts\read-current-chat-online-resumes-cdp.js --position "<position name>" --min-delay-ms 15000 --max-delay-ms 30000 --batch-pause-every 4 --batch-pause-ms 120000 --throttle-cooldown-ms 180000 --out online_resumes.json
```

In the output JSON, `opened: true` only means the resume button was clicked. Treat a candidate as successfully read only when `source` is `"online-resume"` or `rawDetail` / `canvasText` is present. If `source` is `"panel-or-fallback"`, the content may be BOSS's candidate analyzer or a throttling page, not the full online resume.

## Typical Prompt

```text
Use $boss-unread-resume-brief.
Position: R&D Director La Forge
Only read unread greetings. I have already opened BOSS recruiting chat on this position's unread list.
Here are the rough job requirements: ...
Please first help me clarify A/B/C screening criteria, then automatically read the current position's online resumes and generate a Feishu daily brief. Do not take any BOSS disposition actions.
```

```text
Use $boss-unread-resume-brief.
Position: 活动支持实习生
Read greetings since 2026-06-20.
Here are the rough job requirements: ...
Please clarify A/B/C criteria, then automatically read online resumes and generate a Feishu daily brief.
```

## Repository Layout

```text
skills/boss-unread-resume-brief/
  SKILL.md
  agents/openai.yaml
  config.example.json
  scripts/
    read-current-chat-online-resumes-cdp.js
    read-current-chat-online-resumes.js
    setup-windows.cmd
    send-feishu-msg.js
  references/
    screening-criteria.md
    feishu-output.md
```
