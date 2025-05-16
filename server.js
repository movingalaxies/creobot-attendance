const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const moment = require('moment-timezone');

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// Set timezone to Asia/Manila (GMT+8)
const TIMEZONE = 'Asia/Manila';
const SPREADSHEET_ID = '11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs'; // Your Google Sheet ID

// Load service account credentials
const credentials = JSON.parse(fs.readFileSync('credentials.json'));

// Authenticate with Google Sheets
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// Utility: get sheet name (tab) by year
function getSheetNameByYear(year) {
  return year.toString();
}

// Utility: get today's Manila date in MM/DD/YYYY
function getTodayDate() {
  return moment().tz(TIMEZONE).format('MM/DD/YYYY');
}

// Utility: get today's year
function getCurrentYear() {
  return moment().tz(TIMEZONE).format('YYYY');
}

// Utility: get Manila time in HH:mm
function getCurrentTime() {
  return moment().tz(TIMEZONE).format('HH:mm');
}

// Utility: calculate hours (float, 2 decimals)
function calculateTotalHours(inTime, outTime) {
  if (!inTime || !outTime) return 0;
  const format = "HH:mm";
  const start = moment(inTime, format);
  const end = moment(outTime, format);
  let diff = end.diff(start, 'minutes');
  if (diff < 0) diff += 24 * 60; // handle overnight
  return (diff / 60).toFixed(2);
}

// ========== SLACK COMMANDS ========== //

// /clockin
app.post('/slack/command/clockin', async (req, res) => {
  const name = req.body.user_name || "Unknown";
  const date = getTodayDate();
  const year = getCurrentYear();
  const sheetName = getSheetNameByYear(year);
  const clockIn = getCurrentTime();

  // Check if already clocked in for today
  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:E`
  });

  let updated = false;
  let rowIndex = null;
  let userRow = null;

  if (getRows.data.values) {
    getRows.data.values.forEach((row, i) => {
      if (row[0] === name && row[1] === date) {
        updated = true;
        rowIndex = i + 1;
        userRow = row;
      }
    });
  }

  if (updated) {
    // Already clocked in today
    return res.json({
      response_type: "ephemeral",
      text: `Already clocked in for ${name} at ${userRow[2]} on ${date}`
    });
  } else {
    // Append new row: [Name, Date, Clock In, Clock Out, Total Hours]
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${sheetName}!A:E`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [
          [name, date, clockIn, '', '']
        ]
      }
    });
    return res.json({
      response_type: "in_channel",
      text: `Clocked in for ${name} at ${clockIn} on ${date}`
    });
  }
});

// /clockout
app.post('/slack/command/clockout', async (req, res) => {
  const name = req.body.user_name || "Unknown";
  const date = getTodayDate();
  const year = getCurrentYear();
  const sheetName = getSheetNameByYear(year);
  const clockOut = getCurrentTime();

  // Fetch all rows for the year
  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:E`
  });

  let found = false;
  let rowIndex = null;
  let userRow = null;

  if (getRows.data.values) {
    getRows.data.values.forEach((row, i) => {
      if (row[0] === name && row[1] === date) {
        found = true;
        rowIndex = i + 1;
        userRow = row;
      }
    });
  }

  if (!found) {
    return res.json({
      response_type: "ephemeral",
      text: `No clock-in found for ${name} today. Please /clockin first.`
    });
  }

  // If already clocked out
  if (userRow[3]) {
    return res.json({
      response_type: "ephemeral",
      text: `Already clocked out for ${name} at ${userRow[3]} on ${date}`
    });
  }

  // Update the row with clock out and total hours
  const totalHours = calculateTotalHours(userRow[2], clockOut);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A${rowIndex}:E${rowIndex}`,
    valueInputOption: 'USER_ENTERED',
    resource: {
      values: [
        [name, date, userRow[2], clockOut, totalHours]
      ]
    }
  });

  return res.json({
    response_type: "in_channel",
    text: `Clocked out for ${name} at ${clockOut} on ${date}. Total hours: ${totalHours}`
  });
});

// /viewattendance
app.post('/slack/command/viewattendance', async (req, res) => {
  const date = getTodayDate();
  const year = getCurrentYear();
  const sheetName = getSheetNameByYear(year);

  const getRows = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheetName}!A:E`
  });

  let table = `*Attendance for ${date}:*\n`;
  table += `| Name | Clock In | Clock Out | Total Hours |\n`;
  table += `| --- | --- | --- | --- |\n`;

  let found = false;
  if (getRows.data.values) {
    getRows.data.values.forEach((row, i) => {
      if (row[1] === date) {
        found = true;
        table += `| ${row[0]} | ${row[2] || ""} | ${row[3] || ""} | ${row[4] || ""} |\n`;
      }
    });
  }

  if (!found) {
    table += "No attendance records found for today.";
  }

  return res.json({
    response_type: "in_channel", // so everyone in the channel can see
    text: table
  });
});

// /help
app.post('/slack/command/help', (req, res) => {
  return res.json({
    response_type: "ephemeral",
    text: `
*CreoBot Attendance Bot Commands:*
- /clockin — Clock in for today
- /clockout — Clock out for today
- /viewattendance — View today's attendance for all
- /help — Show this help message
    `
  });
});

// Home page for testing
app.get('/', (req, res) => {
  res.send('CreoBot Attendance Bot is running.');
});

// Glitch: listen on process.env.PORT
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
});
