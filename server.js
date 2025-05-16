const express = require('express');
const bodyParser = require('body-parser');
const moment = require('moment-timezone');

const app = express();
const PORT = process.env.PORT || 3000;
const TIMEZONE = 'Asia/Manila';

app.use(bodyParser.urlencoded({ extended: true }));

// In-memory store for attendance (reset on restart)
const attendance = {};

// Helper: format time
function formatTime(time) {
  return moment(time, "h:mm A").isValid()
    ? moment(time, "h:mm A").format("h:mm A")
    : time;
}

// Helper: get now in Manila
function nowInManila() {
  return moment().tz(TIMEZONE).format("h:mm A");
}

// Main endpoint for Slack commands
app.post("/slack/command/:command", (req, res) => {
  const { command: cmd } = req.params;
  const userId = req.body.user_id || req.body.user_name;
  const userName = req.body.user_name || userId;
  const text = req.body.text ? req.body.text.trim() : '';
  let response = '';

  if (cmd === "clockin") {
    const clockInTime = text ? formatTime(text) : nowInManila();
    if (!attendance[userId]) attendance[userId] = {};
    if (attendance[userId].clockIn) {
      response = `:warning: <@${userId}> already clocked in at ${attendance[userId].clockIn}.`;
    } else {
      attendance[userId].clockIn = clockInTime;
      response = `:white_check_mark: <@${userId}> clocked in at ${clockInTime}.`;
    }
  } else if (cmd === "clockout") {
    const clockOutTime = text ? formatTime(text) : nowInManila();
    if (!attendance[userId] || !attendance[userId].clockIn) {
      response = `:warning: <@${userId}> hasn't clocked in yet.`;
    } else if (attendance[userId].clockOut) {
      response = `:warning: <@${userId}> already clocked out at ${attendance[userId].clockOut}.`;
    } else {
      attendance[userId].clockOut = clockOutTime;
      response = `:wave: <@${userId}> clocked out at ${clockOutTime}.`;
    }
  } else if (cmd === "help") {
    response = [
      "*CreoBot Attendance Commands:*",
      "`/clockin [time]` – Clock in now or at a specified time (e.g., `/clockin 7:30 AM`).",
      "`/clockout [time]` – Clock out now or at a specified time (e.g., `/clockout 6:00 PM`).",
      "`/help` – Show this help message.",
      "_Note: This version only stores today’s data while the bot is running._"
    ].join('\n');
  } else {
    response = ":grey_question: Unknown command. Try `/help` for usage.";
  }

  res.status(200).send(response);
});

// Test endpoint
app.get("/", (req, res) => {
  res.send("CreoBot for Slack is running! 🚀");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
