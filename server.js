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

// Helper Functions
const { WebClient } = require("@slack/web-api");
const slackWeb = new WebClient(SLACK_BOT_TOKEN);

// Helper to get admin Slack user IDs
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

// Helper to ensure Requests sheet exists
async function ensureRequestsSheet() {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = res.data.sheets.some(
    (sheet) => sheet.properties.title === "Requests"
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: "Requests" } } }]
      }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Requests!A1:H1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          "Type", "UserId", "Name", "Date", "Hours", "Reason", "Status", "RequestTime"
        ]]
      }
    });
  }
}

// Helper to log a request
async function logRequest(type, userId, name, date, hours, reason) {
  await ensureRequestsSheet();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: "Requests!A:H",
    valueInputOption: "USER_ENTERED",
    requestBody: {
      values: [[
        type, userId, name, date, hours, reason, "PENDING", moment().tz(TIMEZONE).format("MM/DD/YYYY h:mm A")
      ]]
    }
  });
}

// ==== UTILITIES ====

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
      resp.data.user.profile.display_name
    ) {
      return (
        resp.data.user.profile.display_name ||
        resp.data.user.real_name ||
        resp.data.user.name ||
        "Unknown"
      );
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
    console.error("Error fetching email:", e);
    return null;
  }
}

async function isAdmin(email) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: "Admins!A:A"
    });
    const adminEmails = (res.data.values || [])
      .slice(1)
      .map(row => (row[0] || "").toLowerCase().trim());
    return adminEmails.includes((email || "").toLowerCase().trim());
  } catch (err) {
    console.error("Error checking admin:", err);
    return false;
  }
}

function getCustomTime(text) {
  if (!text) return null;
  let inputTime = text.trim();
  if (/^\d{1,2}:\d{2} ?(AM|PM)?$/i.test(inputTime)) {
    if (!inputTime.match(/AM|PM/i)) {
      const hour = parseInt(inputTime.split(":")[0]);
      inputTime += hour < 12 ? " AM" : " PM";
    }
    return moment(inputTime, "h:mm A").format("h:mm A");
  }
  return null;
}

function calculateTotalHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return "";
  const inTime = moment(clockIn, "hh:mm A");
  const outTime = moment(clockOut, "hh:mm A");
  if (!inTime.isValid() || !outTime.isValid()) return "";
  let breakMinutes = 0;
  const noon = moment("12:00 PM", "hh:mm A");
  const afterLunch = moment("1:00 PM", "hh:mm A");
  if (inTime.isBefore(afterLunch) && outTime.isAfter(noon)) {
    breakMinutes = 60;
  }
  let duration = outTime.diff(inTime, "minutes") - breakMinutes;
  if (duration < 0) duration = 0;
  const hours = Math.floor(duration / 60);
  const minutes = duration % 60;
  return `${hours.toString().padStart(2,"0")}:${minutes.toString().padStart(2,"0")}`;
}

function parseDateRange(arg) {
  if (!arg) return { start: null, end: null };
  const parts = arg.split("-");
  if (parts.length === 2) {
    return {
      start: moment(parts[0], "MM/DD/YYYY"),
      end: moment(parts[1], "MM/DD/YYYY")
    };
  } else {
    const date = moment(arg, "MM/DD/YYYY");
    return { start: date, end: date };
  }
}

async function ensureSheetExists(sheetName) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = res.data.sheets.some(
    (sheet) => sheet.properties.title === sheetName
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [
          { addSheet: { properties: { title: sheetName } } }
        ]
      }
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A1:G1`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[
          "Name of Employee",
          "Date",
          "Clock In",
          "Clock Out",
          "Total Hours",
          "Overtime Hours",
          "Undertime Hours"
        ]]
      }
    });
  }
}

async function upsertAttendance({ name, date, clockIn, clockOut }) {
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:G`
  });
  const rows = res.data.values || [];
  const rowIdx = rows.findIndex(
    (row, idx) =>
      idx > 0 &&
      row[0] && row[0].toLowerCase() === name.toLowerCase() &&
      row[1] && row[1] === date
  );
  let totalHours = "";
  if (clockIn && clockOut) totalHours = calculateTotalHours(clockIn, clockOut);

  if (rowIdx > 0) {
    const valuesToUpdate = [
      clockIn || rows[rowIdx][2] || "",
      clockOut || rows[rowIdx][3] || "",
      totalHours || rows[rowIdx][4] || "",
      rows[rowIdx][5] || "",
      rows[rowIdx][6] || ""
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${year}!C${rowIdx+1}:G${rowIdx+1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [valuesToUpdate]
      }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${year}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[name, date, clockIn || "", clockOut || "", totalHours, "", ""]]
      }
    });
  }
}

