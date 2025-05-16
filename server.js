const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");
const moment = require("moment-timezone");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage (resets on restart)
const attendanceRecords = {};
const ADMIN_USER_IDS = []; // Add your Slack User IDs for admin clear-all

const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// Middleware for Slack verification (raw body)
app.use((req, res, next) => {
  let data = "";
  req.on("data", chunk => { data += chunk; });
  req.on("end", () => {
    req.rawBody = data;
    next();
  });
});

// Needed for parsing Slack body
app.use(bodyParser.urlencoded({ extended: false }));

// Verify Slack requests
function verifySlackRequest(req, res, next) {
  const sig = req.headers["x-slack-signature"];
  const ts = req.headers["x-slack-request-timestamp"];
  if (!sig || !ts) return res.status(400).send("Bad request");
  if (Math.abs(Date.now() / 1000 - ts) > 60 * 5)
    return res.status(400).send("Ignore this request (timestamp).");

  const hmac = crypto.createHmac("sha256", SLACK_SIGNING_SECRET);
  const base = `v0:${ts}:${req.rawBody}`;
  hmac.update(base);
  const computed = hmac.digest("hex");
  if (`v0=${computed}` !== sig) return res.status(400).send("Verification failed");
  next();
}

// Helper to parse time input
function parseTime(str) {
  if (!str) return moment().tz("Asia/Manila").format("hh:mm A");
  let m = moment(str, ["h:mm A", "h:mm", "HHmm", "HH:mm"], true);
  if (!m.isValid()) return null;
  return m.format("hh:mm A");
}

// SLASH COMMAND ENDPOINT
app.post("/slack/command/:cmd", verifySlackRequest, (req, res) => {
  const { user_id, user_name, command, text } = req.body;
  const today = moment().tz("Asia/Manila").format("YYYY-MM-DD");
  const nowTime = moment().tz("Asia/Manila").format("hh:mm A");
  let resultMsg = "";

  // Always have a record list for this user
  if (!attendanceRecords[user_id]) attendanceRecords[user_id] = [];

  switch (req.params.cmd) {
    case "clockin": {
      let timeStr = text.trim();
      let time = timeStr ? parseTime(timeStr) : nowTime;
      if (!time) {
        resultMsg = ":warning: Invalid time format! Use `7:30 AM`, `0730`, etc.";
        break;
      }
      let record = attendanceRecords[user_id].find(r => r.date === today);
      if (record && record.clockIn) {
        resultMsg = `:warning: You already clocked in at *${record.clockIn}* today.`;
      } else {
        if (!record) {
          record = { date: today };
          attendanceRecords[user_id].push(record);
        }
        record.clockIn = time;
        resultMsg = `:white_check_mark: *Clocked in!* Time: *${time}* (${today})`;
      }
      break;
    }
    case "clockout": {
      let timeStr = text.trim();
      let time = timeStr ? parseTime(timeStr) : nowTime;
      if (!time) {
        resultMsg = ":warning: Invalid time format! Use `5:30 PM` or `1730` etc.";
        break;
      }
      let record = attendanceRecords[user_id].find(r => r.date === today);
      if (!record || !record.clockIn) {
        resultMsg = ":warning: You must clock in first today!";
      } else if (record.clockOut) {
        resultMsg = `:warning: You already clocked out at *${record.clockOut}* today.`;
      } else {
        record.clockOut = time;
        resultMsg = `:white_check_mark: *Clocked out!* Time: *${time}* (${today})`;
      }
      break;
    }
    case "viewattendance": {
      let out = "*Today's Attendance (Asia/Manila)*\n";
      let any = false;
      for (const [uid, recs] of Object.entries(attendanceRecords)) {
        let r = recs.find(r => r.date === today);
        if (r && (r.clockIn || r.clockOut)) {
          any = true;
          out += `• <@${uid}>: IN: *${r.clockIn || "-"}*, OUT: *${r.clockOut || "-"}*\n`;
        }
      }
      resultMsg = any ? out : "_No attendance data for today yet._";
      break;
    }
    case "manual": {
      // /manual YYYY-MM-DD 7:30 AM 5:00 PM
      let args = text.split(" ");
      if (args.length < 3) {
        resultMsg = ":information_source: Usage: `/manual YYYY-MM-DD 7:30 AM 5:00 PM`";
        break;
      }
      let date = args[0];
      let inTime = parseTime(args[1] + " " + (args[2] || ""));
      let outTime = args.length >= 5 ? parseTime(args[3] + " " + (args[4] || "")) : null;
      if (!moment(date, "YYYY-MM-DD", true).isValid()) {
        resultMsg = ":warning: Invalid date! Use YYYY-MM-DD.";
        break;
      }
      if (!inTime) {
        resultMsg = ":warning: Invalid clock-in time!";
        break;
      }
      let record = attendanceRecords[user_id].find(r => r.date === date);
      if (!record) {
        record = { date };
        attendanceRecords[user_id].push(record);
      }
      record.clockIn = inTime;
      if (outTime) record.clockOut = outTime;
      resultMsg = `:white_check_mark: *Manual attendance set for ${date}.* IN: *${inTime}*${outTime ? `, OUT: *${outTime}*` : ""}`;
      break;
    }
    case "manualedit": {
      // /manualedit YYYY-MM-DD 8:00 AM 6:15 PM
      let args = text.split(" ");
      if (args.length < 3) {
        resultMsg = ":information_source: Usage: `/manualedit YYYY-MM-DD 8:00 AM 6:15 PM`";
        break;
      }
      let date = args[0];
      let inTime = parseTime(args[1] + " " + (args[2] || ""));
      let outTime = args.length >= 5 ? parseTime(args[3] + " " + (args[4] || "")) : null;
      if (!moment(date, "YYYY-MM-DD", true).isValid()) {
        resultMsg = ":warning: Invalid date! Use YYYY-MM-DD.";
        break;
      }
      let record = attendanceRecords[user_id].find(r => r.date === date);
      if (!record) {
        resultMsg = `:warning: No record for that date. Use /manual to add it.`;
        break;
      }
      if (inTime) record.clockIn = inTime;
      if (outTime) record.clockOut = outTime;
      resultMsg = `:white_check_mark: *Edited record for ${date}.* IN: *${record.clockIn}*${outTime ? `, OUT: *${record.clockOut}*` : ""}`;
      break;
    }
    case "clear": {
      if (ADMIN_USER_IDS.includes(user_id)) {
        Object.keys(attendanceRecords).forEach(uid => {
          attendanceRecords[uid] = [];
        });
        resultMsg = ":boom: *Cleared ALL attendance records!*";
      } else {
        attendanceRecords[user_id] = [];
        resultMsg = ":white_check_mark: *Your attendance records have been cleared!*";
      }
      break;
    }
    case "help":
    default: {
      resultMsg =
        "*CreoBot Attendance - Commands:*\n" +
        "• `/clockin [7:30 AM]` — Clock in (now or specific time)\n" +
        "• `/clockout [5:15 PM]` — Clock out (now or specific time)\n" +
        "• `/viewattendance` — See today’s clock-in/out for everyone\n" +
        "• `/manual YYYY-MM-DD IN OUT` — Manually set times for a date\n" +
        "• `/manualedit YYYY-MM-DD IN OUT` — Edit an existing record\n" +
        "• `/clear` — Clear your records (admin: clears all)\n" +
        "• `/help` — Show this help message\n" +
        "_Time zone: Asia/Manila_\n";
      break;
    }
  }
  res.json({ response_type: "in_channel", text: resultMsg });
});

app.get("/", (req, res) =>
  res.send("CreoBot for Slack is running! 🚀")
);

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});
