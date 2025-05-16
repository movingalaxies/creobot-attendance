const express = require("express");
const bodyParser = require("body-parser");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Slack signing secret from your .env
const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;

// Middleware to parse urlencoded bodies
app.use(bodyParser.urlencoded({ extended: true }));

// Helper: verify Slack signature (for security, can skip in dev)
function verifySlackRequest(req) {
  const slackSignature = req.headers["x-slack-signature"];
  const requestBody = req.rawBody || "";
  const timestamp = req.headers["x-slack-request-timestamp"];

  const sigBasestring = "v0:" + timestamp + ":" + requestBody;
  const mySignature =
    "v0=" +
    crypto
      .createHmac("sha256", SLACK_SIGNING_SECRET)
      .update(sigBasestring, "utf8")
      .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(mySignature),
    Buffer.from(slackSignature)
  );
}

// Optionally, add a route for Slack slash commands
app.post("/slack/command/:command", (req, res) => {
  // If you want to check signature, use verifySlackRequest(req)
  const command = req.params.command;
  const user = req.body.user_name || req.body.user_id || "user";
  let textResponse = "";

  if (command === "clockin") {
    textResponse = `:white_check_mark: <@${user}> clocked in at ${new Date().toLocaleTimeString(
      "en-US",
      { timeZone: "Asia/Manila" }
    )}!`;
  } else if (command === "clockout") {
    textResponse = `:wave: <@${user}> clocked out at ${new Date().toLocaleTimeString(
      "en-US",
      { timeZone: "Asia/Manila" }
    )}!`;
  } else if (command === "help") {
    textResponse =
      "Commands: `/clockin` - Clock in. `/clockout` - Clock out. `/help` - Show help.";
  } else {
    textResponse = "Unknown command.";
  }

  // Respond to Slack (plain text)
  res.status(200).send(textResponse);
});

// Root endpoint (optional)
app.get("/", (req, res) => {
  res.send("CreoBot is alive! 🚀");
});

// Start the server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
