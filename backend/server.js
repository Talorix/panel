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
function getServerForUser(userId, serverId) {
  const user = unsqh.get("users", userId);
  if (!user) return null;
  return user.servers?.find((s) => s.id === serverId) || null;
}

function getNodeUrl(node) {
  return `http://${node.ip}:${node.port}`;
}

function withServer(req, res, next) {
  const server = getServerForUser(req.session.userId, req.params.id);
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
router.get("/server/manage/:id", requireAuth, withServer, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const server = getServerForUser(req.session.userId, req.params.id);
  const image = unsqh.get("images", server.imageId);
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("server/manage", {
    name: appName,
    user,
    server,
    image,
  });
});

/**
 * POST /server/size/:id
 * gets the total server size
 */
router.post("/server/size/:id", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
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
    console.error(
      "Error fetching server size:",
      err.response?.data || err.message
    );
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
  if (!server) return res.status(404).send("Server not found");
  if (!server.node) return res.status(500).send("Server node not assigned");

  const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
  if (!node) return res.status(404).send("Node not found");

  try {
    await createFileOnServer(server, node, "eula.txt", "eula=true");
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
      // If file doesn't exist, consider EULA not accepted
      res.json({ success: true, eulaAccepted: false });
    }
  }
);

/**
 * GET /server/files/:id
 * List files and folders for a server
 * Query: ?path=/
 */
router.get("/server/files/:id", requireAuth, withServer, async (req, res) => {
  const server = getServerForUser(req.session.userId, req.params.id);
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
  if (!server) return res.redirect("/dashboard");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

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
    if (!server) return res.status(404).send("Server not found");
    server.name = newName;
    user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
    unsqh.put("users", req.session.userId, user);

    const adminServer = unsqh.get("servers", server.id);
    if (adminServer) {
      adminServer.name = newName;
      unsqh.put("servers", server.id, adminServer);
    }

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

    res.redirect(`/server/settings/${server.id}?env=saved`);
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

      res.redirect(
        `/server/files/${server.id}?path=${encodeURIComponent(pathQuery)}`
      );
    } catch (err) {
      res.status(500).send(err.message);
    }
  }
);
/**
 * GET /server/network/:id/add/:port
 */
router.get(
  "/server/network/:id/add/:port",
  requireAuth,
  withServer,
  async (req, res) => {
    const { id, port } = req.params;
    const PORT = Number(port);

    const user = unsqh.get("users", req.session.userId);
    const server = getServerForUser(req.session.userId, id);
    if (!server || !server.node) return res.redirect("/dashboard");

    const node = unsqh.list("nodes").find((n) => n.ip === server.node.ip);
    if (!node) return res.status(404).send("Node not found");

    node.allocations = Array.isArray(node.allocations) ? node.allocations : [];

    const allocation = node.allocations.find((a) => a.port === PORT);
    if (!allocation)
      return res.redirect(`/server/network/${id}?error=invalid_allocation`);
    if (allocation.allocationOwnedto)
      return res.redirect(`/server/network/${id}?error=allocation_taken`);

    if (allocation.type === "primary") {
      const hasPrimary = node.allocations.some(
        (a) =>
          a.type === "primary" && a.allocationOwnedto?.serverId === server.id
      );
      if (hasPrimary)
        return res.redirect(`/server/network/${id}?error=primary_exists`);
    }

    try {
      const { data } = await axios.post(
        `${getNodeUrl(node)}/server/network/${server.idt}/add/${PORT}`,
        {},
        { params: { key: node.key } }
      );

      // Claim allocation
      allocation.allocationOwnedto = { serverId: server.id };
      // Ensure allocation.type is properly set if primary
      if (!server.port || allocation.type === "primary")
        allocation.type = "primary";

      unsqh.update("nodes", node.id, { allocations: node.allocations });

      // Add port to server.ports safely
      server.ports = server.ports || [];
      if (!server.ports.includes(PORT)) server.ports.push(PORT);

      // Set server.port if not set or this is primary
      if (!server.port || allocation.type === "primary") server.port = PORT;

      server.containerId = data.containerId;
      unsqh.put("servers", server.id, server);

      user.servers = user.servers.map((s) => (s.id === server.id ? server : s));
      unsqh.put("users", user.id, user);

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


module.exports = router;
