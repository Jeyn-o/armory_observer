import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const DATA_DIR = "./data";
const DAY_DIR = `${DATA_DIR}/days`;
const LOANS_FILE = `${DATA_DIR}/loaned_items.json`;

const API_KEYS = {
  "TlLjcWRDbiY9wybA"
};
let keyIndex = 0;

function getKey() {
  const key = API_KEYS[keyIndex];
  keyIndex = (keyIndex + 1) % API_KEYS.length;
  return key;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function utcDayBounds(dateStr) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  const from = Math.floor(d.getTime() / 1000);
  const to = from + 86400;
  return { from, to };
}

function ensureDirs() {
  fs.mkdirSync(DAY_DIR, { recursive: true });
  if (!fs.existsSync(LOANS_FILE)) {
    fs.writeFileSync(LOANS_FILE, JSON.stringify({ active: {}, history: {} }, null, 2));
  }
}

function extractUsers(html) {
  const matches = [...html.matchAll(/XID=(\d+)/g)].map(m => m[1]);
  return [...new Set(matches)];
}

function pushEvent(obj, category, item, entry) {
  obj[category] ??= {};
  obj[category][item] ??= [];
  obj[category][item].push(entry);
}

function parseEntry(text, timestamp) {
  const users = extractUsers(text);
  const initiator = users[0];
  const target = users[1] || users[0];

  const amountMatch = text.match(/(\d+)x/);
  const amount = amountMatch ? Number(amountMatch[1]) : 1;

  const itemMatch = text.match(/x ([^<]+?) to|x ([^<]+?) from|x ([^<]+?)$/);
  const item = itemMatch?.[1] || itemMatch?.[2] || itemMatch?.[3] || null;

  if (!item) return null;

  if (text.includes("used one of")) {
    return { user: initiator, cat: "used", item, entry: [1, timestamp] };
  }

  if (text.includes("filled one of")) {
    return { user: initiator, cat: "filled", item: "Empty Blood Bag", entry: [1, timestamp] };
  }

  if (text.includes("deposited")) {
    return { user: initiator, cat: "deposited", item, entry: [amount, timestamp] };
  }

  if (text.includes("loaned") && text.includes("to themselves")) {
    return { user: initiator, cat: "loaned", item, entry: [amount, timestamp] };
  }

  if (text.includes("loaned")) {
    return { user: target, cat: "loaned_receive", item, entry: [amount, timestamp, Number(initiator)] };
  }

  if (text.includes("returned")) {
    return { user: initiator, cat: "returned", item, entry: [amount, timestamp] };
  }

  if (text.includes("retrieved")) {
    return { user: target, cat: "retrieved", item, entry: [amount, timestamp, Number(initiator)] };
  }

  if (text.includes("gave")) {
    return { user: target, cat: "given", item, entry: [amount, timestamp, Number(initiator)] };
  }

  return null;
}

async function fetchAll(from, to) {
  let url = `https://api.torn.com/v2/faction/news?cat=armoryAction&limit=100&sort=DESC&from=${from}&to=${to}&key=${getKey()}`;
  let all = [];

  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    all.push(...json.news);
    url = json._metadata?.links?.prev;
    if (url) {
      url += `&key=${getKey()}`;
      await sleep(1200);
    }
  }
  return all;
}

async function run() {
  ensureDirs();

  const date = process.argv[2] || new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const { from, to } = utcDayBounds(date);

  const news = await fetchAll(from, to);

  const result = {
    meta: { date, from, to, generated_at: Math.floor(Date.now() / 1000) },
    users: {}
  };

  for (const n of news) {
    const parsed = parseEntry(n.text, n.timestamp);
    if (!parsed) continue;

    const { user, cat, item, entry } = parsed;
    result.users[user] ??= {};
    pushEvent(result.users[user], cat, item, entry);
  }

  fs.writeFileSync(`${DAY_DIR}/${date}.json`, JSON.stringify(result, null, 2));
  console.log(`✔ Saved ${date}`);
}

run().catch(e => {
  console.error(e);
  process.exit(1);
});