async function getAttendance(name, startDate, endDate) {
  let results = [];
  let cur = moment(startDate);
  while (cur.isSameOrBefore(endDate, "day")) {
    const year = cur.year().toString();
    await ensureSheetExists(year);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${year}!A:G`
    });
    const rows = res.data.values || [];
    results = results.concat(
      rows.filter((row, idx) =>
        idx > 0 &&
        row[0] && row[0].toLowerCase() === name.toLowerCase() &&
        row[1] && row[1] === cur.format("MM/DD/YYYY")
      )
    );
    cur.add(1, "day");
  }
  return results;
}

// ==== SLACK COMMAND ENDPOINTS ====

// /clockin
app.post("/slack/command/clockin", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  let clockIn = moment().tz(TIMEZONE).format("h:mm A");
  if (req.body.text) {
    const custom = getCustomTime(req.body.text);
    if (custom) clockIn = custom;
    else return res.json({ response_type: "ephemeral", text: "Please enter time as `h:mm AM/PM` (example: 7:30 AM)" });
  }
  const name = await fetchSlackDisplayName(user_id);
  await upsertAttendance({ name, date, clockIn, clockOut: null });
  res.json({
    response_type: "ephemeral",
    text: `✅ Clocked in as *${name}* at *${clockIn}* on ${date}.`
  });
});

// /clockout
app.post("/slack/command/clockout", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  let clockOut = moment().tz(TIMEZONE).format("h:mm A");
  if (req.body.text) {
    const custom = getCustomTime(req.body.text);
    if (custom) clockOut = custom;
    else return res.json({ response_type: "ephemeral", text: "Please enter time as `h:mm AM/PM` (example: 5:00 PM)" });
  }
  const name = await fetchSlackDisplayName(user_id);
  await upsertAttendance({ name, date, clockIn: null, clockOut });
  res.json({
    response_type: "ephemeral",
    text: `✅ Clocked out as *${name}* at *${clockOut}* on ${date}.`
  });
});

// /myattendance [date or range]
app.post("/slack/command/myattendance", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);
  let start, end;
  if (req.body.text && req.body.text.trim()) {
    const { start: s, end: e } = parseDateRange(req.body.text.trim());
    start = s;
    end = e;
  } else {
    start = end = moment().tz(TIMEZONE);
  }
  if (!start || !end) {
    return res.json({ response_type: "ephemeral", text: "Please provide a date or range (MM/DD/YYYY or MM/DD/YYYY-MM/DD/YYYY)" });
  }
  const rows = await getAttendance(name, start, end);
  if (rows.length === 0) {
    return res.json({ response_type: "ephemeral", text: "No attendance records found for that period." });
  }
  let table = "```";
  table += "Date       | In      | Out     | Total   | OT    | UT\n";
  table += "-----------|---------|---------|---------|-------|-------\n";
  rows.forEach(r => {
    table += (r[1] || "").padEnd(11) + "| ";
    table += (r[2] || "").padEnd(8) + "| ";
    table += (r[3] || "").padEnd(8) + "| ";
    table += (r[4] || "").padEnd(8) + "| ";
    table += (r[5] || "").padEnd(5) + "| ";
    table += (r[6] || "").padEnd(5) + "\n";
  });
  table += "```";
  res.json({ response_type: "ephemeral", text: table });
});

// /viewattendance — Show everyone's attendance for today (in_channel)
app.post("/slack/command/viewattendance", async (req, res) => {
  const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const year = moment().tz(TIMEZONE).year().toString();
  try {
    await ensureSheetExists(year);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${year}!A:G`
    });
    const rows = result.data.values || [];
    const todayRows = rows.filter((row, idx) => idx > 0 && row[1] === today);

    if (todayRows.length === 0) {
      return res.json({
        response_type: "in_channel",
        text: `No attendance records for today (${today}).`
      });
    }

    // Compact, aligned table
    let table = "```";
    table += "Name         | In      | Out    | Total | OT | UT\n";
    table += "-------------|---------|--------|-------|----|---\n";
    todayRows.forEach(row => {
      table += (row[0] || "").padEnd(12) + " | ";
      table += (row[2] || "").padEnd(6) + " | ";
      table += (row[3] || "").padEnd(6) + " | ";
      table += (row[4] || "").padEnd(5) + " | ";
      table += (row[5] || "").padEnd(2) + " | ";
      table += (row[6] || "").padEnd(2) + "\n";
    });
    table += "```";

    res.json({
      response_type: "in_channel", // Show to everyone!
      text: `*Attendance for ${today}:*\n${table}`
    });
  } catch (err) {
    console.error("viewattendance error:", err);
    return res.json({
      response_type: "ephemeral",
      text: "Error fetching attendance data. Please check that your Google Sheet has a tab for this year, is shared with your service account, and your Sheet ID is correct."
    });
  }
});

