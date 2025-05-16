const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const moment = require('moment-timezone');
const axios = require('axios'); // <- Must be require, not import

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// === CONFIGURATION ===
const SHEET_ID = '11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs'; // Your Sheet ID
const TIMEZONE = 'Asia/Manila';

// === GOOGLE SHEETS AUTH ===
const credentials = JSON.parse(fs.readFileSync('credentials.json'));
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

// === HELPERS ===
function getSheetNameForYear(year) {
  return year.toString();
}

function formatDateMMDDYYYY(date) {
  return moment(date).tz(TIMEZONE).format('MM/DD/YYYY');
}

function getTodayDate() {
  return formatDateMMDDYYYY(moment().tz(TIMEZONE));
}

async function getSlackUserName(userId, slackToken) {
  try {
    const result = await axios.get('https://slack.com/api/users.info', {
      params: { user: userId },
      headers: { Authorization: `Bearer ${slackToken}` }
    });
    if (result.data && result.data.ok) {
      // Try to get display name, real name, then username
      return (
        result.data.user.profile.display_name ||
        result.data.user.real_name ||
        result.data.user.name ||
        'Unknown'
      );
    }
  } catch (err) {
    console.log('Error getting user info:', err.message);
  }
  return 'Unknown';
}

function computeTotalHours(inTime, outTime) {
  if (!inTime || !outTime) return 0;
  const inMoment = moment(inTime, 'HH:mm');
  const outMoment = moment(outTime, 'HH:mm');
  let diff = outMoment.diff(inMoment, 'minutes');
  if (diff < 0) diff += 24 * 60; // Overnight shift support
  return (diff / 60).toFixed(2);
}

// === GOOGLE SHEETS ROWS ===
async function appendAttendanceRow({ sheet, row }) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A:E`,
    valueInputOption: 'USER_ENTERED',
    resource: { values: [row] }
  });
}

async function getAttendanceRows(sheet, date) {
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A:E`
  });
  const rows = (data.values || []).filter(
    (row, idx) => idx !== 0 && row[1] === date // skip header
  );
  return rows;
}

// === SLACK SLASH COMMANDS ===

// /clockin
app.post('/slack/command/clockin', async (req, res) => {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const userId = req.body.user_id;
  const userName = await getSlackUserName(userId, slackToken);

  let clockInTime = moment().tz(TIMEZONE).format('HH:mm');
  const text = req.body.text ? req.body.text.trim() : '';
  if (text) {
    // Accepts either "07:30" or "07:30 AM"
    let parsed = moment.tz(text, ['HH:mm', 'h:mm A'], true, TIMEZONE);
    if (parsed.isValid()) {
      clockInTime = parsed.format('HH:mm');
    }
  }
  const today = getTodayDate();
  const year = moment().tz(TIMEZONE).year();
  const sheet = getSheetNameForYear(year);

  await appendAttendanceRow({
    sheet,
    row: [userName, today, clockInTime, '', '']
  });

  res.json({
    response_type: 'in_channel',
    text: `Clocked in for *${userName}* at *${clockInTime}* on *${today}*`
  });
});

// /clockout
app.post('/slack/command/clockout', async (req, res) => {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const userId = req.body.user_id;
  const userName = await getSlackUserName(userId, slackToken);

  let clockOutTime = moment().tz(TIMEZONE).format('HH:mm');
  const text = req.body.text ? req.body.text.trim() : '';
  if (text) {
    let parsed = moment.tz(text, ['HH:mm', 'h:mm A'], true, TIMEZONE);
    if (parsed.isValid()) {
      clockOutTime = parsed.format('HH:mm');
    }
  }
  const today = getTodayDate();
  const year = moment().tz(TIMEZONE).year();
  const sheet = getSheetNameForYear(year);

  // Read all rows for today, find the latest matching user without clock out
  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A:E`
  });
  let updated = false;
  const values = data.values || [];
  for (let i = values.length - 1; i >= 1; i--) {
    if (
      values[i][0] === userName &&
      values[i][1] === today &&
      (!values[i][3] || values[i][3] === '')
    ) {
      // Update row with clock out and total hours
      values[i][3] = clockOutTime;
      values[i][4] = computeTotalHours(values[i][2], clockOutTime);
      updated = true;
      // Write back just this row
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheet}!A${i + 1}:E${i + 1}`,
        valueInputOption: 'USER_ENTERED',
        resource: { values: [values[i]] }
      });
      break;
    }
  }
  if (updated) {
    res.json({
      response_type: 'in_channel',
      text: `Clocked out for *${userName}* at *${clockOutTime}* on *${today}*`
    });
  } else {
    res.json({
      response_type: 'ephemeral',
      text: "Couldn't find today's clock-in for you. Please use /clockin first."
    });
  }
});

// /viewattendance
app.post('/slack/command/viewattendance', async (req, res) => {
  const year = moment().tz(TIMEZONE).year();
  const sheet = getSheetNameForYear(year);
  const today = getTodayDate();

  const { data } = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheet}!A:E`
  });
  const rows = (data.values || []).filter(
    (row, idx) => idx !== 0 && row[1] === today
  );
  let table = 'Name | Clock In | Clock Out | Total Hours\n--- | --- | --- | ---\n';
  rows.forEach(row => {
    table += `${row[0] || ''} | ${row[2] || ''} | ${row[3] || ''} | ${row[4] || ''}\n`;
  });
  res.json({
    response_type: 'in_channel',
    text: `*Attendance for ${today}:*\n\`\`\`\n${table}\`\`\``
  });
});

// /help
app.post('/slack/command/help', (req, res) => {
  res.json({
    response_type: 'ephemeral',
    text:
      '*CreoBot Attendance – Commands:*\n' +
      '• `/clockin [HH:MM or HH:MM AM/PM]` – Clock in (optional time)\n' +
      '• `/clockout [HH:MM or HH:MM AM/PM]` – Clock out (optional time)\n' +
      '• `/viewattendance` – View today’s attendance (everyone can see)\n' +
      '• `/help` – Show this help message\n\n' +
      '_Time zone: Asia/Manila (GMT+8)_.'
  });
});

// ROOT
app.get('/', (req, res) => res.send('CreoBot Attendance is running!'));

// START
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
