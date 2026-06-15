#!/usr/bin/env node

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const CONFIG_PATH = path.join(__dirname, "..", "config.json");

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.json not found. Copy config.example.json to config.json first: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function getLarkCliBin() {
  const candidates = [
    path.join(process.env.APPDATA || "", "npm", "node_modules", "@larksuite", "cli", "bin", "lark-cli.exe"),
    path.join(
      process.env.USERPROFILE || "",
      "AppData",
      "Roaming",
      "npm",
      "node_modules",
      "@larksuite",
      "cli",
      "bin",
      "lark-cli.exe"
    ),
    "lark-cli",
  ];
  for (const candidate of candidates) {
    if (candidate === "lark-cli" || fs.existsSync(candidate)) return candidate;
  }
  return "lark-cli";
}

function sendText(text, options = {}) {
  const config = loadConfig();
  const userId = options.userId || config.feishu.user_open_id;
  const chatId = options.chatId || "";
  const identity = options.identity || "bot";

  const args = ["im", "+messages-send", "--as", identity];
  if (chatId) args.push("--chat-id", chatId);
  else args.push("--user-id", userId);
  args.push("--text", text);

  const result = execFileSync(getLarkCliBin(), args, { encoding: "utf8" });
  return JSON.parse(result);
}

function sendBrief(data, options = {}) {
  const config = loadConfig();
  const byGrade = data.byGrade || {};
  const priority = data.priorityCandidates || data.priorityList || [];
  const baseUrl = data.baseUrl || (config.feishu.base_token ? `https://www.feishu.cn/base/${config.feishu.base_token}` : "");

  const lines = [];
  lines.push(data.title || "BOSS recruiting daily brief generated");
  lines.push("");
  lines.push(`Date: ${data.date || ""}`);
  if (data.position) lines.push(`Position: ${data.position}`);
  lines.push(`Online resumes read: ${data.total ?? 0}`);
  lines.push(`A/B/C: A ${byGrade.A || 0}, B ${byGrade.B || 0}, C ${byGrade.C || 0}`);
  lines.push(`BOSS-side actions performed: ${data.bossSideActionsPerformed ?? 0}`);
  lines.push("");
  lines.push("Priority candidates:");
  if (priority.length) {
    priority.forEach((item, idx) => {
      lines.push(`${idx + 1}. ${item.name} | ${item.position || data.position || ""} | ${item.highlight || ""}`);
    });
  } else {
    lines.push("None");
  }
  lines.push("");
  if (data.docUrl) lines.push(`Document: ${data.docUrl}`);
  if (baseUrl) lines.push(`Bitable: ${baseUrl}`);
  if (data.note) lines.push(`Note: ${data.note}`);

  return sendText(lines.join("\n"), options);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const briefIndex = args.indexOf("--brief");
  if (briefIndex >= 0 && args[briefIndex + 1]) {
    const data = JSON.parse(fs.readFileSync(path.resolve(args[briefIndex + 1]), "utf8"));
    console.log(JSON.stringify(sendBrief(data), null, 2));
  } else {
    console.error("Usage: node scripts/send-feishu-msg.js --brief brief_data.json");
    process.exit(1);
  }
}

module.exports = { sendText, sendBrief };

