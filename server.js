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

// Send delayed response to Slack
async function sendDelayedResponse(response_url, message) {
  try {
    await axios.post(response_url, message);
  } catch (error) {
    console.error("Error sending delayed response:", error);
  }
}

// Fetch Slack Display Name
async function fetchSlackDisplayName(user_id) {
  try {
    const resp = await axios.get("https://slack.com/api/users.info", {
      params: { user: user_id },
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });

    console.log("Slack API response for user info:", JSON.stringify(resp.data, null, 2));

    if (!resp.data.ok) {
      console.error("Slack API error:", resp.data.error);
      return "Unknown";
    }

    const user = resp.data?.user;
    if (!user) {
      console.error("No user data in Slack API response");
      return "Unknown";
    }

    const profile = user.profile || {};

    return (
      profile.display_name?.trim() ||
      profile.real_name?.trim() ||
      user.name?.trim() ||
      "Unknown"
    );
  } catch (error) {
    console.error("Error fetching Slack display name:", error.message);
    return "Unknown";
  }
}

// Parse Custom Time Input
function getCustomTime(text) {
  if (!text) return null;
  let inputTime = text.trim();
  console.log("Parsing custom time input:", inputTime);

  // Accept formats like "7:30 AM", "19:45", "7:30", "730 AM", etc.
  const timePatterns = [
    /^(\d{1,2}):(\d{2})\s?(AM|PM)$/i,  // 7:30 AM
    /^(\d{1,2})(\d{2})\s?(AM|PM)$/i,   // 730 AM
    /^(\d{1,2}):(\d{2})$/,             // 7:30 (24-hour)
    /^(\d{1,2})$/                      // 7 (hour only)
  ];

  for (let pattern of timePatterns) {
    const match = inputTime.match(pattern);
    if (match) {
      let hour, minute, ampm;
      
      if (pattern.source.includes('AM|PM')) {
        // 12-hour format with AM/PM
        if (pattern.source.includes(':')) {
          hour = parseInt(match[1], 10);
          minute = parseInt(match[2], 10);
        } else {
          // Handle formats like "730 AM"
          const timeStr = match[1] + match[2];
          hour = parseInt(timeStr.slice(0, -2), 10);
          minute = parseInt(timeStr.slice(-2), 10);
        }
        ampm = match[3] ? match[3].toUpperCase() : null;
      } else if (pattern.source.includes(':')) {
        // 24-hour format like "19:30"
        hour = parseInt(match[1], 10);
        minute = parseInt(match[2], 10);
        ampm = hour >= 12 ? 'PM' : 'AM';
        if (hour > 12) hour -= 12;
        if (hour === 0) hour = 12;
      } else {
        // Hour only like "7"
        hour = parseInt(match[1], 10);
        minute = 0;
        ampm = hour >= 12 ? 'PM' : 'AM';
        if (hour > 12) hour -= 12;
        if (hour === 0) hour = 12;
      }

      // Validate hour and minute ranges
      if (minute < 0 || minute > 59) return null;
      if (hour < 1 || hour > 12) return null;

      const timeString = `${hour}:${minute.toString().padStart(2, '0')} ${ampm}`;
      const parsed = moment(timeString, "h:mm A", true);
      return parsed.isValid() ? parsed.format("h:mm A") : null;
    }
  }

  return null;
}

// Calculate Total Working Hours
function calculateTotalHours(clockIn, clockOut) {
  if (!clockIn || !clockOut) return "";
  
  try {
    const inTime = moment(clockIn, "h:mm A");
    const outTime = moment(clockOut, "h:mm A");
    
    if (!inTime.isValid() || !outTime.isValid()) {
      console.error("Invalid time format for calculation:", { clockIn, clockOut });
      return "";
    }

    // Handle overnight shifts
    if (outTime.isBefore(inTime)) {
      outTime.add(1, 'day');
    }

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
  } catch (error) {
    console.error("Error calculating total hours:", error);
    return "";
  }
}

