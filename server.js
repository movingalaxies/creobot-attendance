const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// ==== CONFIG ====
const SHEET_ID = "11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs";
const TIMEZONE = "Asia/Manila";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-...";

// Google Sheets Auth
const creds = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// Slack Web API
const { WebClient } = require("@slack/web-api");
const slackWeb = new WebClient(SLACK_BOT_TOKEN);

// --- Utility functions ---
async function fetchSlackDisplayName(user_id) {
  try {
    const resp = await axios.get("https://slack.com/api/users.info", {
      params: { user: user_id },
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    if (
      resp.data &&
      resp.data.user &&
      resp.data.user.profile &&
      resp.data.user.profile.display_name &&
      resp.data.user.profile.display_name.trim() !== ""
    ) {
      return resp.data.user.profile.display_name;
    }
    if (resp.data.user && resp.data.user.real_name) {
      return resp.data.user.real_name;
    }
    return "Unknown";
  } catch (e) {
    return "Unknown";
  }
}

async function fetchSlackEmail(user_id) {
  try {
    const resp = await axios.get("https://slack.com/api/users.info", {
      params: { user: user_id },
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    if (
      resp.data &&
      resp.data.user &&
      resp.data.user.profile &&
      resp.data.user.profile.email
    ) {
      return resp.data.user.profile.email;
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function getAdminSlackIds() {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Admins!A:A"
  });
  const adminEmails = (res.data.values || []).slice(1).map(row => (row[0] || "").toLowerCase().trim());
  let adminIds = [];
  for (const email of adminEmails) {
    try {
      const userResp = await slackWeb.users.lookupByEmail({ email });
      if (userResp.ok && userResp.user && userResp.user.id) {
        adminIds.push(userResp.user.id);
      }
    } catch (e) {}
  }
  return adminIds;
}

async function ensureRequestsSheet() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = res.data.sheets.some(sheet => sheet.properties.title === "Requests");
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: "Requests" } } }]
      }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: "Requests!A1:H1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [["Type", "UserId", "Name", "Date", "Hours", "Reason", "Status", "RequestTime"]]
      }
    });
  }
}

// Upsert a request (remove existing pending from same user/date/type, then append new)
async function logRequest(type, userId, name, date, hours, reason) {
  await ensureRequestsSheet();
  // Remove old pending for same user, date, type
  const reqRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Requests!A:H"
  });
  const rows = reqRes.data.values || [];
  const idx = rows.findIndex(
    (row, i) =>
      i > 0 &&
      row[0] === type &&
      row[1] === userId &&
      row[3] === date &&
      row[6] === "PENDING"
  );
  if (idx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Requests!G${idx+1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [["OVERWRITTEN"]] }
    });
  }
  // Add the new pending request
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Requests!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        type, userId, name, date, hours, reason || "", "PENDING", moment().tz(TIMEZONE).format("MM/DD/YYYY h:mm A")
      ]]
    }
  });
}

// --- Overtime request endpoint ---
app.post("/slack/command/overtime", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);
  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 2) {
    return res.json({ response_type: "ephemeral", text: "Usage: /overtime MM/DD/YYYY hours [reason]" });
  }
  const date = args[0];
  const hours = args[1];
  const reason = args.slice(2).join(" ");
  await logRequest("overtime", user_id, name, date, hours, reason);

  const adminIds = await getAdminSlackIds();
  for (const adminId of adminIds) {
    await slackWeb.chat.postMessage({
      channel: adminId,
      text: `*Overtime Request*\nEmployee: *${name}*\nDate: *${date}*\nHours: *${hours}*\nReason: ${reason || "-"}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Overtime Request*\n*Employee:* ${name}\n*Date:* ${date}\n*Hours:* ${hours}\n*Reason:* ${reason || "-"}` } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              action_id: "approve_overtime",
              value: JSON.stringify({ userId: user_id, name, date, hours, reason })
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              action_id: "deny_overtime",
              value: JSON.stringify({ userId: user_id, name, date, hours, reason })
            }
          ]
        }
      ]
    });
  }
  res.json({ response_type: "ephemeral", text: `Your overtime request for ${hours} hour(s) on ${date} has been sent for approval.` });
});