// /addovertime [employee name] MM/DD/YYYY hours [reason]
app.post("/slack/command/addovertime", async (req, res) => {
  const user_id = req.body.user_id;
  const email = await fetchSlackEmail(user_id);
  if (!await isAdmin(email)) {
    return res.json({
      response_type: "ephemeral",
      text: "Only admins can use this command."
    });
  }
  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 3) {
    return res.json({
      response_type: "ephemeral",
      text: "Format: /addovertime [employee name] MM/DD/YYYY hours [reason]\nExample: /addovertime Lovelle 05/29/2024 2 End-of-month reporting"
    });
  }
  const [empName, date, hours, ...reasonArr] = args;
  const reason = reasonArr.join(" ") || "";
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);

  // Find the row in the sheet
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:G`
  });
  const rows = result.data.values || [];
  const rowIdx = rows.findIndex(
    (row, idx) =>
      idx > 0 &&
      row[0] && row[0].toLowerCase() === empName.toLowerCase() &&
      row[1] && row[1] === date
  );

  if (rowIdx > 0) {
    // Update overtime hours and reason
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${year}!F${rowIdx+1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[hours]] }
    });
    return res.json({
      response_type: "in_channel",
      text: `Overtime of ${hours} hour(s) added for ${empName} on ${date}. ${reason ? "Reason: " + reason : ""}`
    });
  } else {
    return res.json({
      response_type: "ephemeral",
      text: `No attendance record found for ${empName} on ${date}. Please ensure the employee has clocked in/out first.`
    });
  }
});

// /addundertime [employee name] MM/DD/YYYY hours [reason]
app.post("/slack/command/addundertime", async (req, res) => {
  const user_id = req.body.user_id;
  const email = await fetchSlackEmail(user_id);
  if (!await isAdmin(email)) {
    return res.json({
      response_type: "ephemeral",
      text: "Only admins can use this command."
    });
  }
  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 3) {
    return res.json({
      response_type: "ephemeral",
      text: "Format: /addundertime [employee name] MM/DD/YYYY hours [reason]\nExample: /addundertime Lovelle 05/29/2024 1 Left early for appointment"
    });
  }
  const [empName, date, hours, ...reasonArr] = args;
  const reason = reasonArr.join(" ") || "";
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);

  // Find the row in the sheet
  const result = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:G`
  });
  const rows = result.data.values || [];
  const rowIdx = rows.findIndex(
    (row, idx) =>
      idx > 0 &&
      row[0] && row[0].toLowerCase() === empName.toLowerCase() &&
      row[1] && row[1] === date
  );

  if (rowIdx > 0) {
    // Update undertime hours and reason
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${year}!G${rowIdx+1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[hours]] }
    });
    return res.json({
      response_type: "in_channel",
      text: `Undertime of ${hours} hour(s) added for ${empName} on ${date}. ${reason ? "Reason: " + reason : ""}`
    });
  } else {
    return res.json({
      response_type: "ephemeral",
      text: `No attendance record found for ${empName} on ${date}. Please ensure the employee has clocked in/out first.`
    });
  }
});

