const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config.json");

const DB_FILE = path.resolve("./database.unsqh");
const AES_ALGO = "aes-256-gcm";

const MASTER_PASSWORD = config.database.password;

function fail(reason) {
  throw new Error(`[UNSQH SECURITY ERROR] ${reason}`);
}

function validatePassword(pw) {
  if (!pw) fail("No password provided. Set DataBase password in config.json.");

  if (pw.length < 12)
    fail("database password must be at least 12 characters long.");

  if (/^(.)\1+$/.test(pw))
    fail("database Password cannot be the same repeated character.");

  if (!/[a-z]/.test(pw))
    fail("database Password must contain at least one lowercase letter.");

  if (!/[A-Z]/.test(pw))
    fail("database Password must contain at least one uppercase letter.");

  if (!/[0-9]/.test(pw))
    fail("database Password must contain at least one number.");

  if (!/[^a-zA-Z0-9]/.test(pw))
    fail("database Password must contain at least one special symbol.");

  const uniqueCount = new Set(pw.split("")).size;
  if (uniqueCount < pw.length / 3)
    fail("Password has low entropy (too many repeating characters).");

  return true;
}

// Validate password first
validatePassword(MASTER_PASSWORD);

// Then derive the key
const KEY = crypto.scryptSync(MASTER_PASSWORD, "unsqh-salt", 32);

function loadDB() {
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), "utf8");
}

function encryptObject(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(AES_ALGO, KEY, iv);

  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const encrypted = Buffer.concat([cipher.update(json), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString("base64"),
    data: encrypted.toString("base64"),
    tag: tag.toString("base64")
  };
}

function decryptObject(enc) {
  try {
    const iv = Buffer.from(enc.iv, "base64");
    const data = Buffer.from(enc.data, "base64");
    const tag = Buffer.from(enc.tag, "base64");

    const decipher = crypto.createDecipheriv(AES_ALGO, KEY, iv);
    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch {
    return null;
  }
}

const unsqh = {
  put(table, id, object) {
    if (!table || !id) throw new Error("table & id required");

    const db = loadDB();

    if (!db[table]) db[table] = {};

    db[table][id] = encryptObject(object);

    saveDB(db);
    return true;
  },

  get(table, id) {
    const db = loadDB();
    if (!db[table] || !db[table][id]) return null;
    return decryptObject(db[table][id]);
  },

  delete(table, id) {
    const db = loadDB();
    if (!db[table] || !db[table][id]) return false;

    delete db[table][id];
    saveDB(db);
    return true;
  },

  list(table) {
    const db = loadDB();
    if (!db[table]) return [];

    return Object.entries(db[table]).map(([id, blob]) => {
      const obj = decryptObject(blob);
      return { id, ...obj };
    });
  },

  update(table, id, patch) {
    const existing = this.get(table, id);
    if (!existing) throw new Error("not found");
    const merged = { ...existing, ...patch };
    return this.put(table, id, merged);
  },

  query(table, filterFn) {
    if (typeof filterFn !== "function") throw new Error("filter must be a function");

    const items = this.list(table);
    return items.filter(filterFn);
  }
};

module.exports = unsqh;