// Parse Date Range for Reports
function parseDateRange(arg) {
  if (!arg) {
    // Default to current week
    const startOfWeek = moment().tz(TIMEZONE).startOf('week');
    const endOfWeek = moment().tz(TIMEZONE).endOf('week');
    return {
      startDate: startOfWeek.format("MM/DD/YYYY"),
      endDate: endOfWeek.format("MM/DD/YYYY")
    };
  }

  const input = arg.trim().toLowerCase();
  
  // Handle preset ranges
  if (input === 'today') {
    const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
    return { startDate: today, endDate: today };
  }
  
  if (input === 'yesterday') {
    const yesterday = moment().tz(TIMEZONE).subtract(1, 'day').format("MM/DD/YYYY");
    return { startDate: yesterday, endDate: yesterday };
  }
  
  if (input === 'this week') {
    const startOfWeek = moment().tz(TIMEZONE).startOf('week');
    const endOfWeek = moment().tz(TIMEZONE).endOf('week');
    return {
      startDate: startOfWeek.format("MM/DD/YYYY"),
      endDate: endOfWeek.format("MM/DD/YYYY")
    };
  }
  
  if (input === 'last week') {
    const startOfLastWeek = moment().tz(TIMEZONE).subtract(1, 'week').startOf('week');
    const endOfLastWeek = moment().tz(TIMEZONE).subtract(1, 'week').endOf('week');
    return {
      startDate: startOfLastWeek.format("MM/DD/YYYY"),
      endDate: endOfLastWeek.format("MM/DD/YYYY")
    };
  }
  
  if (input === 'this month') {
    const startOfMonth = moment().tz(TIMEZONE).startOf('month');
    const endOfMonth = moment().tz(TIMEZONE).endOf('month');
    return {
      startDate: startOfMonth.format("MM/DD/YYYY"),
      endDate: endOfMonth.format("MM/DD/YYYY")
    };
  }

  // Handle date ranges like "01/01/2025 to 01/31/2025" or "01/01/2025-01/31/2025"
  const rangePattern = /^(\d{1,2}\/\d{1,2}\/\d{4})\s*(?:to|-)\s*(\d{1,2}\/\d{1,2}\/\d{4})$/;
  const rangeMatch = input.match(rangePattern);
  
  if (rangeMatch) {
    const startDate = moment(rangeMatch[1], ["MM/DD/YYYY", "M/D/YYYY"], true);
    const endDate = moment(rangeMatch[2], ["MM/DD/YYYY", "M/D/YYYY"], true);
    
    if (startDate.isValid() && endDate.isValid()) {
      return {
        startDate: startDate.format("MM/DD/YYYY"),
        endDate: endDate.format("MM/DD/YYYY")
      };
    }
  }

  // Handle single date
  const singleDate = moment(input, ["MM/DD/YYYY", "M/D/YYYY"], true);
  if (singleDate.isValid()) {
    const dateStr = singleDate.format("MM/DD/YYYY");
    return { startDate: dateStr, endDate: dateStr };
  }

  return null;
}

// Validate Clock In/Out Logic
async function validateClockAction(name, date, action, time) {
  const sheetName = moment().tz(TIMEZONE).format("YYYY");

  try {
    await ensureSheetExists(sheetName);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`
    });

    const rows = res.data.values || [];

    const existingRecord = rows.find(
      (row, idx) =>
        idx > 0 &&
        row[0] && row[0].toLowerCase() === name.toLowerCase() &&
        row[1] && row[1] === date
    );

    if (action === 'clockin') {
      if (existingRecord && existingRecord[2]) {
        console.warn(`[VALIDATION BLOCKED] ${name} already clocked in at ${existingRecord[2]}`);
        return {
          valid: false,
          message: `⚠️ You've already clocked in today at *${existingRecord[2]}*. Use /clockout to clock out.`
        };
      }
    } else if (action === 'clockout') {
      if (!existingRecord || !existingRecord[2]) {
        console.warn(`[VALIDATION BLOCKED] ${name} has not clocked in yet on ${date}`);
        return {
          valid: false,
          message: `⚠️ You haven't clocked in today yet. Use /clockin first.`
        };
      }
      if (existingRecord[3]) {
        console.warn(`[VALIDATION BLOCKED] ${name} already clocked out at ${existingRecord[3]}`);
        return {
          valid: false,
          message: `⚠️ You've already clocked out today at *${existingRecord[3]}*.`
        };
      }

      // Validate clock out time is after clock in time
      const clockInTime = moment(existingRecord[2], "h:mm A");
      const clockOutTime = moment(time, "h:mm A");

      if (clockOutTime.isBefore(clockInTime)) {
        console.warn(`[VALIDATION BLOCKED] ${name}'s clock out time (${time}) is earlier than clock in time (${existingRecord[2]})`);
        return {
          valid: false,
          message: `⚠️ Clock out time (${time}) cannot be earlier than clock in time (${existingRecord[2]}).`
        };
      }
    }

    console.log(`[VALIDATION] Passed for ${name} on ${date} (${action}) at ${time}`);
    return { valid: true };

  } catch (error) {
    console.error(`[VALIDATION ERROR] Failed to validate ${action} for ${name} on ${date}:`, error.message);
    return {
      valid: false,
      message: "⚠️ Error validating attendance. Please try again later."
    };
  }
}

