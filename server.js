const express = require("express");
const bodyParser = require("body-parser");
const { google } = require("googleapis");
const fs = require("fs");
const moment = require("moment");
const app = express();
const PORT = process.env.PORT || 3000;

// ---- Google Sheets setup ---- //
const SHEET_ID = "11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs";
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const credentials = JSON.parse(fs.readFileSync("credentials.json"));
const auth = new google.auth.JWT(
  credentials.client_email,
  null,
  credentials.private_key,
  SCOPES
);
const sheets = google.sheets({ version: "v4", auth });

// ---- Express setup ---- //
app.use(bodyParser.urlencoded({ extended: true }));

// ---- Helper Functions ---- //

// Ensure year tab exists, if not, create it with header row
async function ensureYearSheet(year) {
  const sheetTitle = year.toString();
  const res = await sheets.spreadsheets.get({ spreadsheetId: SHEET_ID });
  const existing = res.data.sheets.map(s => s.properties.title);
  if (!existing.includes(sheetTitle)) {
    // Add sheet/tab
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: SHEET_ID,
      requestBody: {
        requests: [{
          addSheet: {
            properties: {
              title: sheetTitle
            }
          }
        }]
      }
    });
    // Add header row
    await sheets.spreadsheets.values.update({
      spreadsheetId: SHEET_ID,
      range: `${sheetTitle}!A1:E1`,
      valueInputOption: "RAW",
      requestBody: {
        values: [[
          "Name of Employee", "Date", "Clock In", "Clock Out", "Total Hours"
        ]]
      }
    });
  }
}

// Find next empty row for a given sheet/tab
async function appendRow(sheetTitle, rowValues) {
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A:E`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: {
      values: [rowValues]
    }
  });
}

// Fetch today's attendance from this year's tab
async function getAttendanceByDate(sheetTitle, date) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A:E`
  });
  const rows = res.data.values || [];
  return rows.filter(r => r[1] === date);
}

// Find row index of a user's attendance for today
async function findUserRow(sheetTitle, name, date) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!A:E`
  });
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if ((rows[i][0] || "") === name && (rows[i][1] || "") === date) return i + 1; // Sheets is 1-indexed
  }
  return null;
}

// Update a cell (clock in/out/total)
async function updateCell(sheetTitle, rowIndex, colIndex, value) {
  const colLetter = String.fromCharCode("A".charCodeAt(0) + colIndex);
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${sheetTitle}!${colLetter}${rowIndex}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[value]] }
  });
}

// ---- Slack Slash Command Endpoints ---- //

// /clockin [optional_time]
app.post("/slack/command/clockin", async (req, res) => {
  const userName = req.body.user_name || "Unknown";
  const text = (req.body.text ? req.body.text.trim() : "");
  const now = moment();
  const date = now.format("MM/DD/YYYY");
  const year = now.format("YYYY");
  const time = text ? text : now.format("hh:mm A");

  await ensureYearSheet(year);

  // Check if already clocked in
  const userRow = await findUserRow(year, userName, date);
  if (userRow) {
    res.send(`:warning: You already clocked in today!`);
    return;
  }

  await appendRow(year, [userName, date, time, "", ""]);
  res.send(`:white_check_mark: Clocked in at *${time}* on ${date}.`);
});

// /clockout [optional_time]
app.post("/slack/command/clockout", async (req, res) => {
  const userName = req.body.user_name || "Unknown";
  const text = (req.body.text ? req.body.text.trim() : "");
  const now = moment();
  const date = now.format("MM/DD/YYYY");
  const year = now.format("YYYY");
  const outTime = text ? text : now.format("hh:mm A");

  await ensureYearSheet(year);

  const userRow = await findUserRow(year, userName, date);
  if (!userRow) {
    res.send(`:x: You have not clocked in today!`);
    return;
  }

  // Get current values (to calculate total)
  const resSheet = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A${userRow}:E${userRow}`
  });
  const row = resSheet.data.values[0];
  const inTime = row[2];

  // Update clock out
  await updateCell(year, userRow, 3, outTime);

  // Calculate total hours
  let total = "";
  if (inTime && outTime) {
    const inM = moment(inTime, ["h:mm A", "hh:mm A"]);
    const outM = moment(outTime, ["h:mm A", "hh:mm A"]);
    if (inM.isValid() && outM.isValid()) {
      const diff = moment.duration(outM.diff(inM));
      total = `${Math.floor(diff.asHours())}:${("0"+diff.minutes()).slice(-2)}`;
      await updateCell(year, userRow, 4, total);
    }
  }

  res.send(`:white_check_mark: Clocked out at *${outTime}* on ${date}. Total hours: ${total ? total : "N/A"}`);
});

// /viewattendance
app.post("/slack/command/viewattendance", async (req, res) => {
  const now = moment();
  const date = now.format("MM/DD/YYYY");
  const year = now.format("YYYY");
  await ensureYearSheet(year);
  const todayRows = await getAttendanceByDate(year, date);

  if (todayRows.length <= 1) {
    res.send("No attendance found for today.");
    return;
  }

  let text = `*Attendance for ${date}:*\n`;
  for (let i = 1; i < todayRows.length; i++) {
    const row = todayRows[i];
    text += `• ${row[0]} — In: ${row[2] || "-"}, Out: ${row[3] || "-"}, Total: ${row[4] || "-"}\n`;
  }
  res.send(text);
});

// /help
app.post("/slack/command/help", (req, res) => {
  res.send(
    "*CreoBot Attendance - Commands:*\n" +
    "`/clockin [time]` – Record your clock-in (default: now). Example: `/clockin 8:00 AM`\n" +
    "`/clockout [time]` – Record your clock-out (default: now). Example: `/clockout 5:30 PM`\n" +
    "`/viewattendance` – See all today's attendance records\n" +
    "`/help` – This help message"
  );
});

// ---- Basic Test/Health Endpoint ---- //
app.get("/", (req, res) => {
  res.send("CreoBot Attendance server running!");
});

// ---- Start server ---- //
app.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
