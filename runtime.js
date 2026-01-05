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

// === FETCH FACTION NEWS BY CATEGORY ===
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
      news: data.news ?? [],
      _metadata: data._metadata ?? null,
    });

    allNews = allNews.concat(data.news ?? []);

    if (data._metadata?.links?.prev) {
      const prevUrl = new URL(data._metadata.links.prev);
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
        JSON.stringify({ from: fromTs, to: toTs, pages: rawPages }, null, 2)
      );
    }

    const dailyData = parseDailyData(news);
    fs.writeFileSync(
      path.join(dayFolder, `${day}.json`),
      JSON.stringify(dailyData, null, 2)
    );

    console.log(`Saved daily log: ${year}/${month}/${day}.json`);

    execSync(`git add logs/ index.json loaned_items.json`);
    try {
      execSync(`git commit -m "Add daily log ${year}-${month}-${day}"`);
    } catch {}
    execSync(`git push`);

  } catch (err) {
    console.error("Runtime failed:", err);
    process.exit(1);
  }
})();