// Ensure Sheet Exists and Write Headers if Needed
async function ensureSheetExists(sheetName) {
  try {
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
  } catch (error) {
    console.error("Error ensuring sheet exists:", error);
    throw new Error("Failed to access or create attendance sheet");
  }
}

// Insert or Update Attendance Entry
async function upsertAttendance({ name, date, clockIn, clockOut }) {
  const sheetName = moment().tz(TIMEZONE).format("YYYY");

  try {
    await ensureSheetExists(sheetName);

    console.log(`[UPSERT] Start - Name: ${name}, Date: ${date}, ClockIn: ${clockIn}, ClockOut: ${clockOut}`);

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

      console.log(`[UPSERT] Updating existing row #${rowIdx + 1} for ${name}`);
      await sheets.spreadsheets.values.update({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!C${rowIdx + 1}:G${rowIdx + 1}`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [valuesToUpdate]
        }
      });

      console.log(`[UPSERT SUCCESS] Updated row for ${name}`);
    } else {
      const newRow = [name, date, clockIn || "", clockOut || "", totalHours, "", ""];
      console.log(`[UPSERT] Appending new row: ${JSON.stringify(newRow)}`);

      await sheets.spreadsheets.values.append({
        spreadsheetId: SHEET_ID,
        range: `${sheetName}!A:G`,
        valueInputOption: "USER_ENTERED",
        requestBody: {
          values: [newRow]
        }
      });

      console.log(`[UPSERT SUCCESS] Appended row for ${name}`);
    }
  } catch (error) {
    console.error(`[UPSERT ERROR] Failed to upsert attendance for ${name} on ${date}:`, error.message, error.stack);
    throw new Error("Failed to save attendance record");
  }
}

// Get Attendance Records
async function getAttendance(name, startDate, endDate) {
  const sheetName = moment().tz(TIMEZONE).format("YYYY");
  
  try {
    await ensureSheetExists(sheetName);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`
    });

    const rows = result.data.values || [];
    const records = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row[0] || !row[1]) continue;

      const recordName = row[0].trim().toLowerCase();
      const recordDate = row[1].trim();
      
      // Filter by name if provided
      if (name && recordName !== name.toLowerCase()) continue;
      
      // Filter by date range
      const recordMoment = moment(recordDate, "MM/DD/YYYY", true);
      if (!recordMoment.isValid()) continue;
      
      const startMoment = moment(startDate, "MM/DD/YYYY", true);
      const endMoment = moment(endDate, "MM/DD/YYYY", true);
      
      if (startMoment.isValid() && recordMoment.isBefore(startMoment, 'day')) continue;
      if (endMoment.isValid() && recordMoment.isAfter(endMoment, 'day')) continue;

      records.push({
        name: row[0].trim(),
        date: recordDate,
        clockIn: row[2] || "-",
        clockOut: row[3] || "-",
        totalHours: row[4] || "-",
        overtimeHours: row[5] || "-",
        undertimeHours: row[6] || "-"
      });
    }

    return records;
  } catch (error) {
    console.error("Error getting attendance records:", error);
    throw new Error("Failed to fetch attendance records");
  }
}

