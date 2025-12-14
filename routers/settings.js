const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const unsqh = require("../modules/db.js");
const speakeasy = require("speakeasy");
const QRCode = require("qrcode");

// Middleware to require login
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.redirect("/");
  next();
}

// GET /settings
router.get("/settings", requireAuth, async (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  let qrCodeUrl = null;

  // If user is enabling 2FA but hasn't confirmed yet, generate a secret and QR code
  if (user.tempTwoFactorSecret) {
    qrCodeUrl = await QRCode.toDataURL(user.tempTwoFactorSecret.otpauth_url);
  }

  res.render("user/settings", {
    name: appName,
    user,
    message: null,
    error: null,
    qrCodeUrl
  });
});

// POST /settings/password
router.post("/settings/password", requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  const currentHash = crypto.createHash("sha256").update(currentPassword || "").digest("hex");
  if (user.password !== currentHash) {
    return res.render("user/settings", { name: appName, user, message: null, error: "Current password is incorrect" });
  }

  if (!newPassword || newPassword !== confirmPassword) {
    return res.render("user/settings", { name: appName, user, message: null, error: "Passwords do not match" });
  }

  const newHash = crypto.createHash("sha256").update(newPassword).digest("hex");
  unsqh.update("users", user.id, { password: newHash });

  res.render("user/settings", { name: appName, user, message: "Password updated successfully", error: null, qrCodeUrl: null });
});

// POST /settings/2fa/setup
// Generate 2FA secret & QR code
router.post("/settings/2fa/setup", requireAuth, async (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/");
  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";
  // Generate a secret
  const secret = speakeasy.generateSecret({
    name: `${appName} (${user.email})`,
    length: 20
  });

  // Store secret temporarily until verified
  unsqh.update("users", user.id, { tempTwoFactorSecret: secret });

  const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

  res.render("user/settings", {
    name: appName,
    user: unsqh.get("users", req.session.userId),
    message: "Scan the QR code with your authenticator app and enter the token below.",
    error: null,
    qrCodeUrl
  });
});

// POST /settings/2fa/verify
// Verify token & enable 2FA
router.post("/settings/2fa/verify", requireAuth, (req, res) => {
  const { token } = req.body;
  const user = unsqh.get("users", req.session.userId);
  if (!user || !user.tempTwoFactorSecret) return res.redirect("/settings");

  const verified = speakeasy.totp.verify({
    secret: user.tempTwoFactorSecret.base32,
    encoding: "base32",
    token
  });

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  if (!verified) {
    return res.render("user/settings", {
      name: appName,
      user,
      message: null,
      error: "Invalid token, try again",
      qrCodeUrl: null
    });
  }

  // Save secret permanently & remove temp secret
  unsqh.update("users", user.id, {
    twoFactorEnabled: true,
    twoFactorSecret: user.tempTwoFactorSecret.base32,
    tempTwoFactorSecret: null
  });

  res.render("user/settings", {
    name: appName,
    user: unsqh.get("users", req.session.userId),
    message: "2FA enabled successfully",
    error: null,
    qrCodeUrl: null
  });
});

// POST /settings/2fa/disable
router.post("/settings/2fa/disable", requireAuth, (req, res) => {
  const user = unsqh.get("users", req.session.userId);
  if (!user) return res.redirect("/settings");

  unsqh.update("users", user.id, {
    twoFactorEnabled: false,
    twoFactorSecret: null
  });

  const settings = unsqh.get("settings", "app") || {};
  const appName = settings.name || "App";

  res.render("user/settings", {
    name: appName,
    user: unsqh.get("users", req.session.userId),
    message: "2FA disabled",
    error: null,
    qrCodeUrl: null
  });
});

module.exports = router;
