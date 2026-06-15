# Feishu Output

Use this reference when creating the Feishu document, writing Bitable records, or sending the report message.

## Create Document

Write the report to a local Markdown file first. Then run from the directory containing the file:

```powershell
lark-cli docs +create --title "<title>" --folder-token "<folder_token>" --markdown "@report.md" --as user
```

Use relative `@report.md` paths. `lark-cli` rejects absolute file paths for some commands.

## Append or Update Document

For appending chunks:

```powershell
lark-cli docs +update --doc "<doc_id>" --mode append --markdown "@append.md" --as user
```

## Bitable Records

Use lark-cli simplified JSON:

```json
{
  "fields": ["Candidate", "Position", "Grade", "Reason", "Status", "Resume summary", "Report date"],
  "rows": [
    ["Name", "Position", "A", "Reason", "To contact", "Summary", "2026-06-15"]
  ]
}
```

Write records with:

```powershell
lark-cli base +record-batch-create --base-token "<base_token>" --table-id "<table_id>" --json "@records.json" --as user
```

Again, use a relative `@records.json` path from the current directory.

## Bot Message

Use the bundled script rather than composing multiline text through PowerShell:

```powershell
node <skill-dir>\scripts\send-feishu-msg.js --brief brief_data.json
```

`brief_data.json` should contain:

```json
{
  "title": "BOSS recruiting daily brief",
  "date": "2026-06-15",
  "position": "Target position",
  "total": 20,
  "byGrade": { "A": 3, "B": 5, "C": 12 },
  "priorityCandidates": [
    { "name": "Candidate", "position": "Target position", "highlight": "Why priority" }
  ],
  "docUrl": "https://www.feishu.cn/docx/...",
  "baseUrl": "https://www.feishu.cn/base/...",
  "note": "BOSS-side actions performed: 0"
}
```

