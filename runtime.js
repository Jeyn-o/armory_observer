#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const { execSync } = require("child_process");

const loanedFilePath = path.join(process.cwd(), "loaned_items.json");
const itemsFilePath = path.join(process.cwd(), "items.json");
const logsDir = path.join(process.cwd(), "logs");

// === CONFIG ===
const API_KEYS = ["TlLjcWRDbiY9wybA"]; // Replace with your actual API keys
let keyIndex = 0;
const RATE_LIMIT_DELAY = 500; // ms

// === UTILS ===
function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// === FETCH FACTION NEWS (WITH RAW PAGES) ===
async function fetchFactionNews(fromTimestamp, toTimestamp) {
  let allNews = [];
  let rawPages = [];

  let url =
    `https://api.torn.com/v2/faction/news` +
    `?striptags=false` +
    `&limit=100` +
    `&sort=DESC` +
    `&from=${fromTimestamp}` +
    `&to=${toTimestamp}` +
    `&cat=armoryAction` +
    `&key=${API_KEYS[keyIndex]}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API request failed: ${res.status}`);

    const data = await res.json();

    rawPages.push({
      request_url: url,
      has_html: data.news?.[0]?.text?.includes("XID=") ?? false,
      news: data.news ?? [],
      _metadata: data._metadata ?? null,
    });

    allNews = allNews.concat(data.news ?? []);

    if (data._metadata?.links?.prev) {
      // Parse the prev URL
      const prevUrl = new URL(data._metadata.links.prev);
      // Remove any existing striptags param
      prevUrl.searchParams.delete("striptags");
      // Force striptags=false and re-add API key
      prevUrl.searchParams.set("striptags", "false");
      prevUrl.searchParams.set("key", API_KEYS[keyIndex]);
      url = prevUrl.toString();
      await sleep(RATE_LIMIT_DELAY);
    } else {
      url = null;
    }
  }

  return { news: allNews, rawPages };
}


// === UPDATE LOANED ITEMS ===
function updateLoanedItems(loanedData, dailyData) {
  dailyData.forEach((event) => {
    const ts = event.timestamp;
    const text = event.text;
    const userIds = [...text.matchAll(/XID=(\d+)/g)].map((m) => m[1]);
    if (userIds.length === 0) return;

    // Deposits
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
    }
    // Loaned to others
    else if (text.includes("loaned") && !text.includes("to themselves")) {
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
    }
    // Returned or retrieved
    else if (text.includes("returned") || text.includes("retrieved")) {
      const match = text.match(/(\d+)x (.+)/);
      if (match) {
        const amount = parseInt(match[1]);
        const item = match[2].trim();
        const uid = userIds[0];

        if (loanedData.current[uid]?.[item]) {
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

// === PARSE DAILY DATA ===
function parseDailyData(rawNews) {
  const dailyLog = {};

  rawNews.forEach((event) => {
    const ts = event.timestamp;
    const text = event.text;
    const userIds = [...text.matchAll(/XID=(\d+)/g)].map((m) => m[1]);
    if (userIds.length === 0) return;
    const uid = userIds[userIds.length - 1];

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

// === COMMIT TO REPO ===
function commitLogsToRepo() {
  try {
    execSync(`git config --local user.email "action@github.com"`);
    execSync(`git config --local user.name "GitHub Action"`);
    execSync(`git add logs/ loaned_items.json`);
    try {
      execSync(`git commit -m "Add daily log for ${new Date().toISOString().split("T")[0]}"`);
    } catch {
      console.log("No changes to commit.");
    }
    execSync(`git push`);
    console.log("Logs committed and pushed to repo.");
  } catch (err) {
    console.error("Error committing logs:", err);
  }
}

// === MAIN RUNTIME ===
(async () => {
  try {
    const argDate = process.argv[2];
    const targetDate = argDate ? new Date(argDate) : getYesterdayUTC();

    const fromTimestamp =
      Date.UTC(
        targetDate.getUTCFullYear(),
        targetDate.getUTCMonth(),
        targetDate.getUTCDate()
      ) / 1000;
    const toTimestamp = fromTimestamp + 86400;

    const { news, rawPages } = await fetchFactionNews(fromTimestamp, toTimestamp);

    // Folder path
    const year = targetDate.getUTCFullYear();
    const month = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getUTCDate()).padStart(2, "0");
    const dayFolder = path.join(logsDir, `${year}`, `${month}`);
    if (!fs.existsSync(dayFolder)) fs.mkdirSync(dayFolder, { recursive: true });

    // Save RAW dump
    const rawDump = {
      from: fromTimestamp,
      to: toTimestamp,
      fetched_at: new Date().toISOString(),
      pages: rawPages,
    };

    const rawFilename = path.join(dayFolder, `${day}.raw.json`);
    fs.writeFileSync(rawFilename, JSON.stringify(rawDump, null, 2));
    console.log(`Saved raw log: ${rawFilename}`);

    // Parse & save processed data
    const dailyData = parseDailyData(news);
    const filename = path.join(dayFolder, `${day}.json`);
    fs.writeFileSync(filename, JSON.stringify(dailyData, null, 2));
    console.log(`Saved daily log: ${filename}`);

    const loanedData = JSON.parse(fs.readFileSync(loanedFilePath, "utf-8"));
    updateLoanedItems(loanedData, news);
    fs.writeFileSync(loanedFilePath, JSON.stringify(loanedData, null, 2));
    console.log("Updated loaned_items.json successfully.");

    // Commit and push
    commitLogsToRepo();
  } catch (err) {
    console.error("Error fetching or saving data:", err);
    process.exit(1);
  }
})();