// Get Today's Attendance Preview
async function getTodayAttendancePreview() {
  const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const sheetName = moment().tz(TIMEZONE).format("YYYY");

  try {
    await ensureSheetExists(sheetName);
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SHEET_ID,
      range: `${sheetName}!A:G`
    });

    const rows = result.data.values || [];
    const todayRows = rows.filter((row, idx) => idx > 0 && row[1]?.trim() === today);

    if (todayRows.length === 0) {
      return `\n\n📋 *Today's Attendance (${today}):*\nNo records yet.`;
    }

    let table = "\n\n📋 *Today's Attendance:*\n```\n";
    table += "Name         | In      | Out     | Hours\n";
    table += "-------------|---------|---------|------\n";
    
    todayRows.forEach(row => {
      const name = (row[0] || "").substring(0, 12);
      const clockIn = row[2] ? (moment(row[2], "h:mm A").isValid() ? moment(row[2], "h:mm A").format("h:mm A") : "-") : "-";
      const clockOut = row[3] ? (moment(row[3], "h:mm A").isValid() ? moment(row[3], "h:mm A").format("h:mm A") : "-") : "-";
      const hours = row[4] || "-";
      
      table += name.padEnd(13) + "| ";
      table += clockIn.padEnd(8) + "| ";
      table += clockOut.padEnd(8) + "| ";
      table += hours.padEnd(5) + "\n";
    });
    
    table += "```";
    return table;
  } catch (error) {
    console.error("Error getting today's attendance preview:", error);
    return "\n\n⚠️ Could not load today's attendance preview.";
  }
}

// ==== SLACK COMMAND ENDPOINTS ====

// /clockin Endpoint
app.post("/slack/command/clockin", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const response_url = req.body.response_url;
  
  // Immediate response to prevent timeout
  res.json({
    response_type: "ephemeral",
    text: "⏳ Processing your clock in request..."
  });

  // Process in background
  try {
    let clockIn = moment().tz(TIMEZONE).format("h:mm A");
    
    if (req.body.text) {
      const custom = getCustomTime(req.body.text);
      if (custom) {
        clockIn = custom;
      } else {
        await sendDelayedResponse(response_url, {
          response_type: "ephemeral",
          text: "⛔ Please enter time in a valid format:\n• `7:30 AM` or `7:30 PM`\n• `730 AM` or `730 PM`\n• `19:30` (24-hour format)\n• `7` (hour only)"
        });
        return;
      }
    }
    
    const name = await fetchSlackDisplayName(user_id);
    if (name === "Unknown") {
      await sendDelayedResponse(response_url, {
        response_type: "ephemeral",
        text: "⚠️ Could not fetch your user information. Please try again later."
      });
      return;
    }

    // Validate clock in action
    const validation = await validateClockAction(name, date, 'clockin', clockIn);
    if (!validation.valid) {
      await sendDelayedResponse(response_url, {
        response_type: "ephemeral",
        text: validation.message
      });
      return;
    }

    await upsertAttendance({ name, date, clockIn, clockOut: null });
    
    // Get today's attendance preview
    const attendancePreview = await getTodayAttendancePreview();
    
    await sendDelayedResponse(response_url, {
      response_type: "ephemeral",
      text: `✅ *Clocked in successfully!*\n👤 Name: *${name}*\n🕐 Time: *${clockIn}*\n📅 Date: ${date}${attendancePreview}`
    });
  } catch (error) {
    console.error("Clock in error:", error);
    await sendDelayedResponse(response_url, {
      response_type: "ephemeral",
      text: "⚠️ An error occurred while clocking in. Please try again later."
    });
  }
});