// /overtime - command for employees
app.post("/slack/command/overtime", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);

  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 3) {
    return res.json({ response_type: "ephemeral", text: "Usage: /overtime MM/DD/YYYY hours reason" });
  }
  const [date, hours, ...reasonArr] = args;
  const reason = reasonArr.join(" ");
  await logRequest("overtime", user_id, name, date, hours, reason);

  // DM all admins
  const adminIds = await getAdminSlackIds();
  for (const adminId of adminIds) {
    await slackWeb.chat.postMessage({
      channel: adminId,
      text: `*Overtime Request*\nEmployee: *${name}*\nDate: *${date}*\nHours: *${hours}*\nReason: ${reason || "-"}\n`,
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

  res.json({
    response_type: "ephemeral",
    text: `Your overtime request for ${hours} hours on ${date} has been sent for approval.`
  });
});

// /undertime - command for employees
app.post("/slack/command/undertime", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);

  const args = req.body.text.trim().split(/\s+/);
  if (args.length < 3) {
    return res.json({ response_type: "ephemeral", text: "Usage: /undertime MM/DD/YYYY hours reason" });
  }
  const [date, hours, ...reasonArr] = args;
  const reason = reasonArr.join(" ");
  await logRequest("undertime", user_id, name, date, hours, reason);

  // DM all admins
  const adminIds = await getAdminSlackIds();
  for (const adminId of adminIds) {
    await slackWeb.chat.postMessage({
      channel: adminId,
      text: `*Undertime Request*\nEmployee: *${name}*\nDate: *${date}*\nHours: *${hours}*\nReason: ${reason || "-"}\n`,
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

  res.json({
    response_type: "ephemeral",
    text: `Your undertime request for ${hours} hours on ${date} has been sent for approval.`
  });
});

// slack interactive actions handler
app.post("/slack/actions", express.json(), async (req, res) => {
  const payload = JSON.parse(req.body.payload);
  const action = payload.actions[0];
  const val = JSON.parse(action.value);
  const type = action.action_id.includes("overtime") ? "overtime" : "undertime";
  const approved = action.action_id.startsWith("approve");

  // Update Requests sheet to APPROVED/DENIED
  const requestsRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: "Requests!A:H"
  });
  const rows = requestsRes.data.values || [];
  const rowIdx = rows.findIndex(row =>
    row[0] === type &&
    row[1] === val.userId &&
    row[2] === val.name &&
    row[3] === val.date &&
    row[4] === val.hours &&
    row[5] === val.reason &&
    row[6] === "PENDING"
  );
  if (rowIdx > 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `Requests!G${rowIdx + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[approved ? "APPROVED" : "DENIED"]] }
    });

    // If approved, update attendance sheet
    if (approved) {
      const year = moment(val.date, "MM/DD/YYYY").year().toString();
      await ensureSheetExists(year);
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
        // Overtime is column F, Undertime is column G
        await sheets.spreadsheets.values.update({
          spreadsheetId: SHEET_ID,
          range: `${year}!${type === "overtime" ? "F" : "G"}${attIdx + 1}`,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[val.hours]] }
        });
      }
    }

    // Notify employee via DM
    await slackWeb.chat.postMessage({
      channel: val.userId,
      text: approved
        ? `✅ Your ${type} request for ${val.hours} hours on ${val.date} has been *approved* by an admin.`
        : `❌ Your ${type} request for ${val.hours} hours on ${val.date} has been *denied* by an admin.`
    });

    // Notify admin in the thread
    res.json({
      text: approved ? "Approved ✅" : "Denied ❌",
      replace_original: true
    });
  } else {
    res.json({ text: "This request was already processed." });
  }
});

// /help (shows all commands for admin, basic for employee)
app.post("/slack/command/help", async (req, res) => {
  const user_id = req.body.user_id;
  let email = "";
  let admin = false;

  try {
    email = await fetchSlackEmail(user_id);
    admin = await isAdmin(email);
    console.log("HELP command user:", email, "ADMIN?", admin); // Debug log
  } catch (err) {
    return res.json({
      response_type: "in_channel",
      text: "⚠️ Bot error: Could not check admin status. Please check your Google Sheet's Admins tab exists and is shared properly."
    });
  }

  let text =
    "*Creo Attendance Bot — Help*\n\n" +
    "• `/clockin [h:mm AM/PM]` — Clock in (optional time).\n" +
    "• `/clockout [h:mm AM/PM]` — Clock out (optional time).\n" +
    "• `/myattendance [date|range]` — See your attendance.\n" +
    "• `/viewattendance` — Show today’s attendance table for everyone.\n" +
    "• `/addovertime [employee name] MM/DD/YYYY hours [reason]` — (Admin) Add overtime to an employee.\n" +
    "• `/addundertime [employee name] MM/DD/YYYY hours [reason]` — (Admin) Add undertime to an employee.\n" +
    "• Overtime and undertime requests are approved by admin.\n";

  if (admin) {
    text +=
      "\n*Admin Commands:*\n" +
      "• `/editattendance @user MM/DD/YYYY IN OUT` — Edit a user’s record.\n" +
      "• `/approve` — Approve pending overtime/undertime requests.\n" +
      "• `/addovertime @user MM/DD/YYYY [hours]` — Add overtime.\n" +
      "• `/addundertime @user MM/DD/YYYY [hours]` — Add undertime.\n" +
      "• `/history @user [date|range]` — Get user attendance history.\n" +
      "• `/addadmin email` — Add admin.\n" +
      "• `/removeadmin email` — Remove admin.\n";
  }

  res.json({ response_type: "in_channel", text });
});

app.get("/", (req, res) => {
  res.send("Attendance Bot running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot running on port ${PORT}`);
});
