#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const fetch = global.fetch || require("node-fetch");
const { execSync } = require("child_process");

const loanedFilePath = path.join(process.cwd(), "loaned_items.json");
const logsDir = path.join(process.cwd(), "logs");

// === CONFIG ===
const API_KEYS = ["TlLjcWRDbiY9wybA"];
let keyIndex = 0;
const RATE_LIMIT_DELAY = 1000; // ms
const SaveFileAsRaw = false;

// === UTILS ===
function getYesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// === FETCH FACTION NEWS BY CATEGORY (RESTORED RAW & STRIPTAGS HANDLING) ===
async function fetchFactionNewsByCat(from, to, cat) {
  let allNews = [];
  let rawPages = [];

  let url =
    `https://api.torn.com/v2/faction/news` +
    `?striptags=false` +
    `&limit=100` +
    `&sort=DESC` +
    `&from=${from}` +
    `&to=${to}` +
    `&cat=${cat}` +
    `&key=${API_KEYS[keyIndex]}`;

  while (url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`API request failed: ${res.status}`);

    const data = await res.json();

    rawPages.push({
      category: cat,
      request_url: url,
      has_html: data.news?.[0]?.text?.includes("XID=") ?? false,
      news: data.news ?? [],
      _metadata: data._metadata ?? null,
    });

    allNews = allNews.concat(data.news ?? []);

    if (data._metadata?.links?.prev) {
      const prevUrl = new URL(data._metadata.links.prev);

      // Preserve striptags=false and API key
      [...prevUrl.searchParams.keys()]
        .filter(k => k.toLowerCase() === "striptags")
        .forEach(k => prevUrl.searchParams.delete(k));
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

// === FETCH ALL ARMORY DATA ===
async function fetchAllFactionNews(from, to) {
  const actions = await fetchFactionNewsByCat(from, to, "armoryAction");
  const deposits = await fetchFactionNewsByCat(from, to, "armoryDeposit");

  return {
    news: [...actions.news, ...deposits.news],
    rawPages: [...actions.rawPages, ...deposits.rawPages],
  };
}

// === PARSE DAILY DATA ===
function parseDailyData(rawNews) {
  const dailyLog = {};

  rawNews.forEach(event => {
    const ts = event.timestamp;
    const text = event.text;
    const userIds = [...text.matchAll(/XID=(\d+)/g)].map(m => m[1]);
    if (!userIds.length) return;

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
      const m = text.match(/deposited (\d+) x (.+)$/);
      if (m) {
        const amt = parseInt(m[1]);
        const item = m[2].trim();
        log.donated[item] ??= [];
        log.donated[item].push([amt, ts]);
      }
    }

    else if (text.includes("used one of the faction")) {
      const m = text.match(/used one of the faction's (.+) items/);
      if (m) {
        const item = m[1].trim();
        log.used[item] ??= [];
        log.used[item].push([1, ts]);
      }
    }

    else if (text.includes("filled one of the faction")) {
      const m = text.match(/filled one of the faction's (.+) items/);
      if (m) {
        const item = m[1].trim();
        log.filled[item] ??= [];
        log.filled[item].push([1, ts]);
      }
    }

    else if (text.includes("loaned")) {
      const m = text.match(/loaned (\d+)x (.+) to .+ from the faction armory/);
      if (m) {
        const amt = parseInt(m[1]);
        const item = m[2].trim();
        const initiator = userIds[0];
        const receiver = userIds[1];

        if (receiver === initiator) {
          log.loaned[item] ??= [];
          log.loaned[item].push([amt, ts]);
        } else {
          log.loaned_receive[item] ??= [];
          log.loaned_receive[item].push([amt, ts, initiator]);
        }
      }
    }

    else if (text.includes("returned")) {
      const m = text.match(/returned (\d+)x (.+)/);
      if (m) {
        const amt = parseInt(m[1]);
        const item = m[2].trim();
        log.returned[item] ??= [];
        log.returned[item].push([amt, ts]);
      }
    }

    else if (text.includes("retrieved")) {
      const m = text.match(/retrieved (\d+)x (.+) from .+/);
      if (m) {
        const amt = parseInt(m[1]);
        const item = m[2].trim();
        log.retrieved[item] ??= [];
        log.retrieved[item].push([amt, ts, userIds[0]]);
      }
    }
  });

  return dailyLog;
}

// === HELPER FUNCTIONS ===

// UPDATE LOANED ITEMS (simplified from NEW version)
function updateLoanedItems(dailyData) {
  let loaned = {};
  if (fs.existsSync(loanedFilePath)) {
    loaned = JSON.parse(fs.readFileSync(loanedFilePath));
  }

  for (const uid in dailyData) {
    const log = dailyData[uid];
    for (const [category] of [["loaned", log.loaned], ["loaned_receive", log.loaned_receive]]) {
      for (const item in log[category]) {
        log[category][item].forEach(entry => {
          const [amt, ts, from] = entry;
          loaned[item] ??= {};
          loaned[item][uid] ??= 0;
          loaned[item][uid] += amt;
        });
      }
    }
  }

  fs.writeFileSync(loanedFilePath, JSON.stringify(loaned, null, 2));
}

// === CHECK IF ALL DAYS EXIST ===
function allDaysExist(year, month) {
  const monthFolder = path.join(logsDir, `${year}`, month);
  if (!fs.existsSync(monthFolder)) return false;

  const lastDay = new Date(Date.UTC(year, parseInt(month), 0)).getUTCDate();
  for (let day = 1; day <= lastDay; day++) {
    const dayStr = String(day).padStart(2, "0");
    if (!fs.existsSync(path.join(monthFolder, `${dayStr}.json`))) return false;
  }
  return true;
}

// === MERGE MONTH LOGS (ONLY IF ALL DAYS EXIST) ===
function mergeMonthLogs(year, month) {
  if (!allDaysExist(year, month)) return;

  const monthFolder = path.join(logsDir, `${year}`, month);
  const monthFile = path.join(monthFolder, `Month.json`);
  const merged = {};

  const dailyFiles = fs.readdirSync(monthFolder)
    .filter(f => f.endsWith(".json") && f !== "Month.json" && !f.endsWith(".raw.json"));

  dailyFiles.forEach(file => {
    const dailyData = JSON.parse(fs.readFileSync(path.join(monthFolder, file)));
    for (const uid in dailyData) {
      if (!merged[uid]) merged[uid] = {
        donated: {},
        used: {},
        filled: {},
        loaned: {},
        loaned_receive: {},
        returned: {},
        retrieved: {},
      };
      const actions = ["donated", "used", "filled", "loaned", "loaned_receive", "returned", "retrieved"];
      actions.forEach(action => {
        for (const item in dailyData[uid][action]) {
          if (!merged[uid][action][item]) merged[uid][action][item] = [];
          merged[uid][action][item] = merged[uid][action][item].concat(dailyData[uid][action][item]);
        }
      });
    }
  });

  fs.writeFileSync(monthFile, JSON.stringify(merged, null, 2));
  console.log(`Created monthly summary: ${monthFile}`);
}

// === UPDATE INDEX.JSON (FROM PROJECT ROOT) ===
function updateIndexJson(year, month, day) {
  const indexPath = path.join(process.cwd(), "index.json");
  let index = {};
  if (fs.existsSync(indexPath)) {
    index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
  }

  index[year] ??= {};
  index[year][month] ??= [];

  if (!index[year][month].includes(day)) {
    index[year][month].push(day);
    index[year][month].sort((a, b) => a.localeCompare(b));
  }

  fs.writeFileSync(indexPath, JSON.stringify(index, null, 2));
  console.log(`Updated index.json for ${year}-${month}`);
}


// === COMMIT TO REPO ===
function commitLogsToRepo() {
  try {
    execSync(`git config --local user.email "action@github.com"`);
    execSync(`git config --local user.name "GitHub Action"`);

    execSync(`git add logs/ loaned_items.json index.json`);

    try {
      execSync(`git commit -m "Add/update daily log and index for ${new Date().toISOString().split("T")[0]}"`);
    } catch {
      console.log("No changes to commit.");
    }

    execSync(`git push`);
    console.log("Logs and index.json committed and pushed to repo.");
  } catch (err) {
    console.error("Error committing logs:", err);
  }
}

// === MAIN RUNTIME ===
(async () => {
  try {
    const argDate = process.argv[2];
    const targetDate = argDate ? new Date(argDate) : getYesterdayUTC();

    const fromTs = Date.UTC(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth(),
      targetDate.getUTCDate()
    ) / 1000;

    const toTs = fromTs + 86400;

    const { news, rawPages } = await fetchAllFactionNews(fromTs, toTs);

    const year = targetDate.getUTCFullYear();
    const month = String(targetDate.getUTCMonth() + 1).padStart(2, "0");
    const day = String(targetDate.getUTCDate()).padStart(2, "0");
    const dayFolder = path.join(logsDir, `${year}`, month);
    fs.mkdirSync(dayFolder, { recursive: true });

    if (SaveFileAsRaw) {
      fs.writeFileSync(
        path.join(dayFolder, `${day}.raw.json`),
        JSON.stringify({ from: fromTs, to: toTs, fetched_at: new Date().toISOString(), pages: rawPages }, null, 2)
      );
      console.log(`Saved raw log: ${dayFolder}/${day}.raw.json`);
    }

    const dailyData = parseDailyData(news);
    fs.writeFileSync(
      path.join(dayFolder, `${day}.json`),
      JSON.stringify(dailyData, null, 2)
    );

    console.log(`Saved daily log: ${year}/${month}/${day}.json`);

    updateLoanedItems(dailyData);
    mergeMonthLogs(year, month);
    updateIndexJson(year, month);
    commitLogsToRepo();

  } catch (err) {
    console.error("Runtime failed:", err);
    process.exit(1);
  }
})();