// /clockout Endpoint
app.post("/slack/command/clockout", async (req, res) => {
  const user_id = req.body.user_id;
  const date = moment().tz(TIMEZONE).format("MM/DD/YYYY");
  const response_url = req.body.response_url;
  
  // Immediate response to prevent timeout
  res.json({
    response_type: "ephemeral",
    text: "⏳ Processing your clock out request..."
  });

  // Process in background
  try {
    let clockOut = moment().tz(TIMEZONE).format("h:mm A");
    
    if (req.body.text) {
      const custom = getCustomTime(req.body.text);
      if (custom) {
        clockOut = custom;
      } else {
        await sendDelayedResponse(response_url, {
          response_type: "ephemeral",
          text: "⛔ Please enter time in a valid format:\n• `5:00 PM` or `5:00 AM`\n• `500 PM` or `500 AM`\n• `17:00` (24-hour format)\n• `5` (hour only)"
        });
        return;
      }
    }
    
    const name = await fetchSlackDisplayName(user_id);
    if (name === "Unknown") {
      await sendDelayedResponse(response_url, {
        response_type: "ephemeral",
        text: "⚠️ Could not fetch your user information. Please try again later."
      });
      return;
    }

    // Validate clock out action
    const validation = await validateClockAction(name, date, 'clockout', clockOut);
    if (!validation.valid) {
      await sendDelayedResponse(response_url, {
        response_type: "ephemeral",
        text: validation.message
      });
      return;
    }

    await upsertAttendance({ name, date, clockIn: null, clockOut });
    
    // Get today's attendance preview
    const attendancePreview = await getTodayAttendancePreview();
    
    await sendDelayedResponse(response_url, {
      response_type: "ephemeral",
      text: `✅ *Clocked out successfully!*\n👤 Name: *${name}*\n🕐 Time: *${clockOut}*\n📅 Date: ${date}${attendancePreview}`
    });
  } catch (error) {
    console.error("Clock out error:", error);
    await sendDelayedResponse(response_url, {
      response_type: "ephemeral",
      text: "⚠️ An error occurred while clocking out. Please try again later."
    });
  }
});

// /myattendance Endpoint
app.post("/slack/command/myattendance", async (req, res) => {
  try {
    const user_id = req.body.user_id;
    const name = await fetchSlackDisplayName(user_id);
    
    if (name === "Unknown") {
      return res.json({ 
        response_type: "ephemeral", 
        text: "⚠️ Could not fetch your user information. Please try again later." 
      });
    }

    let dateRange;
    if (req.body.text) {
      dateRange = parseDateRange(req.body.text.trim());
      if (!dateRange) {
        return res.json({ 
          response_type: "ephemeral", 
          text: "⛔ Invalid date format. Examples:\n• `05/22/2025` (specific date)\n• `today`, `yesterday`\n• `this week`, `last week`\n• `this month`\n• `01/01/2025 to 01/31/2025` (date range)" 
        });
      }
    } else {
      // Default to today
      const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
      dateRange = { startDate: today, endDate: today };
    }

    const records = await getAttendance(name, dateRange.startDate, dateRange.endDate);

    if (records.length === 0) {
      const dateText = dateRange.startDate === dateRange.endDate 
        ? dateRange.startDate 
        : `${dateRange.startDate} to ${dateRange.endDate}`;
      return res.json({ 
        response_type: "ephemeral", 
        text: `📋 No attendance found for *${name}* from ${dateText}.` 
      });
    }

    let response = `📋 *Attendance for ${name}:*\n\n`;
    records.forEach(record => {
      response += `📅 *${record.date}*\n`;
      response += `🕐 Clock In: *${record.clockIn}*\n`;
      response += `🕐 Clock Out: *${record.clockOut}*\n`;
      response += `⏱️ Total Hours: *${record.totalHours}*\n\n`;
    });

    res.json({
      response_type: "ephemeral",
      text: response.trim()
    });
  } catch (error) {
    console.error("myattendance error:", error);
    res.json({ 
      response_type: "ephemeral", 
      text: "⚠️ Error fetching attendance. Please try again later." 
    });
  }
});

