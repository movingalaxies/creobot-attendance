const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');
const fs = require('fs');
const { google } = require('googleapis');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// ---- GOOGLE SHEETS CONFIG ----
const SHEET_ID = '11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs'; // Your sheet ID
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  SCOPES
);
const sheets = google.sheets({ version: 'v4', auth });

// ---- HELPERS ----
function formatTime12hr(timeStr) {
  if (!timeStr) return '';
  let [hour, minute] = timeStr.split(':');
  hour = parseInt(hour, 10);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12;
  if (hour === 0) hour = 12;
  return `${hour}:${minute} ${ampm}`;
}

function getToday() {
  return moment().tz("Asia/Manila").format("MM/DD/YYYY");
}
function getCurrentTime() {
  return moment().tz("Asia/Manila").format("HH:mm");
}
function getYearSheetName(dateStr) {
  // MM/DD/YYYY
  return dateStr.split('/')[2]; // e.g., 2024
}

async function getSlackDisplayName(user_id, token) {
  const axios = require('axios');
  try {
    const resp = await axios.get('https://slack.com/api/users.info', {
      headers: { Authorization: `Bearer ${token}` },
      params: { user: user_id }
    });
    if (
      resp.data &&
      resp.data.user &&
      resp.data.user.profile &&
      resp.data.user.profile.display_name &&
      resp.data.user.profile.display_name.length > 0
    ) {
      return resp.data.user.profile.display_name;
    }
    if (
      resp.data &&
      resp.data.user &&
      resp.data.user.real_name &&
      resp.data.user.real_name.length > 0
    ) {
      return resp.data.user.real_name;
    }
    return "Unknown";
  } catch (e) {
    return "Unknown";
  }
}

async function appendAttendance({ name, date, clockIn, clockOut, totalHours }) {
  const sheetName = getYearSheetName(date);
  const values = [[name, date, clockIn, clockOut, totalHours]];
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:E`,
    valueInputOption: "USER_ENTERED",
    resource: { values }
  });
}

async function getTodayAttendanceRows(date) {
  const sheetName = getYearSheetName(date);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:E`,
  });
  const allRows = resp.data.values || [];
  // Filter for today's date (skip header row)
  return allRows.filter((row, idx) => idx === 0 || row[1] === date);
}

function calculateTotalHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return '';
  const start = moment(clockIn, 'HH:mm');
  const end = moment(clockOut, 'HH:mm');
  let diff = moment.duration(end.diff(start));
  if (diff.asMilliseconds() < 0) diff = diff.add(1, 'day'); // Overnight case
  const hours = Math.floor(diff.asHours());
  const minutes = diff.minutes();
  return `${hours}:${minutes < 10 ? '0' : ''}${minutes}`;
}

// ---- SLACK COMMANDS ----

app.post('/slack/command/clockin', async (req, res) => {
  const token = req.body.token || req.body['api_app_id']; // Your Bot User OAuth token if available
  const user_id = req.body.user_id;
  const date = getToday();
  const timeArg = req.body.text ? req.body.text.trim() : "";
  const clockIn = timeArg ? moment(timeArg, ["h:mm A", "H:mm"]).format("HH:mm") : getCurrentTime();
  const name = await getSlackDisplayName(user_id, process.env.SLACK_BOT_TOKEN);

  // Log to Google Sheets (append a new row)
  await appendAttendance({ name, date, clockIn, clockOut: '', totalHours: '' });

  // Respond only to the user (ephemeral)
  res.json({
    response_type: "ephemeral",
    text: `✅ Clocked in at ${formatTime12hr(clockIn)} (${date}) as ${name}`
  });
});

app.post('/slack/command/clockout', async (req, res) => {
  const token = req.body.token || req.body['api_app_id'];
  const user_id = req.body.user_id;
  const date = getToday();
  const timeArg = req.body.text ? req.body.text.trim() : "";
  const clockOut = timeArg ? moment(timeArg, ["h:mm A", "H:mm"]).format("HH:mm") : getCurrentTime();
  const name = await getSlackDisplayName(user_id, process.env.SLACK_BOT_TOKEN);

  // Get all today's rows, find latest clock-in by this user without clock-out, and update that row
  const sheetName = getYearSheetName(date);
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A:E`,
  });
  const allRows = resp.data.values || [];
  let targetRow = -1;
  for (let i = allRows.length - 1; i >= 1; i--) {
    if (allRows[i][0] === name && allRows[i][1] === date && !allRows[i][3]) {
      targetRow = i;
      break;
    }
  }
  if (targetRow === -1) {
    res.json({
      response_type: "ephemeral",
      text: `No clock-in found for today to clock out.`
    });
    return;
  }
  const clockIn = allRows[targetRow][2];
  const totalHours = calculateTotalHours(clockIn, clockOut);
  allRows[targetRow][3] = clockOut;
  allRows[targetRow][4] = totalHours;
  // Update the row in Google Sheets
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetName}!A${targetRow + 1}:E${targetRow + 1}`,
    valueInputOption: "USER_ENTERED",
    resource: { values: [allRows[targetRow]] }
  });

  res.json({
    response_type: "ephemeral",
    text: `✅ Clocked out at ${formatTime12hr(clockOut)}. Total hours: ${totalHours}`
  });
});

app.post('/slack/command/viewattendance', async (req, res) => {
  const date = getToday();
  const rows = await getTodayAttendanceRows(date);
  if (rows.length <= 1) {
    res.json({
      response_type: "in_channel",
      text: `No attendance for today (${date}) yet.`
    });
    return;
  }
  // Build table (code block)
  let table = "Name               | Clock In | Clock Out | Total Hours\n";
  table += "-------------------|----------|-----------|------------\n";
  for (let i = 1; i < rows.length; i++) {
    const name = (rows[i][0] || '').padEnd(19, ' ');
    const clockIn = formatTime12hr(rows[i][2] || '').padEnd(8, ' ');
    const clockOut = formatTime12hr(rows[i][3] || '').padEnd(9, ' ');
    const total = (rows[i][4] || '').toString().padEnd(10, ' ');
    table += `${name}| ${clockIn}| ${clockOut}| ${total}\n`;
  }
  res.json({
    response_type: "in_channel",
    text: `*Attendance for ${date}:*\n\`\`\`\n${table}\`\`\``
  });
});

app.post('/slack/command/help', (req, res) => {
  res.json({
    response_type: "ephemeral",
    text:
      `*CreoBot Attendance Help*\n` +
      "• `/clockin [optional_time]` — Clock in for today (e.g., `/clockin 7:30 AM`).\n" +
      "• `/clockout [optional_time]` — Clock out for today (e.g., `/clockout 5:30 PM`).\n" +
      "• `/viewattendance` — View today's company attendance (everyone can see this).\n" +
      "• `/help` — Show this help message.\n\n" +
      "_All times are recorded in Asia/Manila (GMT+8)._\n"
  });
});

// ---- START SERVER ----
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot server running on port ${PORT}`);
});
