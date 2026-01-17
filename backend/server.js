const express = require("express");
const router = express.Router();
const unsqh = require("../modules/db.js");
const axios = require("axios");
const multer = require("multer");
const upload = multer();
/* =========================
   MIDDLEWARE
========================= */
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

/* =========================
   HELPERS
========================= */
function _makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function getServerForUser(userId, serverId) {
  const user = unsqh.get("users", userId);
  if (!user) return null;

  // First, try to find the server in the user's own server list
  const found = user.servers?.find((s) => s.id === serverId);
  if (found) return found;

  // Admin bypass: if the user is an admin (user.admin === true), allow access
  // to the global server record even if it's not listed in user.servers.
  if (user.admin) {
    const adminServer = unsqh.get("servers", serverId);
    if (adminServer) return adminServer;
  }

  return null;
}

function getNodeUrl(node) {
  return `http://${node.ip}:${node.port}`;
}

function withServer(req, res, next) {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.redirect("/dashboard?error=NOTFOUND");
  if (server.suspended) return res.redirect("/dashboard?error=SUSPENDED");
  next();
}

/**
 * Create a new file on a server node
 * @param {Object} server - The server object
 * @param {Object} node - The node object
 * @param {string} filename - Name of the file to create
 * @param {string} content - Content of the file
 * @param {string} pathQuery - Path on the server where file should be created (default "/")
 */
async function createFileOnServer(server, node, filename, content, pathQuery = "/") {
  if (!server) throw new Error("Server not provided");
  if (!node) throw new Error("Node not provided");
  if (!filename) throw new Error("Filename required");

  const response = await axios.post(
    `${getNodeUrl(node)}/server/fs/${server.idt}/file/new`,
    { filename, content },
    { params: { path: pathQuery, key: node.key } }
  );

  return response.data;
}

/* =========================
   PANEL FILE ROUTES
========================= */

/**
 * GET /server/manage/:id
 * Render server management page for a single server
 */
router.get("/server/manage/:id", requireAuth, withServer, async (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  const image = unsqh.get("images", server.imageId);
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  if (!server.node) {
    return res.render("server/manage", {
      name: appName,
      user,
      server,
      image,
    });
  }

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  let state = null;

  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/${server.idt}/state`,
      { params: { key: node.key } }
    );
    state = response.data.state;
  } catch (err) {
    state = "running";
  }

  if (state === 'installing') {
    return res.redirect('/server/installing/' + server.id);
  }

  res.render("server/manage", {
    name: appName,
    user,
    server,
    image,
  });
});

/**
 * GET /server/installing/:id
 * Render server installing page for a single server
 */
router.get("/server/installing/:id", requireAuth, withServer, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  res.render("server/installing", {
    name: appName,
    user,
    server,
  });
});

/**
 * GET /server/state/:id
 * gets the server current state
 */
router.get("/server/state/:id", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");
  if (!server.node) return res.status(500).send("Server node not assigned");
  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  let state = null;
  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/${server.idt}/state`,
      { params: { key: node.key } }
    );
    state = response.data.state;
  } catch (err) {
    state = "running";
  }
  res.json({ state });
});
/**
 * POST /server/size/:id
 * gets the total server size
 */
