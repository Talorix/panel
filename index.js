const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const config = require("./config.json");
const unsqh = require("./modules/db.js");
const DBStore = require("./modules/db-session.js");
const Logger = require("./modules/logger.js");
const crypto = require("crypto");
// --- WebSocket support ---
const expressWs = require("express-ws");

const PORT = config.configuration.port;
const app = express();

// --- Initialize express-ws
expressWs(app);

// --- Settings ---
const currentSettings = unsqh.get("settings", "app") || {};
const newSettings = {
  name: currentSettings.name || config.configuration.name,
  registerEnabled:
    currentSettings.registerEnabled !== undefined
      ? currentSettings.registerEnabled
      : false,
  port: currentSettings.port || config.configuration.port,
};
unsqh.put("settings", "app", newSettings);

const sessionMiddleware = session({
  name: "sid",
  store: new DBStore({ table: "sessions" }),
  secret: config.website.session_secret,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
  },
});

app.use(sessionMiddleware);

// --- Express setup ---
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "/frontend"));
app.use(express.static(path.join(__dirname, "public")));
app.use((req, res, next) => {
  res.locals.config = config;
  res.locals.crypto = crypto;
  res.locals.req = req;
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "Hydren || Talorix");
  next();
});

const consoleWS = require("./modules/websocket.js");
consoleWS(app);

const consoleWSAPI = require("./api/v1_ws.js");
consoleWSAPI(app);

const apirouter = require("./api/v1.js");
app.use("/", apirouter);
// --- Load backend routes ---
const routeFiles = fs
  .readdirSync("./backend")
  .filter((file) => file.endsWith(".js"));

for (const file of routeFiles) {
  const Module = path.join(__dirname, "backend", file);
  const routeModule = require(Module);
  const router = routeModule;
  app.use("/", router);
}

// --- 404 handler ---
app.use(async (req, res) => {
  res.status(404).render("404", {
    req,
    name: config.configuration.name,
  });
});
let version;

async function getVersion() {
  version = `\x1b[36m${config.dev.version}\x1b[0m`;
  const ascii = ` _____     _            _      
|_   _|_ _| | ___  _ __(_)_  __
  | |/ _\` | |/ _ \\| '__| \\ \\/ /
  | | (_| | | (_) | |  | |>  <    ${version}
  |_|\\__,_|_|\\___/|_|  |_/_/\\_\\

Copyright © %s ma4z and contributers

Website:  https://talorix.io
Source:   https://github.com/talorix/panel
`;
  const gray = "\x1b[90m";
  const reset = "\x1b[0m";
  const asciiWithColor = ascii.replace(version, reset + version + gray);
  console.log(gray + asciiWithColor + reset, new Date().getFullYear());
  return;
}

async function start() {
  await getVersion();
  app.listen(PORT, () => {
    Logger.success(`Talorix have started on the port http://localhost:${PORT}`);
  });
}

app.use(async (err, req, res, next) => {
  res.status(500).render("500", {
    req,
    name: config.configuration.name,
    message: err.message, 
    stack: config.dev.MODE === "development" ? err.stack : null
  });
});

start();

if (config.dev.MODE === "development") {
  setTimeout(() => {
    Logger.warn(
      "Running in development mode may have some bugs. If you find any, please create an issue at https://github.com/Talorix/panel/issues"
    );
  }, 1500);
}
