#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch"); // Node 18+ has global fetch
const loanedFilePath = path.join(__dirname, "loaned_items.json");
const itemsFilePath = path.join(__dirname, "items.json");
const logsDir = path.join(__dirname, "logs");

// === CONFIG ===
const API_KEYS = ["TlLjcWRDbiY9wybA"]; // Add your API keys here
let keyIndex = 0;
const RATE_LIMIT_DELAY = 1000; // ms

// === UTILS ===
function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function parseUserIdFromHTML(html) {
  const match = html.match(/XID=(\d+)/);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// === FETCHING FUNCTION ===
async function fetchFactionNews(fromTimestamp, toTimestamp) {
  let allNews = [];
  let url = `https://api.torn.com/v2/faction/news?striptags=false&limit=100&sort=DESC&from=${fromTimestamp}&to=${toTimestamp}&cat=armoryAction&key=${API_KEYS[keyIndex]}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API request failed: ${res.status}`);
    const data = await res.json();
    allNews = allNews.concat(data.news);

    url = data._metadata?.links?.prev
      ? `${data._metadata.links.prev}&key=${API_KEYS[keyIndex]}`
      : null;

    await sleep(RATE_LIMIT_DELAY);
  }

  return allNews;
}

// === LOANED ITEMS UPDATE ===
function updateLoanedItems(loanedData, dailyData) {
  const OC_items = JSON.parse(fs.readFileSync(itemsFilePath, "utf-8")).OC_items;

  dailyData.forEach((event) => {
    const ts = event.timestamp;
    const text = event.text;

    // Extract all XIDs in the string
    const userIds = [...text.matchAll(/XID=(\d+)/g)].map((m) => m[1]);

    // Skip if no user found
    if (userIds.length === 0) return;

    // Parse each action type
    if (text.includes("deposited")) {
      const match = text.match(/deposited (\d+) x (.+)$/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        const uid = userIds[0];
        if (!loanedData.current[uid]) loanedData.current[uid] = {};
        if (!loanedData.current[uid][item]) loanedData.current[uid][item] = [];
        loanedData.current[uid][item].push([amount, ts]);
      }
    } else if (text.includes("used one of the faction")) {
      // handled in daily log, nothing for current loaned
    } else if (text.includes("filled one of the faction")) {
      // handled as "filled" in daily log
    } else if (text.includes("loaned") && text.includes("to themselves")) {
      // self-loaned
    } else if (text.includes("loaned")) {
      // loaned to another
      const amountMatch = text.match(/loaned (\d+)x (.+) to .+ from the faction armory/);
      if (amountMatch) {
        const amount = parseInt(amountMatch[1]);
        const item = amountMatch[2].trim();
        const initiator = userIds[0];
        const receiver = userIds[1];
        if (!loanedData.current[receiver]) loanedData.current[receiver] = {};
        if (!loanedData.current[receiver][item]) loanedData.current[receiver][item] = [];
        loanedData.current[receiver][item].push([amount, ts, initiator]);
      }
    } else if (text.includes("returned") || text.includes("retrieved")) {
      // remove from current if exists, move to history
      const match = text.match(/(\d+)x (.+)$/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        const uid = userIds[0];
        if (loanedData.current[uid]?.[item]) {
          // Remove from current
          loanedData.current[uid][item].shift();
          if (loanedData.current[uid][item].length === 0) delete loanedData.current[uid][item];
        }
        if (!loanedData.history[uid]) loanedData.history[uid] = {};
        if (!loanedData.history[uid][item]) loanedData.history[uid][item] = [];
        loanedData.history[uid][item].push([amount, ts, userIds[1] || null]);
      }
    }
  });
}

// === PARSING DAILY LOG ===
function parseDailyData(rawNews) {
  const OC_items = JSON.parse(fs.readFileSync(itemsFilePath, "utf-8")).OC_items;
  const dailyLog = {};

  rawNews.forEach((event) => {
    const ts = event.timestamp;
    const text = event.text;
    const userIds = [...text.matchAll(/XID=(\d+)/g)].map((m) => m[1]);
    if (userIds.length === 0) return;
    const uid = userIds[userIds.length - 1]; // last XID is usually the recipient/user

    if (!dailyLog[uid]) {
      dailyLog[uid] = {
        donated: {},
        used: {},
        filled: {},
        loaned: {},
        loaned_receive: {},
        returned: {},
        retrieved: {},
      };
    }

    const log = dailyLog[uid];

    if (text.includes("deposited")) {
      const match = text.match(/deposited (\d+) x (.+)$/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        if (!log.donated[item]) log.donated[item] = [];
        log.donated[item].push([amount, ts]);
      }
    } else if (text.includes("used one of the faction")) {
      const match = text.match(/used one of the faction's (.+) items/);
      if (match) {
        const item = match[1].trim();
        if (!log.used[item]) log.used[item] = [];
        log.used[item].push([1, ts]);
      }
    } else if (text.includes("filled one of the faction")) {
      const match = text.match(/filled one of the faction's (.+) items/);
      if (match) {
        const item = match[1].trim();
        if (!log.filled[item]) log.filled[item] = [];
        log.filled[item].push([1, ts]);
      }
    } else if (text.includes("loaned")) {
      const amountMatch = text.match(/loaned (\d+)x (.+) to .+ from the faction armory/);
      if (amountMatch) {
        const amount = parseInt(amountMatch[1]);
        const item = amountMatch[2].trim();
        const initiator = userIds[0];
        const receiver = userIds[1];
        if (receiver === initiator) {
          if (!log.loaned[item]) log.loaned[item] = [];
          log.loaned[item].push([amount, ts]);
        } else {
          if (!log.loaned_receive[item]) log.loaned_receive[item] = [];
          log.loaned_receive[item].push([amount, ts, initiator]);
        }
      }
    } else if (text.includes("returned")) {
      const match = text.match(/returned (\d+)x (.+)/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        if (!log.returned[item]) log.returned[item] = [];
        log.returned[item].push([amount, ts]);
      }
    } else if (text.includes("retrieved")) {
      const match = text.match(/retrieved (\d+)x (.+) from .+/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        const initiator = userIds[0];
        if (!log.retrieved[item]) log.retrieved[item] = [];
        log.retrieved[item].push([amount, ts, initiator]);
      }
    }
  });

  return dailyLog;
}

// === MAIN RUNTIME ===
(async () => {
  try {
    // Parse optional date argument
    const argDate = process.argv[2]; // YYYY-MM-DD
    const targetDate = argDate ? new Date(argDate) : getYesterdayUTC();

    const fromTimestamp = Date.UTC(targetDate.getUTCFullYear(), targetDate.getUTCMonth(), targetDate.getUTCDate()) / 1000;
    const toTimestamp = fromTimestamp + 86400; // 24 hours later

    const rawNews = await fetchFactionNews(fromTimestamp, toTimestamp);
    const dailyData = parseDailyData(rawNews);

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
    updateLoanedItems(loanedData, rawNews);
    fs.writeFileSync(loanedFilePath, JSON.stringify(loanedData, null, 2));
    console.log("Updated loaned_items.json successfully.");

  } catch (err) {
    console.error("Error fetching or saving data:", err);
    process.exit(1);
  }
})();