// --- Undertime request endpoint ---
app.post("/slack/command/undertime", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);
  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 2) {
    return res.json({ response_type: "ephemeral", text: "Usage: /undertime MM/DD/YYYY hours [reason]" });
  }
  const date = args[0];
  const hours = args[1];
  const reason = args.slice(2).join(" ");
  await logRequest("undertime", user_id, name, date, hours, reason);

  const adminIds = await getAdminSlackIds();
  for (const adminId of adminIds) {
    await slackWeb.chat.postMessage({
      channel: adminId,
      text: `*Undertime Request*\nEmployee: *${name}*\nDate: *${date}*\nHours: *${hours}*\nReason: ${reason || "-"}`,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*Undertime Request*\n*Employee:* ${name}\n*Date:* ${date}\n*Hours:* ${hours}\n*Reason:* ${reason || "-"}` } },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "Approve" },
              style: "primary",
              action_id: "approve_undertime",
              value: JSON.stringify({ userId: user_id, name, date, hours, reason })
            },
            {
              type: "button",
              text: { type: "plain_text", text: "Deny" },
              style: "danger",
              action_id: "deny_undertime",
              value: JSON.stringify({ userId: user_id, name, date, hours, reason })
            }
          ]
        }
      ]
    });
  }
  res.json({ response_type: "ephemeral", text: `Your undertime request for ${hours} hour(s) on ${date} has been sent for approval.` });
});

// --- Interactive Slack actions endpoint ---
app.post("/slack/actions", express.json(), async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const val = JSON.parse(action.value);
  const type = action.action_id.includes("overtime") ? "overtime" : "undertime";
  const approved = action.action_id.startsWith("approve");

  // Find request in sheet
  const reqRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Requests!A:H"
  });
  const rows = reqRes.data.values || [];
  const idx = rows.findIndex(row =>
    row[0] === type &&
    row[1] === val.userId &&
    row[2] === val.name &&
    row[3] === val.date &&
    row[4] === val.hours &&
    row[6] === "PENDING"
  );

  if (idx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Requests!G${idx+1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[approved ? "APPROVED" : "DENIED"]] }
    });
    // If denied, ask for reason (if not already set)
    let denyReason = "";
    if (!approved && payload.actions[0].value && payload.actions[0].value.reason) {
      denyReason = payload.actions[0].value.reason;
    }
    // If approved, update attendance (OT=F, UT=G)
    if (approved) {
      const year = moment(val.date, "MM/DD/YYYY").year().toString();
      const attRes = await sheets.spreadsheets.values.get({
        spreadsheetId: SHEET_ID,
        range: `${year}!A:G`
      });
      const attRows = attRes.data.values || [];
      const attIdx = attRows.findIndex(
        (row, idx) =>
          idx > 0 &&
          row[0] && row[0].toLowerCase() === val.name.toLowerCase() &&
          row[1] && row[1] === val.date
      );
      if (attIdx > 0) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${year}!${type === "overtime" ? "F" : "G"}${attIdx+1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[val.hours]] }
        });
      }
    }

    // Notify employee
    await slackWeb.chat.postMessage({
      channel: val.userId,
      text: approved
        ? `✅ Your ${type} request for ${val.hours} hour(s) on ${val.date} has been *approved* by an admin.`
        : `❌ Your ${type} request for ${val.hours} hour(s) on ${val.date} has been *denied* by an admin.${denyReason ? "\nReason: " + denyReason : ""}`
    });
    res.json({ text: approved ? "Approved ✅" : "Denied ❌", replace_original: true });
  } else {
    res.json({ text: "This request was already processed." });
  }
});

app.get("/", (req, res) => {
  res.send("Attendance Bot running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot running on port ${PORT}`);
});