router.post("/server/size/:id", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");
  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");
  let size;
  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/fs/${server.idt}/size`,
      { params: { key: node.key } }
    );
    size = response.data.total;
  } catch (err) {
    size = 0;
  }

  res.json({ size });
});

/**
 * POST /server/features/:id/eula/accept
 * Creates eula.txt with content "eula=true"
 */
router.post("/server/features/:id/eula/accept", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");
  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");

  try {
    await createFileOnServer(server, node, "eula.txt", "eula=true");
    logAdd(req.session.userId, `Accepted EULA`);
    res.send({ success: true, message: "EULA accepted" });
  } catch (err) {
    console.error(err);
    res.status(500).send({ success: false, message: "Failed to create EULA file" });
  }
});

/**
 * GET /server/features/:id/eula/currentState
 * Returns whether EULA is accepted (true/false)
 */
router.get(
  "/server/features/:id/eula/currentState",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send({ success: false, message: "Server not found" });
    if (!server.node) return res.status(500).send({ success: false, message: "Server node not assigned" });

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send({ success: false, message: "Node not found" });

    try {
      const response = await axios.get(
        `${getNodeUrl(node)}/server/fs/${server.idt}/file/content`,
        {
          params: { location: "eula.txt", key: node.key },
        }
      );
      const content = response.data?.content || "";
      const accepted = content.trim().toLowerCase() === "eula=true";

      res.json({ success: true, eulaAccepted: accepted });
    } catch (err) {
      // Node responded (online) but file doesn't exist
      if (err.response) {
        // 404 = eula.txt missing → not accepted yet
        if (err.response.status === 404) {
          return res.json({
            success: true,
            eulaAccepted: false,
            nodeOnline: true,
            reason: "EULA file not found",
          });
        }

        // Other node-side errors
        return res.json({
          success: false,
          nodeOnline: true,
          message: "Node error",
        });
      }

      // No response at all → node is offline / unreachable
      if (err.request) {
        return res.status(503).json({
          success: false,
          nodeOnline: false,
          message: "Node offline or unreachable",
        });
      }

      // Unknown error
      return res.status(500).json({
        success: false,
        message: "Internal error",
      });
    }

  }
);
/**
 * GET /server/features/:id/minecraft
 * Manage Server.properties or so 
 */
router.get("/server/features/:id/minecraft", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");

  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);
  if (server.image && Array.isArray(server.image.features) && !server.image.features.includes('EULA', 'PLUGINS', 'PLAYERS')) {
    return res.redirect('/server/manage/'+ req.params.id);
  };
  let properties = [];
  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/fs/feature/${server.idt}/properties`,
      {
        params: { key: node.key },
      }
    );
    properties = response.data.properties || [];
  } catch (err) {
    // the error would usually means node is offline
    // console.error("Error fetching properties:", err.message);
    properties = [];
  }
  res.render("server/minecraft", {
    name: appName,
    user,
    server,
    properties,
  });
});

/**
 * POST /server/features/:id/minecraft
 * Edit Server.properties or so 
 */
router.post("/server/features/:id/minecraft", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");

  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);
  
  if (server.image && Array.isArray(server.image.features) && !server.image.features.includes('EULA', 'PLUGINS', 'PLAYERS')) {
    return res.redirect('/server/manage/'+ req.params.id);
  }
  
  try {
    // Transform form data into expected format
    const properties = [];
    
    if (req.body.properties) {
      Object.keys(req.body.properties).forEach(index => {
        const prop = req.body.properties[index];
        if (prop.key) {
          properties.push({
            key: prop.key,
            value: prop.value === 'true' ? true : (prop.value === 'false' ? false : prop.value || false)
          });
        }
      });
    }
    const response = await axios.post(
      `${getNodeUrl(node)}/server/fs/feature/${server.idt}/properties`,
      { properties },
      {
        params: { key: node.key } 
      }
    );

    logAdd(`Updated server.properties`, "info");
    res.redirect('/server/features/' + req.params.id + '/minecraft?success=true');
    
  } catch (err) {
    console.error("Failed to update properties:", err);
    logAdd(`Failed to update server.properties: ${err.message}`, "error");
    res.redirect('/server/features/' + req.params.id + '/minecraft?error=true');
  }
  
});
/**
 * GET /server/files/:id
 * List files and folders for a server
 * Query: ?path=/
 */
