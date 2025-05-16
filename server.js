const express = require('express');
const bodyParser = require('body-parser');
const { google } = require('googleapis');
const fs = require('fs');
const moment = require('moment-timezone');
const axios = require('axios');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));

// --- CONFIG --- //
const SPREADSHEET_ID = '11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs'; // Your sheet
const TIMEZONE = 'Asia/Manila';

// --- GOOGLE SHEETS SETUP --- //
const credentials = JSON.parse(fs.readFileSync('credentials.json', 'utf8'));
const auth = new google.auth.GoogleAuth({
  credentials,
  scopes: ['https://www.googleapis.com/auth/spreadsheets']
});
const sheets = google.sheets({ version: 'v4', auth });

// --- HELPERS --- //
function getToday() {
  return moment().tz(TIMEZONE).format('MM/DD/YYYY');
}
function getYearTab() {
  return moment().tz(TIMEZONE).format('YYYY');
}
async function getSlackRealName(userId) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  try {
    const result = await axios.get('https://slack.com/api/users.info', {
      params: { user: userId },
      headers: { Authorization: `Bearer ${token}` }
    });
    return (result.data.user.profile.real_name || result.data.user.name || null);
  } catch (e) {
    return null;
  }
}

// --- SLASH COMMAND: /clockin --- //
app.post('/slack/command/clockin', async (req, res) => {
  const userId = req.body.user_id;
  let userName = req.body.user_name || 'Unknown';
  const realName = await getSlackRealName(userId);
  if (realName) userName = realName;

  const time = req.body.text && req.body.text.trim() ? req.body.text.trim() : moment().tz(TIMEZONE).format('HH:mm');
  const today = getToday();
  const yearTab = getYearTab();

  try {
    // Get current sheet rows
    const getRows = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A:E`
    });
    const rows = getRows.data.values || [];
    // Check if already clocked in
    const foundIdx = rows.findIndex(row => row[0] === userName && row[1] === today);
    if (foundIdx >= 0 && rows[foundIdx][2]) {
      res.json({ text: `You've already clocked in today at ${rows[foundIdx][2]}.` });
      return;
    }
    // Append or update
    if (foundIdx >= 0) {
      rows[foundIdx][2] = time;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${yearTab}!A${foundIdx + 1}:E${foundIdx + 1}`,
        valueInputOption: 'RAW',
        requestBody: { values: [rows[foundIdx]] }
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${yearTab}!A:E`,
        valueInputOption: 'RAW',
        requestBody: { values: [[userName, today, time, '', '']] }
      });
    }
    res.json({ text: `Clocked in at ${time} (${TIMEZONE}) as ${userName}` });
  } catch (e) {
    res.json({ text: 'Error: ' + e.message });
  }
});

// --- SLASH COMMAND: /clockout --- //
app.post('/slack/command/clockout', async (req, res) => {
  const userId = req.body.user_id;
  let userName = req.body.user_name || 'Unknown';
  const realName = await getSlackRealName(userId);
  if (realName) userName = realName;

  const time = req.body.text && req.body.text.trim() ? req.body.text.trim() : moment().tz(TIMEZONE).format('HH:mm');
  const today = getToday();
  const yearTab = getYearTab();

  try {
    // Get current sheet rows
    const getRows = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A:E`
    });
    const rows = getRows.data.values || [];
    // Find row
    const foundIdx = rows.findIndex(row => row[0] === userName && row[1] === today);
    if (foundIdx === -1 || !rows[foundIdx][2]) {
      res.json({ text: `You must clock in before clocking out.` });
      return;
    }
    if (rows[foundIdx][3]) {
      res.json({ text: `You've already clocked out today at ${rows[foundIdx][3]}.` });
      return;
    }
    // Save clock out
    rows[foundIdx][3] = time;
    // Calculate total hours
    let total = 0;
    try {
      const inMoment = moment.tz(`${today} ${rows[foundIdx][2]}`, 'MM/DD/YYYY HH:mm', TIMEZONE);
      const outMoment = moment.tz(`${today} ${time}`, 'MM/DD/YYYY HH:mm', TIMEZONE);
      total = Math.max(0, outMoment.diff(inMoment, 'minutes') / 60);
    } catch (e) {}
    rows[foundIdx][4] = total.toFixed(2);
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `${yearTab}!A${foundIdx + 1}:E${foundIdx + 1}`,
      valueInputOption: 'RAW',
      requestBody: { values: [rows[foundIdx]] }
    });
    res.json({ text: `Clocked out at ${time} (${TIMEZONE}) as ${userName}. Total hours worked: ${rows[foundIdx][4]}` });
  } catch (e) {
    res.json({ text: 'Error: ' + e.message });
  }
});

// --- SLASH COMMAND: /viewattendance --- //
app.post('/slack/command/viewattendance', async (req, res) => {
  const yearTab = getYearTab();
  const today = getToday();
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

    // Table formatting (code block)
    let text = `*Attendance for ${today}:*\n`;
    text += '```\n';
    text += 'Name                 | Clock In | Clock Out | Total Hours\n';
    text += '---------------------|----------|-----------|------------\n';
    todayRows.forEach(row => {
      text += `${(row[0] || '').padEnd(21)}| ${(row[2] || '-').padEnd(8)} | ${(row[3] || '-').padEnd(9)} | ${(row[4] || '-').padEnd(10)}\n`;
    });
    text += '```';

    // Broadcast to channel (everyone sees)
    const token = process.env.SLACK_BOT_TOKEN;
    const channel = req.body.channel_id;
    await axios.post('https://slack.com/api/chat.postMessage', {
      channel,
      text
    }, {
      headers: { Authorization: `Bearer ${token}` }
    });
    res.json(); // Empty response: avoid double-post in Slack
  } catch (e) {
    res.json({ text: 'Error reading sheet: ' + e.message });
  }
});

// --- START SERVER --- //
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
