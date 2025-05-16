const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const { google } = require("googleapis");
const moment = require("moment-timezone");
const axios = require("axios");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// Replace with your actual values:
const SHEET_ID = "11pLzp9wpM6Acw4daxpf4c41SD24iQBVs6NQMxGy44Bs";
const TIMEZONE = "Asia/Manila";
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "xoxb-..."; // Put your bot token in .env or here

const creds = JSON.parse(fs.readFileSync("credentials.json", "utf8"));

const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});
const sheets = google.sheets({ version: "v4", auth });

const HEADERS = [
  "Name of Employee",
  "Date",
  "Clock In",
  "Clock Out",
  "Total Hours"
];

// ---- UTILITY FUNCTIONS ----

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
      return resp.data.user.profile.display_name || resp.data.user.real_name || resp.data.user.name || "Unknown";
    }
    // fallback: try real_name
    if (resp.data.user && resp.data.user.real_name) {
      return resp.data.user.real_name;
    }
    return "Unknown";
  } catch (e) {
    return "Unknown";
  }
}

function formatTime(time) {
  if (!time) return "";
  return moment(time, "hh:mm A").format("h:mm A");
}

function calculateTotalHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return "";
  const inTime = moment(clockIn, "hh:mm A");
  const outTime = moment(clockOut, "hh:mm A");
  if (!inTime.isValid() || !outTime.isValid()) return "";

  // Deduct lunch break if range overlaps 12:00-1:00PM
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

// ---- GOOGLE SHEETS HANDLING ----

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
          { addSheet: { properties: { title: sheetName } } },
          {
            updateCells: {
              rows: [
                { values: HEADERS.map(h => ({ userEnteredValue: { stringValue: h } })) }
              ],
              fields: "*",
              start: { sheetId: res.data.sheets.length, rowIndex: 0, columnIndex: 0 }
            }
          }
        ]
      }
    });
  }
}

async function addAttendance({ name, date, clockIn }) {
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:E`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[name, date, clockIn, "", ""]] }
  });
}

async function updateClockOut({ name, date, clockOut }) {
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:E`
  });
  const rows = res.data.values || [];
  const rowIdx = rows.findIndex(
    (row) =>
      row[0] && row[0].toLowerCase() === name.toLowerCase() &&
      row[1] && row[1] === date
  );
  if (rowIdx < 1) throw new Error("No clock-in record found for today.");
  const clockIn = rows[rowIdx][2];
  const total = calculateTotalHours(clockIn, clockOut);

  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEET_ID,
    range: `${year}!D${rowIdx + 1}:E${rowIdx + 1}`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values: [[clockOut, total]] }
  });
}

async function getTodayAttendance(date) {
  const year = moment(date, "MM/DD/YYYY").year().toString();
  await ensureSheetExists(year);
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${year}!A:E`
  });
  const rows = res.data.values || [];
  return rows.filter((row, idx) => idx === 0 || row[1] === date);
}

// ---- SLACK COMMAND HANDLERS ----

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

// --- /clockin ---
app.post("/slack/command/clockin", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  let clockIn = moment().tz(TIMEZONE).format("h:mm A");

  // Allow optional custom time
  if (req.body.text) {
    const custom = getCustomTime(req.body.text);
    if (custom) {
      clockIn = custom;
    } else {
      return res.json({
        response_type: "ephemeral",
        text: "Please enter time as `h:mm AM/PM` (example: 7:30 AM)"
      });
    }
  }

  let name = await fetchSlackDisplayName(user_id);

  try {
    await addAttendance({ name, date, clockIn });
    res.json({
      response_type: "ephemeral",
      text: `✅ Clocked in as *${name}* at *${clockIn}* on ${date}.`
    });
  } catch (err) {
    res.json({
      response_type: "ephemeral",
      text: `Error: ${err.message}`
    });
  }
});

// --- /clockout ---
app.post("/slack/command/clockout", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  let clockOut = moment().tz(TIMEZONE).format("h:mm A");

  if (req.body.text) {
    const custom = getCustomTime(req.body.text);
    if (custom) {
      clockOut = custom;
    } else {
      return res.json({
        response_type: "ephemeral",
        text: "Please enter time as `h:mm AM/PM` (example: 4:30 PM)"
      });
    }
  }

  let name = await fetchSlackDisplayName(user_id);

  try {
    await updateClockOut({ name, date, clockOut });
    res.json({
      response_type: "ephemeral",
      text: `✅ Clocked out as *${name}* at *${clockOut}* on ${date}.`
    });
  } catch (err) {
    res.json({
      response_type: "ephemeral",
      text: `Error: ${err.message}`
    });
  }
});

// --- /viewattendance (in_channel) ---
app.post("/slack/command/viewattendance", async (req, res) => {
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  try {
    const records = await getTodayAttendance(date);
    let table = "";
    if (records.length > 1) {
      const colWidths = [18, 10, 10, 12];
      table +=
        "Name".padEnd(colWidths[0]) +
        "| Clock In ".padEnd(colWidths[1]) +
        "| Clock Out ".padEnd(colWidths[2]) +
        "| Total Hours\n";
      table +=
        "-".repeat(colWidths[0]) +
        "|-" + "-".repeat(colWidths[1] - 1) +
        "|-" + "-".repeat(colWidths[2] - 1) +
        "|-" + "-".repeat(colWidths[3] - 1) + "\n";
      for (let i = 1; i < records.length; i++) {
        const row = records[i];
        table +=
          (row[0] || "").padEnd(colWidths[0]) +
          "| " +
          (row[2] || "").padEnd(colWidths[1] - 1) +
          "| " +
          (row[3] || "").padEnd(colWidths[2] - 1) +
          "| " +
          (row[4] || "").padEnd(colWidths[3] - 1) +
          "\n";
      }
    } else {
      table = "No attendance records found for today.";
    }
    res.json({
      response_type: "in_channel",
      text: "```" + table + "```"
    });
  } catch (err) {
    res.json({
      response_type: "in_channel",
      text: `Error: ${err.message}`
    });
  }
});

// --- /help (in_channel) ---
app.post("/slack/command/help", (req, res) => {
  res.json({
    response_type: "in_channel",
    text:
      "*Attendance Bot Help*\n" +
      "• `/clockin [h:mm AM/PM]` - Clock in for the day (optional time argument).\n" +
      "• `/clockout [h:mm AM/PM]` - Clock out for the day (optional time argument).\n" +
      "• `/viewattendance` - View today's attendance table for everyone.\n" +
      "Lunch break of 1 hour (12:00 PM - 1:00 PM) is automatically deducted from total hours."
  });
});

// Root
app.get("/", (req, res) => {
  res.send("Attendance Bot running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot running on port ${PORT}`);
});