// /viewattendance Endpoint
app.post("/slack/command/viewattendance", async (req, res) => {
  try {
    let dateRange;
    if (req.body.text) {
      dateRange = parseDateRange(req.body.text.trim());
      if (!dateRange) {
        return res.json({ 
          response_type: "ephemeral", 
          text: "⛔ Invalid date format. Examples:\n• `today`, `yesterday`\n• `this week`, `last week`\n• `05/22/2025` (specific date)\n• `01/01/2025 to 01/31/2025` (date range)" 
        });
      }
    } else {
      // Default to today
      const today = moment().tz(TIMEZONE).format("MM/DD/YYYY");
      dateRange = { startDate: today, endDate: today };
    }

    const records = await getAttendance(null, dateRange.startDate, dateRange.endDate);

    if (records.length === 0) {
      const dateText = dateRange.startDate === dateRange.endDate 
        ? dateRange.startDate 
        : `${dateRange.startDate} to ${dateRange.endDate}`;
      return res.json({
        response_type: "in_channel",
        text: `📋 No attendance records found for ${dateText}.`
      });
    }

    const dateText = dateRange.startDate === dateRange.endDate 
      ? dateRange.startDate 
      : `${dateRange.startDate} to ${dateRange.endDate}`;

    let table = "```\n";
    table += "Name         | Date     | In      | Out     | Hours\n";
    table += "-------------|----------|---------|---------|------\n";
    
    records.forEach(record => {
      const name = record.name.substring(0, 12);
      const date = record.date.substring(0, 8);
      const clockIn = record.clockIn === "-" ? "-" : moment(record.clockIn, "h:mm A").format("h:mm A");
      const clockOut = record.clockOut === "-" ? "-" : moment(record.clockOut, "h:mm A").format("h:mm A");
      const hours = record.totalHours;
      
      table += name.padEnd(13) + "| ";
      table += date.padEnd(9) + "| ";
      table += clockIn.padEnd(8) + "| ";
      table += clockOut.padEnd(8) + "| ";
      table += hours.padEnd(5) + "\n";
    });
    
    table += "```";

    res.json({
      response_type: "in_channel",
      text: `📋 *Attendance Report (${dateText}):*\n${table}`
    });
  } catch (error) {
    console.error("viewattendance error:", error);
    res.json({
      response_type: "ephemeral",
      text: "⚠️ Error fetching attendance. Please try again later."
    });
  }
});

// Holiday 
app.post("/slack/command/holidays", async (req, res) => {
  const response_url = req.body.response_url;
  
  // Immediate response to prevent timeout
  res.json({
    response_type: "in_channel",
    text: "📅 Loading holiday calendar..."
  });

  // Process in background with delayed response
  try {
    // Validate the image URL exists
    if (!process.env.HOLIDAY_IMAGE_URL) {
      await sendDelayedResponse(response_url, {
        response_type: "in_channel",
        text: "⚠️ Holiday calendar is not configured. Please contact admin."
      });
      return;
    }

    // Send blocks response with image
    await sendDelayedResponse(response_url, {
      response_type: "in_channel",
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: "📅 *Company Holidays*"
          }
        },
        {
          type: "image",
          image_url: process.env.HOLIDAY_IMAGE_URL,
          alt_text: "2025 Holiday Calendar - Green: Regular, Orange: Special"
        }
      ]
    });
  } catch (error) {
    console.error("Holidays command error:", error);
    await sendDelayedResponse(response_url, {
      response_type: "in_channel",
      text: "⚠️ Error loading holiday calendar. Please try again later."
    });
  }
});

// /help Command
app.post("/slack/command/help", async (req, res) => {
  const helpText = `🤖 *Attendance Bot Help*

*Clock In/Out Commands:*
• \`/clockin [time]\` — Clock in for the day
  Examples: \`/clockin\`, \`/clockin 8:00 AM\`, \`/clockin 8\`

• \`/clockout [time]\` — Clock out for the day
  Examples: \`/clockout\`, \`/clockout 5:00 PM\`, \`/clockout 17:00\`

*View Attendance:*
• \`/myattendance [date/range]\` — View your own attendance
  Examples: \`/myattendance\`, \`/myattendance today\`, \`/myattendance 05/22/2025\`

• \`/viewattendance [date/range]\` — View everyone's attendance
  Examples: \`/viewattendance\`, \`/viewattendance this week\`, \`/viewattendance 01/01/2025 to 01/31/2025\`

*Supported Time Formats:*
• \`8:30 AM\` or \`8:30 PM\` (12-hour with AM/PM)
• \`830 AM\` or \`830 PM\` (without colon)
• \`20:30\` or \`8:30\` (24-hour format)
• \`8\` (hour only, assumes :00 minutes)

*Supported Date Formats:*
• \`today\`, \`yesterday\`
• \`this week\`, \`last week\`, \`this month\`
• \`05/22/2025\` (MM/DD/YYYY)
• \`01/01/2025 to 01/31/2025\` (date ranges)

*New Features:*
- \`/holidays\` - View holiday schedule`;

  res.json({ response_type: "ephemeral", text: helpText });
});

// Home Route
app.get("/", (req, res) => {
  res.send("Attendance Bot running!");
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("Unhandled error:", error);
  res.status(500).json({
    response_type: "ephemeral",
    text: "⚠️ An unexpected error occurred. Please try again later."
  });
});

// Start Server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Attendance Bot running on port ${PORT}`);
});
