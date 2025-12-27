#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { fetchFactionNews } = require("./main"); // Your main script
const loanedFilePath = path.join(__dirname, "loaned_items.json");
const logsDir = path.join(__dirname, "logs");

// Ensure logs directory exists
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir);

// Parse optional date argument
const argDate = process.argv[2]; // YYYY-MM-DD
const targetDate = argDate ? new Date(argDate) : getYesterdayUTC();

const fromTimestamp = Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()) / 1000;
const toTimestamp = fromTimestamp + 86400; // 24 hours later

(async () => {
  try {
    const dailyData = await fetchFactionNews(fromTimestamp, toTimestamp);

    // Compute folder path
    const year = targetDate.getUTCFullYear();
    const month = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getUTCDate()).padStart(2, "0");

    const dayFolder = path.join(logsDir, `${year}`, `${month}`);
    if (!fs.existsSync(dayFolder)) fs.mkdirSync(dayFolder, { recursive: true });

    const filename = path.join(dayFolder, `${day}.json`);
    fs.writeFileSync(filename, JSON.stringify(dailyData, null, 2));
    console.log(`Saved daily log: ${filename}`);

    // Update loaned_items.json
    const loanedData = JSON.parse(fs.readFileSync(loanedFilePath, "utf-8"));
    updateLoanedItems(loanedData, dailyData);
    fs.writeFileSync(loanedFilePath, JSON.stringify(loanedData, null, 2));
    console.log("Updated loaned_items.json successfully.");
  } catch (err) {
    console.error("Error fetching or saving data:", err);
    process.exit(1);
  }
})();

// Helper to get yesterday in UTC
function getYesterdayUTC() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
}

// Helper to format YYYY-MM-DD
function formatDate(date) {
  return date.toISOString().split("T")[0];
}

/**
 * Updates loaned_items.json based on dailyData
 * - loaned_receive: add items to the receiver
 * - loaned: self-loans, track under their own log if needed
 * - returned: remove from current, push to history
 * - retrieved: forceful return, move to history
 */
function updateLoanedItems(loanedData, dailyData) {
  // Ensure the root structure exists
  if (!loanedData.current) loanedData.current = {};
  if (!loanedData.history) loanedData.history = {};

  for (const userId in dailyData) {
    const userEvents = dailyData[userId];

    // ---- Handle loaned_receive ----
    if (userEvents.loaned_receive) {
      for (const item in userEvents.loaned_receive) {
        if (!loanedData.current[userId]) loanedData.current[userId] = {};
        if (!loanedData.current[userId][item]) loanedData.current[userId][item] = [];

        for (const [amount, timestamp, initiator] of userEvents.loaned_receive[item]) {
          loanedData.current[userId][item].push([amount, timestamp, initiator]);
        }
      }
    }

    // ---- Handle returned ----
    if (userEvents.returned) {
      for (const item in userEvents.returned) {
        const returns = userEvents.returned[item];
        if (!loanedData.current[userId]) continue; // nothing to return

        if (!loanedData.current[userId][item]) continue; // edge case: returning unknown item

        for (const [amount, timestamp] of returns) {
          // Remove returned items from current, FIFO
          let remaining = amount;
          while (remaining > 0 && loanedData.current[userId][item].length > 0) {
            const entry = loanedData.current[userId][item][0];
            if (entry[0] > remaining) {
              entry[0] -= remaining;
              remaining = 0;
            } else {
              remaining -= entry[0];
              loanedData.current[userId][item].shift();
            }

            // Push to history
            if (!loanedData.history[userId]) loanedData.history[userId] = {};
            if (!loanedData.history[userId][item]) loanedData.history[userId][item] = [];
            loanedData.history[userId][item].push([...entry, timestamp]);
          }
        }

        // Cleanup empty arrays
        if (loanedData.current[userId][item].length === 0) {
          delete loanedData.current[userId][item];
        }
      }
    }

    // ---- Handle retrieved ----
    if (userEvents.retrieved) {
      for (const item in userEvents.retrieved) {
        if (!loanedData.current[userId]) continue;
        if (!loanedData.current[userId][item]) continue;

        for (const [amount, timestamp, initiator] of userEvents.retrieved[item]) {
          // Remove from current (like returned)
          let remaining = amount;
          while (remaining > 0 && loanedData.current[userId][item].length > 0) {
            const entry = loanedData.current[userId][item][0];
            if (entry[0] > remaining) {
              entry[0] -= remaining;
              remaining = 0;
            } else {
              remaining -= entry[0];
              loanedData.current[userId][item].shift();
            }

            // Push to history
            if (!loanedData.history[userId]) loanedData.history[userId] = {};
            if (!loanedData.history[userId][item]) loanedData.history[userId][item] = [];
            loanedData.history[userId][item].push([...entry, timestamp, initiator]);
          }
        }

        // Cleanup empty arrays
        if (loanedData.current[userId][item].length === 0) {
          delete loanedData.current[userId][item];
        }
      }
    }
  }
}

