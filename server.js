const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// ==== CONFIG ====
const SHEET_ID = process.env.SHEET_ID;
const TIMEZONE = "Asia/Manila";

// Google Sheets Auth
const creds = JSON.parse(fs.readFileSync("credentials.json", "utf8"));
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

// ==== UTILITIES ====

// Fetch Slack Display Name
async function fetchSlackDisplayName(user_id) {
  try {
    const resp = await axios.get("https://slack.com/api/users.info", {
      params: { user: user_id },
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });

    console.log("Slack API response for user info:", JSON.stringify(resp.data, null, 2));

    const user = resp.data?.user;
    const profile = user?.profile || {};

    return (
      profile.display_name?.trim() ||
      profile.real_name?.trim() ||
      user.name?.trim() ||
      "Unknown"
    );
  } catch (error) {
    console.error("Error fetching Slack display name:", error);
    return "Unknown";
  }
}

// Fetch Slack Email
// Removed unused fetchSlackEmail function



// Parse Custom Time Input
function getCustomTime(text) {
  if (!text) return null;
  let inputTime = text.trim();
  console.log("Parsing custom time input:", inputTime);

  // Accept formats like "7:30 AM" or "19:45"
  if (/^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(inputTime)) {
    if (!/AM|PM/i.test(inputTime)) {
      const hour = parseInt(inputTime.split(":")[0], 10);
      inputTime += hour < 12 ? " AM" : " PM";
    }

    const parsed = moment(inputTime, "h:mm A", true);
    return parsed.isValid() ? parsed.format("h:mm A") : null;
  }

  return null;
}

// Calculate Total Working Hours
function calculateTotalHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return "";
  const inTime = moment(clockIn, "h:mm A");
  const outTime = moment(clockOut, "h:mm A");
  if (!inTime.isValid() || !outTime.isValid()) return "";

  let breakMinutes = 0;
  const noon = moment("12:00 PM", "h:mm A");
  const afterLunch = moment("1:00 PM", "h:mm A");

  // Deduct 1 hour lunch break if time covers 12–1 PM
  if (inTime.isBefore(afterLunch) && outTime.isAfter(noon)) {
    breakMinutes = 60;
  }

  let duration = outTime.diff(inTime, "minutes") - breakMinutes;
  if (duration < 0) duration = 0;

  const hours = Math.floor(duration / 60);
  const minutes = duration % 60;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}`;
}

// Parse Date Range for Reports
function parseDateRange(arg) { /* ... */ }

// Ensure Sheet Exists and Write Headers if Needed
async function ensureSheetExists(sheetName) {
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const exists = res.data.sheets.some(
    (sheet) => sheet.properties.title === sheetName
  );
  if (!exists) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{ addSheet: { properties: { title: sheetName } } }]
      }
    });
  }
  // Always write headers
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

// Insert or Update Attendance Entry
async function upsertAttendance({ name, date, clockIn, clockOut }) {
  const sheetName = process.env.ACTIVE_SHEET || "test";
  await ensureSheetExists(sheetName);

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:G`
  });
  const rows = res.data.values || [];
  const rowIdx = rows.findIndex(
    (row, idx) =>
      idx > 0 &&
      row[0] && row[0].toLowerCase() === name.toLowerCase() &&
      row[1] && row[1] === date
  );

  let existingClockIn = "";
  let existingClockOut = "";
  if (rowIdx > 0) {
    existingClockIn = rows[rowIdx][2] || "";
    existingClockOut = rows[rowIdx][3] || "";
  }

  const finalClockIn = clockIn || existingClockIn;
  const finalClockOut = clockOut || existingClockOut;
  const totalHours = (finalClockIn && finalClockOut) ? calculateTotalHours(finalClockIn, finalClockOut) : "";

  if (rowIdx > 0) {
    const valuesToUpdate = [
      finalClockIn,
      finalClockOut,
      totalHours,
      rows[rowIdx][5] || "",
      rows[rowIdx][6] || ""
    ];
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!C${rowIdx + 1}:G${rowIdx + 1}`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [valuesToUpdate]
      }
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[name, date, clockIn || "", clockOut || "", totalHours, "", ""]]
      }
    });
  }
}

// Get Attendance Records
async function getAttendance(name, startDate, endDate) { /* ... */ }

// ==== SLACK COMMAND ENDPOINTS ====

// /clockin Endpoint
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

// /clockout Endpoint
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

// /myattendance Endpoint
app.post("/slack/command/myattendance", async (req, res) => {
  const user_id = req.body.user_id;
  const name = await fetchSlackDisplayName(user_id);
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const sheetName = process.env.ACTIVE_SHEET || "test";

  try {
    await ensureSheetExists(sheetName);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`
    });

    const rows = result.data.values || [];
    const record = rows.find((row, idx) => idx > 0 && row[0] === name && row[1] === date);

    if (!record) {
      return res.json({ response_type: "ephemeral", text: `No attendance found for *${name}* on ${date}.` });
    }

    const [ , , clockIn, clockOut, total ] = record;
    res.json({
      response_type: "ephemeral",
      text: `🗓️ *${date}* for *${name}*
Clock In: *${clockIn || '-'}*
Clock Out: *${clockOut || '-'}*
Total Hours: *${total || '-'}*`
    });
  } catch (error) {
    console.error("myattendance error:", error);
    res.json({ response_type: "ephemeral", text: "⚠️ Error fetching attendance. Please try again later." });
  }
});

// /viewattendance Endpoint
app.post("/slack/command/viewattendance", async (req, res) => {
  const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const sheetName = process.env.ACTIVE_SHEET || "test";

  try {
    await ensureSheetExists(sheetName);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`
    });

    const rows = result.data.values || [];
    const todayRows = rows.filter((row, idx) => idx > 0 && row[1] === today);

    if (todayRows.length === 0) {
      return res.json({
        response_type: "in_channel",
        text: `No attendance records for today (${today}).`
      });
    }

let table = "```\n";
table += "Name         | In      | Out\n";
table += "-------------|---------|--------\n";
todayRows.forEach(row => {
  table += (row[0] || "").padEnd(13) + "| ";
  table += moment(row[2], "h:mm A").format("h:mm A").padEnd(8) + "| ";
  table += moment(row[3], "h:mm A").format("h:mm A").padEnd(7) + "\n";
});
table += "```";

    res.json({
      response_type: "in_channel",
      text: `*Attendance for ${today}:*
${table}`
    });
  } catch (err) {
    console.error("viewattendance error:", err);
    res.json({
      response_type: "ephemeral",
      text: "⚠️ Error fetching attendance. Please try again later."
    });
  }
});

// /help Command
app.post("/slack/command/help", async (req, res) => {
  const helpText = `Here are the available commands you can use:

• /clockin [time] — Clock in for the day. Example: /clockin 8:00 AM
• /clockout [time] — Clock out for the day. Example: /clockout 5:00 PM
• /myattendance — View your own attendance for today.
• /viewattendance — View everyone's attendance for today.`;

  res.json({ response_type: "ephemeral", text: helpText });
});

// Home Route
app.get("/", (req, res) => {
  res.send("Attendance Bot running!");
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot running on port ${PORT}`);
});
