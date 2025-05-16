const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 3000;

// === Google Sheets Config ===
const SPREADSHEET_ID = '11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs'; // Your Sheet ID here
const CREDENTIALS = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));

// Setup Google Sheets client
const auth = new google.auth.JWT(
  CREDENTIALS.client_email,
  null,
  CREDENTIALS.private_key,
  ['https://www.googleapis.com/auth/spreadsheets']
);
const sheets = google.sheets({ version: 'v4', auth });

app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Utility functions for date/time
function getManilaDate() {
  return moment().tz('Asia/Manila').format('MM/DD/YYYY');
}
function getManilaTime() {
  return moment().tz('Asia/Manila').format('hh:mm A');
}
function getYearTab() {
  return moment().tz('Asia/Manila').format('YYYY');
}

// =============================
// /clockin
app.post('/slack/command/clockin', async (req, res) => {
  const userName = req.body.user_name || 'Unknown';
  const text = req.body.text || ''; // Allow custom time: /clockin 7:30 AM

  let clockInTime = getManilaTime();
  if (text.trim()) {
    // Validate custom time format (e.g., "7:30 AM")
    const clean = text.trim().toUpperCase();
    if (/^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/.test(clean)) {
      clockInTime = clean;
    } else {
      res.json({ text: 'Invalid time format! Use HH:MM AM/PM, e.g., 7:30 AM' });
      return;
    }
  }
  const today = getManilaDate();
  const yearTab = getYearTab();

  // Write to Google Sheet
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A:E`,
      valueInputOption: 'USER_ENTERED',
      resource: {
        values: [[userName, today, clockInTime, '', '']]
      }
    });
    res.json({ text: `✅ Clocked in for *${userName}* at *${clockInTime}* on *${today}*.` });
  } catch (e) {
    res.json({ text: 'Error saving to sheet: ' + e.message });
  }
});

// =============================
// /clockout
app.post('/slack/command/clockout', async (req, res) => {
  const userName = req.body.user_name || 'Unknown';
  const text = req.body.text || ''; // Allow custom time: /clockout 5:15 PM

  let clockOutTime = getManilaTime();
  if (text.trim()) {
    const clean = text.trim().toUpperCase();
    if (/^(0?[1-9]|1[0-2]):[0-5][0-9]\s?(AM|PM)$/.test(clean)) {
      clockOutTime = clean;
    } else {
      res.json({ text: 'Invalid time format! Use HH:MM AM/PM, e.g., 5:15 PM' });
      return;
    }
  }
  const today = getManilaDate();
  const yearTab = getYearTab();

  try {
    // Read the sheet and find the latest matching clock-in
    const getRows = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A:E`
    });
    const rows = getRows.data.values || [];
    let updated = false;
    // Find the last row matching user and today's date with no clockout
    for (let i = rows.length - 1; i >= 0; i--) {
      if (
        rows[i][0] === userName &&
        rows[i][1] === today &&
        rows[i][2] &&
        (!rows[i][3] || rows[i][3] === '')
      ) {
        // Calculate total hours
        const clockInMoment = moment.tz(`${rows[i][1]} ${rows[i][2]}`, 'MM/DD/YYYY hh:mm A', 'Asia/Manila');
        const clockOutMoment = moment.tz(`${today} ${clockOutTime}`, 'MM/DD/YYYY hh:mm A', 'Asia/Manila');
        const diffHours = Math.max(0, clockOutMoment.diff(clockInMoment, 'minutes') / 60);
        // Update row with clockOut and total hours
        const rowNumber = i + 1;
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${yearTab}!D${rowNumber}:E${rowNumber}`,
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[clockOutTime, diffHours.toFixed(2)]]
          }
        });
        updated = true;
        res.json({ text: `✅ Clocked out for *${userName}* at *${clockOutTime}* on *${today}*.\n*Total hours worked:* ${diffHours.toFixed(2)} hrs.` });
        break;
      }
    }
    if (!updated) {
      res.json({ text: "No clock-in entry found for today or already clocked out." });
    }
  } catch (e) {
    res.json({ text: 'Error updating sheet: ' + e.message });
  }
});

// =============================
// /viewattendance
app.post('/slack/command/viewattendance', async (req, res) => {
  const yearTab = getYearTab();
  const today = getManilaDate();
  try {
    const getRows = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A:E`
    });
    const rows = getRows.data.values || [];
    const todayRows = rows.filter(row => row[1] === today);
    if (!todayRows.length) {
      res.json({ text: `No attendance records found for ${today}.` });
      return;
    }
    let text = `*Attendance for ${today}:*\n\n`;
    text += 'Name | Clock In | Clock Out | Total Hours\n';
    text += '--- | --- | --- | ---\n';
    todayRows.forEach(row => {
      text += `${row[0]} | ${row[2] || '-'} | ${row[3] || '-'} | ${row[4] || '-'}\n`;
    });
    res.json({ text });
  } catch (e) {
    res.json({ text: 'Error reading sheet: ' + e.message });
  }
});

// =============================
// Health check
app.get('/', (req, res) => {
  res.send('CreoBot Attendance is running!');
});

// =============================
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