router.get("/server/files/:id", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send("Server not found");

  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");

  const pathQuery = req.query.path || "/";

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  const user = unsqh.get("users", req.session.userId);

  let files = [];

  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/fs/${server.idt}/files`,
      {
        params: { path: pathQuery, key: node.key },
      }
    );
    files = response.data || [];
  } catch (err) {
    // the error would usually means node is offline
    // console.error("Error fetching files:", err.message);
    files = [];
  }

  res.render("server/files/index", {
    name: appName,
    user,
    server,
    files,
    formatSize: (bytes) => {
      if (bytes == null) return "";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      let b = bytes;

      while (b >= 1024 && i < units.length - 1) {
        b /= 1024;
        i++;
      }

      return b.toFixed(2) + " " + units[i];
    },
    path: pathQuery,
  });
});

router.get('/server/files/:id/raw', requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.status(404).send('Server not found');
  if (!server.node) return res.status(500).send('Server node not assigned');

  const node = unsqh.list('nodes').find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send('Node not found');

  const location = req.query.location;
  if (!location) return res.status(400).send('Missing location');

  try {
    const response = await axios.get(
      `${getNodeUrl(node)}/server/fs/${server.idt}/file/content`,
      { params: { location, key: node.key } }
    );

    const content = response.data && response.data.content != null ? response.data.content : '';
    res.type('text/plain').send(content);
  } catch (err) {
    console.error('raw fetch error', err?.message || err);
    res.status(500).send('Failed to fetch file content');
  }
});

/**
 * POST /server/files/:id/new-file
 * body: { filename, content }
 * Query: ?path=/
 */
router.post(
  "/server/files/:id/new-file",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const { filename, content } = req.body;
    const pathQuery = req.query.path || "/";

    try {
      await axios.post(
        `${getNodeUrl(node)}/server/fs/${server.idt}/file/new`,
        { filename, content },
        {
          params: { path: pathQuery, key: node.key },
        }
      );
      logAdd(req.session.userId, `Created file ${filename} in ${pathQuery}`);
      res.redirect(
        `/server/files/${server.id}?path=${encodeURIComponent(pathQuery)}`
      );
    } catch (err) {
      console.log(err)
      res.status(500).send(err.message);
    }
  }
);

/**
 * POST /server/files/:id/new-folder
 * body: { filename }
 * Query: ?path=/
 */
router.post(
  "/server/files/:id/new-folder",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const { filename } = req.body;
    const pathQuery = req.query.path || "/";

    try {
      await axios.post(
        `${getNodeUrl(node)}/server/fs/${server.idt}/folder/new`,
        { filename },
        {
          params: { path: pathQuery, key: node.key },
        }
      );
      logAdd(req.session.userId, `Created folder ${filename} in ${pathQuery}`);
      res.redirect(
        `/server/files/${server.id}?path=${encodeURIComponent(pathQuery)}`
      );
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);

/**
 * POST /server/files/:id/file/delete
 * Query: ?location=/file.txt
 */
router.post(
  "/server/files/:id/file/delete",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const location = req.query.location;
    if (!location) return res.status(400).send("Missing location");

    try {
      await axios.delete(
        `${getNodeUrl(node)}/server/fs/${server.idt}/file/delete`,
        {
          params: { location, key: node.key },
        }
      );
      logAdd(req.session.userId, `Deleted file ${location}`);
      res.redirect(`/server/files/${server.id}`);
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);

/**
 * POST /server/files/:id/folder/delete
 * Query: ?location=/folder
 */
router.post(
  "/server/files/:id/folder/delete",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const location = req.query.location;
    if (!location) return res.status(400).send("Missing location");

    try {
      await axios.delete(
        `${getNodeUrl(node)}/server/fs/${server.idt}/folder/delete`,
        {
          params: { location, key: node.key },
        }
      );
      logAdd(req.session.userId, `Deleted folder ${location}`);
      res.redirect(`/server/files/${server.id}`);
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);

/**
 * POST /server/files/:id/file/rename
 * body: { location, newName }
 */
router.post(
  "/server/files/:id/file/rename",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const { location, newName } = req.body;
    if (!location) return res.status(400).send("Missing location");
    if (!newName) return res.status(400).send("Missing newName");

    try {
      await axios.post(
        `${getNodeUrl(node)}/server/fs/${server.idt}/file/rename`,
        { location, newName },
        { params: { key: node.key } }
      );
      logAdd(req.session.userId, `Renamed file ${location} to ${newName}`);
      res.redirect(`/server/files/${server.id}`);
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);

/**
 * POST /server/files/:id/folder/rename
 * body: { location, newName }
 */
router.post(
  "/server/files/:id/folder/rename",
  requireAuth,
  withServer,
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const { location, newName } = req.body;
    if (!location) return res.status(400).send("Missing location");
    if (!newName) return res.status(400).send("Missing newName");

    try {
      await axios.post(
        `${getNodeUrl(node)}/server/fs/${server.idt}/folder/rename`,
        { location, newName },
        { params: { key: node.key } }
      );
      logAdd(req.session.userId, `Renamed folder ${location} to ${newName}`);
      res.redirect(`/server/files/${server.id}`);
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);
/* =========================
   SETTINGS PAGE ROUTE
========================= */

/**
 * GET /server/settings/:id
 * Render server settings page
 */
router.get("/server/settings/:id", requireAuth, withServer, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.redirect("/dashboard");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  server.subusers = (server.subusers || []).map(id => unsqh.get("users", id)).filter(Boolean);
  res.render("server/settings", {
    name: appName,
    user,
    server,
    req
  });
});

/* =========================
   SERVER SETTINGS ACTIONS
========================= */

/**
 * POST /server/settings/:id/rename
 * Rename the server
 * body: { newName }
 */
router.post(
  "/server/settings/:id/rename",
  requireAuth,
  withServer,
  (req, res) => {
    const { newName } = req.body;
    if (!newName) return res.status(400).send("Missing newName");

    const user = unsqh.get("users", req.session.userId);
    if (!user) return res.status(404).send("User not found");

    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    server.name = newName;
    user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
    unsqh.put("users", req.session.userId, user);

    const adminServer = unsqh.get("servers", server.id);
    if (adminServer) {
      adminServer.name = newName;
      unsqh.put("servers", server.id, adminServer);
    }
    logAdd(req.session.userId, `Renamed server to ${newName}`);
    res.redirect(`/server/settings/${server.id}`);
  }
);

/**
 * POST /server/settings/:id/envs
 * Save envs
 */
router.post(
  "/server/settings/:id/envs",
  requireAuth,
  withServer,
  (req, res) => {
    const user = unsqh.get("users", req.session.userId);
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);

    if (!server) {
      return res.status(404).send("Server not found");
    }

    const newEnv = req.body.env || {};

    // update user server
    server.env = newEnv;
    user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
    unsqh.put("users", user.id, user);

    const adminServer = unsqh.get("servers", server.id);
    if (adminServer) {
      adminServer.env = newEnv;
      unsqh.put("servers", server.id, adminServer);
    }
    logAdd(req.session.userId, `Updated environment variables`);
    res.redirect(`/server/startup/${server.id}?env=saved`);
  }
);

/**
 * POST /server/settings/reinstall/:idt
 * Reinstall the server
 */
router.post(
  "/server/settings/reinstall/:id",
  requireAuth,
  withServer,
  async (req, res) => {
    const { id } = req.params;

    const user = unsqh.get("users", req.session.userId);
    if (!user) return res.status(404).send("User not found");

    const server = getServerForUser(req.session.userId, id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    try {
      const response = await axios.post(
        `${getNodeUrl(node)}/server/reinstall/${server.idt}`,
        { env: server.env },
        { params: { key: node.key } }
      );

      const { containerId: newContainerId } = response.data;

      server.containerId = newContainerId;
      user.servers = user.servers.map((s) => (s.id === id ? server : s));
      unsqh.put("users", user.id, user);

      const adminServer = unsqh
        .list("servers")
        .find((s) => s.idt === server.idt);
      if (adminServer) {
        adminServer.containerId = newContainerId;
        unsqh.put("servers", adminServer.id, adminServer);
      }
      logAdd(req.session.userId, `Reinstalled server`);
      res.redirect(`/server/settings/${server.id}?rs=true`);
    } catch (err) {
      console.error("Reinstall failed:", err);
      res.redirect(
        `/server/settings/${server.id}?rs=false&err=${encodeURIComponent(
          err.message || "unknown"
        )}`
      );
    }
  }
);

/**
 * POST /server/files/:id/upload
 * Query: ?path=/subfolder
 * FormData: file=<file>
 */
router.post(
  "/server/files/:id/upload",
  requireAuth,
  withServer,
  upload.single("file"),
  async (req, res) => {
    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");
    if (!server.node) return res.status(500).send("Server node not assigned");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const pathQuery = req.query.path || "/";

    if (!req.file) return res.status(400).send("No file uploaded");

    try {
      // Send the file to the node via Axios using multipart/form-data
      const FormData = require("form-data");
      const form = new FormData();
      form.append("file", req.file.buffer, req.file.originalname);

      await axios.post(
        `${getNodeUrl(node)}/server/fs/${server.idt}/file/upload`,
        form,
        {
          headers: {
            ...form.getHeaders(),
          },
          params: { path: pathQuery, key: node.key },
        }
      );
      logAdd(req.session.userId, `Uploaded file ${req.file.originalname} to ${pathQuery}`);
      res.redirect(
        `/server/files/${server.id}?path=${encodeURIComponent(pathQuery)}`
      );
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);
/**
 * GET /server/network/:id/add
 */
router.get(
  "/server/network/:id/add",
  requireAuth,
  withServer,
  async (req, res) => {
    const { id } = req.params;

    const user = unsqh.get("users", req.session.userId);
    const server = getServerForUser(req.session.userId, id);
    const logAdd = router.bindLog(server.id);
    if (!server || !server.node) return res.redirect("/dashboard");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    node.allocations = Array.isArray(node.allocations) ? node.allocations : [];

    const availableAllocations = node.allocations.filter(
      (a) => !a.allocationOwnedto
    );

    if (!availableAllocations.length)
      return res.redirect(`/server/network/${id}?error=no_ports_available`);

    const allocation =
      availableAllocations[
      Math.floor(Math.random() * availableAllocations.length)
      ];

    const PORT = allocation.port;

    // Prevent multiple primaries
    if (allocation.type === "primary") {
      const hasPrimary = node.allocations.some(
        (a) =>
          a.type === "primary" && a.allocationOwnedto?.serverId === server.id
      );
      if (hasPrimary)
        return res.redirect(`/server/network/${id}?error=primary_exists`);
    }

    const currentAllocations = node.allocations.filter(
      a => a.allocationOwnedto?.serverId === server.id
    ).length;

    if (currentAllocations >= server.allocationLimit) {
      return res.redirect(`/server/network/${id}?error=cant_add_more`);
    }
    try {
      const { data } = await axios.post(
        `${getNodeUrl(node)}/server/network/${server.idt}/add/${PORT}`,
        {},
        { params: { key: node.key } }
      );

      // Claim allocation
      allocation.allocationOwnedto = { serverId: server.id };

      if (!server.port || allocation.type === "primary")
        allocation.type = "primary";

      unsqh.update("nodes", node.id, { allocations: node.allocations });

      // Add port to server
      server.ports = server.ports || [];
      if (!server.ports.includes(PORT)) server.ports.push(PORT);

      if (!server.port || allocation.type === "primary")
        server.port = PORT;

      server.containerId = data.containerId;
      unsqh.put("servers", server.id, server);

      user.servers = user.servers.map((s) =>
        s.id === server.id ? server : s
      );
      unsqh.put("users", user.id, user);

      logAdd(req.session.userId, `Claimed random allocation on port ${PORT}`);
      res.redirect(`/server/network/${id}?allocation=claimed`);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.redirect(`/server/network/${id}?error=failed`);
    }
  }
);


/**
 * POST /server/network/:id/setprimary/:port
 */
router.post(
  "/server/network/:id/setprimary/:port",
  requireAuth,
  withServer,
  async (req, res) => {
    const { id, port } = req.params;
    const PORT = Number(port);

    const user = unsqh.get("users", req.session.userId);
    const server = getServerForUser(req.session.userId, id);
    const logAdd = router.bindLog(server.id);
    if (!server || !server.node) return res.redirect("/dashboard");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const allocation = node.allocations?.find(
      (a) => a.port === PORT && a.allocationOwnedto?.serverId === server.id
    );
    if (!allocation)
      return res.redirect(`/server/network/${id}?error=allocation_not_owned`);

    try {
      const { data } = await axios.post(
        `${getNodeUrl(node)}/server/network/${server.idt}/setprimary/${PORT}`,
        {},
        { params: { key: node.key } }
      );

      node.allocations.forEach((a) => {
        if (a.allocationOwnedto?.serverId === server.id) {
          a.type = a.port === PORT ? "primary" : "secondary";
        }
      });
      unsqh.update("nodes", node.id, { allocations: node.allocations });

      // Set primary port safely
      server.port = PORT;
      if (!server.ports.includes(PORT)) server.ports.push(PORT);

      server.containerId = data.containerId;
      unsqh.put("servers", server.id, server);

      user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
      unsqh.put("users", user.id, user);
      logAdd(req.session.userId, `Set primary allocation to port ${PORT}`);
      res.redirect(`/server/network/${id}?allocation=primary`);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.redirect(`/server/network/${id}?error=failed`);
    }
  }
);

/**
 * POST /server/network/:id/remove/:port
 */
router.post(
  "/server/network/:id/remove/:port",
  requireAuth,
  withServer,
  async (req, res) => {
    const { id, port } = req.params;
    const PORT = Number(port);

    const user = unsqh.get("users", req.session.userId);
    const server = getServerForUser(req.session.userId, id);
    const logAdd = router.bindLog(server.id);
    if (!server || !server.node) return res.redirect("/dashboard");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    const allocation = node.allocations?.find(
      (a) => a.port === PORT && a.allocationOwnedto?.serverId === server.id
    );
    if (!allocation)
      return res.redirect(`/server/network/${id}?error=allocation_not_owned`);

    try {
      const { data } = await axios.post(
        `${getNodeUrl(node)}/server/network/${server.idt}/remove/${PORT}`,
        {},
        { params: { key: node.key } }
      );

      // Remove allocation ownership
      delete allocation.allocationOwnedto;
      unsqh.update("nodes", node.id, { allocations: node.allocations });

      // Remove port from server.ports
      server.ports = server.ports?.filter((p) => p !== PORT) || [];
      if (server.port === PORT) server.port = server.ports[0] || null;

      server.containerId = data.containerId;
      unsqh.put("servers", server.id, server);

      user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
      unsqh.put("users", user.id, user);
      logAdd(req.session.userId, `Deleted allocation on port ${PORT}`);
      res.redirect(`/server/network/${id}?allocation=released`);
    } catch (err) {
      console.error(err.response?.data || err.message);
      res.redirect(`/server/network/${id}?error=failed`);
    }
  }
);

/**
 * GET /server/network/:id
 * Render server network page
 */
router.get("/server/network/:id", requireAuth, withServer, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.redirect("/dashboard");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  // Find the node for this server
  const node = unsqh.list("nodes").find((n) => n.ip === server.node?.ip);
  const nodeAllocations = Array.isArray(node?.allocations) ? node.allocations : [];

  // Filter allocations owned by this server
  const allocations = nodeAllocations.filter(
    (a) => a.allocationOwnedto?.serverId === server.id
  );

  // Keep server.port in sync with the node primary if possible (convenience)
  const primary = allocations.find((a) => a.type === "primary");
  if (primary) server.port = primary.port;
  res.render("server/network", {
    name: appName,
    user,
    server,
    allocations,
  });
});


/**
 * POST add a subuser to a server
 * body: { email }
 * - Adds the server to the target user's `servers` array with `ou: true`
 * - Adds the subuser's id to the admin/global server's `subusers` list
 */
router.post(
  "/server/settings/:id/subuser/add",
  requireAuth,
  withServer,
  (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).send("Missing email");

      const me = unsqh.get("users", req.session.userId);
      if (!me) return res.status(404).send("User not found");

      const serverRef = getServerForUser(req.session.userId, req.params.id);
      const logAdd = router.bindLog(serverRef.id);
      if (!serverRef) return res.status(404).send("Server not found");

      const globalServer = unsqh.get("servers", serverRef.id) || serverRef;

      // Find the user by email
      const subuser = unsqh.list("users").find(u => u.email === email);
      if (!subuser) return res.status(404).send("Subuser not found");

      // Prevent adding owner as subuser
      if (subuser.id === globalServer.ownerId) {
        return res.status(400).send("Cannot add the owner as a subuser");
      }

      subuser.servers = Array.isArray(subuser.servers) ? subuser.servers : [];

      // If the subuser already has access, do nothing
      if (subuser.servers.some((s) => s.id === globalServer.id)) {
        return res.redirect(`/server/settings/${globalServer.id}?subuser=already`);
      }

      const subEntry = {
        id: globalServer.id,
        idt: globalServer.idt,
        name: globalServer.name,
        node: globalServer.node,
        port: globalServer.port,
        ports: globalServer.ports,
        env: globalServer.env,
        imageId: globalServer.imageId,
        containerId: globalServer.containerId,
        ou: true,
        ftp: {
          host: globalServer.ftp.host,
          port: globalServer.ftp.port,
          username: globalServer.ftp.username,
          password: globalServer.ftp.password,
        },
        owner: globalServer.ownerId || null,
      };

      subuser.servers.push(subEntry);
      unsqh.put("users", subuser.id, subuser);

      globalServer.subusers = Array.isArray(globalServer.subusers) ? globalServer.subusers : [];
      if (!globalServer.subusers.includes(subuser.id)) globalServer.subusers.push(subuser.id);
      unsqh.put("servers", globalServer.id, globalServer);
      logAdd(req.session.userId, `Added subuser ${subuser.email}`);
      res.redirect(`/server/settings/${globalServer.id}?subuser=added`);
    } catch (err) {
      console.error("Error adding subuser:", err);
      res.status(500).send("Failed to add subuser");
    }
  }
);

/**
 * POST remove a subuser from a server
 * body: { subuserId }
 * - Removes the server entry from the target user's `servers` array
 * - Removes the subuser from the admin/global server's `subusers` list
 */
router.post(
  "/server/settings/:id/subuser/remove",
  requireAuth,
  withServer,
  (req, res) => {
    try {
      const { subuserId } = req.body;
      if (!subuserId) return res.status(400).send("Missing subuserId");

      const me = unsqh.get("users", req.session.userId);
      if (!me) return res.status(404).send("User not found");

      const serverRef = getServerForUser(req.session.userId, req.params.id);
      const logAdd = router.bindLog(serverRef.id);
      if (!serverRef) return res.status(404).send("Server not found");

      const globalServer = unsqh.get("servers", serverRef.id) || serverRef;

      if (subuserId === globalServer.ownerId) {
        return res.redirect(`/server/settings/${globalServer.id}?subuser=owner`);
      }
      const subuser = unsqh.get("users", subuserId);
      if (!subuser) return res.status(404).send("Subuser not found");

      subuser.servers = Array.isArray(subuser.servers) ? subuser.servers : [];

      // Remove server entry from the subuser
      const before = subuser.servers.length;
      subuser.servers = subuser.servers.filter((s) => s.id !== globalServer.id);
      const after = subuser.servers.length;

      if (before === after) {
        // nothing removed
        return res.redirect(`/server/settings/${globalServer.id}?subuser=notfound`);
      }

      unsqh.put("users", subuser.id, subuser);

      // Remove subuser from canonical server's subusers list
      globalServer.subusers = Array.isArray(globalServer.subusers) ? globalServer.subusers : [];
      globalServer.subusers = globalServer.subusers.filter((u) => u !== subuser.id);
      unsqh.put("servers", globalServer.id, globalServer);
      logAdd(req.session.userId, `Removed subuser ${subuser.email}`);
      res.redirect(`/server/settings/${globalServer.id}?subuser=removed`);
    } catch (err) {
      console.error("Error removing subuser:", err);
      res.status(500).send("Failed to remove subuser");
    }
  }
);

/**
 * GET /server/startup/:id
 * Render server startup page
 */
router.get("/server/startup/:id", requireAuth, withServer, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = getServerForUser(req.session.userId, req.params.id);
  const logAdd = router.bindLog(server.id);
  if (!server) return res.redirect("/dashboard");
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  res.render("server/startup", {
    name: appName,
    user,
    server,
    req
  });
});

/**
 * POST /server/startup/:id/setPrimaryImage
 * Sets the Primary Docker Image for the server
 * body: { DockerImage }
 */
router.post(
  "/server/startup/:id/setPrimaryImage",
  requireAuth,
  withServer,
  (req, res) => {
    const { DockerImage } = req.body;
    if (!DockerImage)
      return res.status(400).send("Missing DockerImage");

    const user = unsqh.get("users", req.session.userId);
    if (!user) return res.status(404).send("User not found");

    const server = getServerForUser(req.session.userId, req.params.id);
    const logAdd = router.bindLog(server.id);
    if (!server) return res.status(404).send("Server not found");

    server.image.dockerImage = DockerImage;
    user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
    unsqh.put("users", user.id, user);

    const adminServer = unsqh.get("servers", server.id);
    if (adminServer) {
      adminServer.image.dockerImage = DockerImage;
      unsqh.put("servers", server.id, adminServer);
    }
    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (node && node.key && DockerImage) {
      axios
        .post(
          `${getNodeUrl(node)}/server/${server.idt}/set-image`,
          { dockerImage: DockerImage },
          { params: { key: node.key } }
        )
        .catch((err) => {
          console.error(
            `Failed to pre-pull image ${DockerImage} on node ${node.ip}:`,
            err.response?.data || err.message
          );
        });
    }
    logAdd(req.session.userId, `Set primary image to ${DockerImage}`);
    res.redirect(`/server/startup/${server.id}?image=updated`);
  }
);

/**
 * addAuditLog(serverId, userId, action)
 * - Adds a single audit log entry to the canonical server record stored in unsqh.
 * - Each entry: { id, userId, action, ts }
 */
function addAuditLog(serverId, userId, action) {
  if (!serverId || !userId || !action) return false;

  let server = unsqh.get("servers", serverId);
  if (!server) {
    const allServers = unsqh.list("servers") || [];
    const fallback = allServers.find(s => s.id === serverId || s.idt === serverId);
    if (!fallback) return false;
    server = fallback;
  }

  server.auditLogs = Array.isArray(server.auditLogs) ? server.auditLogs : [];

  const entry = {
    id: _makeId(),
    userId,
    action: String(action),
    ts: new Date().toISOString()
  };

  server.auditLogs.push(entry);
  // persist canonical server object
  unsqh.put("servers", server.id, server);

  // Optionally keep per-user copies in user.servers in sync (best-effort)
  // update all users who reference this server
  const users = unsqh.list("users") || [];
  for (const u of users) {
    if (!Array.isArray(u.servers)) continue;
    const idx = u.servers.findIndex(s => s.id === server.id);
    if (idx !== -1) {
      // ensure local copy has auditLogs (shallow copy)
      u.servers[idx].auditLogs = server.auditLogs;
      unsqh.put("users", u.id, u);
    }
  }

  return entry;
}

/**
 * bindLog(serverId) -> returns logAdd(userId, action)
 * so you can call: const logAdd = bindLog(server.id); logAdd('userId','whathedid');
 */
function bindLog(serverId) {
  return function logAdd(userId, action) {
    return addAuditLog(serverId, userId, action);
  };
}

// expose helpers on router so other modules can call them easily:
router.addAuditLog = addAuditLog;
router.bindLog = bindLog;

// --- ROUTE: GET /server/auditlogs/:serverId ---
router.get("/server/auditlogs/:serverId", requireAuth, (req, res) => {
  const serverId = req.params.serverId;
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  // use getServerForUser so permissions are respected
  const server = getServerForUser(req.session.userId, serverId);
  if (!server) return res.redirect("/dashboard?error=NOTFOUND");
  if (server.suspended) return res.redirect("/dashboard?error=SUSPENDED");

  // canonical server record (to read persisted audit logs)
  const canonical = unsqh.get("servers", server.id) || server;
  const logs = Array.isArray(canonical.auditLogs) ? canonical.auditLogs.slice().reverse() : [];

  // decorate logs with user display info
  const displayLogs = logs.map((entry) => {
    const u = unsqh.get("users", entry.userId) || { id: entry.userId, name: "Unknown" };
    return {
      ...entry,
      userName: u.name || u.email || `user:${entry.userId}`
    };
  });

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("server/auditlogs", {
    name: appName,
    user,
    server,
    logs: displayLogs,
  });
});
module.exports = router;
