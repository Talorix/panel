const express = require("express");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const config = require("./config.json");
const unsqh = require("./modules/db.js");
const DBStore = require("./modules/db-session.js");
const Logger = require("./modules/logger.js");
// --- WebSocket support ---
const expressWs = require("express-ws");

const PORT = config.port;
const app = express();

// --- Initialize express-ws
expressWs(app);

// --- Settings ---
const currentSettings = unsqh.get("settings", "app") || {};
const newSettings = {
  name: currentSettings.name || config.name,
  port: currentSettings.port || config.port,
};
unsqh.put("settings", "app", newSettings);

const sessionMiddleware = session({
  name: "sid",
  store: new DBStore({ table: "sessions" }),
  secret: config.session_secret,
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
  res.locals.req = req;
  next();
});

app.use((req, res, next) => {
  res.setHeader("X-Powered-By", "Hydren || Talorix");
  next();
});

const consoleWS = require("./modules/websocket.js");
consoleWS(app);
// --- Load backend routes ---
const routeFiles = fs
  .readdirSync("./backend")
  .filter((file) => file.endsWith(".js"));

for (const file of routeFiles) {
  const routeModule = require(path.join(__dirname, "backend", file));
  const router = routeModule;
  app.use("/", router);
}

// --- 404 handler ---
app.use(async (req, res) => {
  res.status(404).render("404", {
    req,
    name: config.name,
  });
});
let version;

async function getVersion() {
  const res = await fetch("https://ma4z.is-a.dev/repo/version_library.json");
  const data = await res.json();
  version = data["hydren:sr"]["talorix"]["panel"];
  const ascii = `
 _____     _            _      
|_   _|_ _| | ___  _ __(_)_  __
  | |/ _\` | |/ _ \\| '__| \\ \\/ /
  | | (_| | | (_) | |  | |>  <    ${version}
  |_|\\__,_|_|\\___/|_|  |_/_/\\_\\
`;
  const gray = '\x1b[90m'
  const reset = '\x1b[0m'; 
  const asciiWithColor = ascii.replace(version, reset + version + gray);
  console.log(gray + asciiWithColor + reset);
  return;
}

async function startApp() {
  await getVersion();
  app.listen(PORT, () => {
    Logger.success(`Talorix have started on the port ${PORT}`);
  });
}

startApp();
