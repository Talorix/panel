#!/usr/bin/env node

const prompts = require("prompts");
const crypto = require("crypto");
const unsqh = require("../modules/db.js");
const Logger = require("../modules/logger.js");

(async () => {
  Logger.log("=== Talorix Admin System ===\n");

  const response = await prompts({
    type: "select",
    name: "action",
    message: "Choose an action:",
    choices: [
      { title: "Create a new admin user", value: "create" },
      { title: "Set existing user as admin", value: "set" },
      { title: "Fetch images from remote library", value: "fetchImages" },
    ],
  });

  /* ============================
     CREATE ADMIN USER
  ============================ */
  if (response.action === "create") {
    const userData = await prompts([
      { type: "text", name: "username", message: "Username:" },
      { type: "text", name: "email", message: "Email:" },
      { type: "password", name: "password", message: "Password:" },
    ]);

    const existing = unsqh
      .list("users")
      .find((u) => u.email === userData.email);

    if (existing) {
      Logger.log("Error: User with this email already exists.");
      process.exit(1);
    }

    const id = Math.random().toString(36).substring(2, 12);
    const hash = crypto
      .createHash("sha256")
      .update(userData.password)
      .digest("hex");

    unsqh.put("users", id, {
      id,
      email: userData.email,
      username: userData.username,
      password: hash,
      servers: [],
      admin: true,
    });

    Logger.log(`Admin user created: ${userData.username} (${userData.email})`);
  }

  /* ============================
     SET USER AS ADMIN
  ============================ */
  else if (response.action === "set") {
    const emailResponse = await prompts({
      type: "text",
      name: "email",
      message: "Enter the email of the user to make admin:",
    });

    const user = unsqh
      .list("users")
      .find((u) => u.email === emailResponse.email);

    if (!user) {
      Logger.log("Error: No user found with that email.");
      process.exit(1);
    }

    unsqh.put("users", user.id, { ...user, admin: true });
    Logger.log(`User ${user.username} (${user.email}) is now an admin.`);
  }

  /* ============================
     FETCH & SYNC IMAGES
  ============================ */
  else if (response.action === "fetchImages") {
    const url =
      "https://raw.githubusercontent.com/Talorix/Container-Images/refs/heads/main/image_library.json";

    try {
      const libraryResp = await fetch(url);
      if (!libraryResp.ok) {
        throw new Error(`Failed to fetch URL: ${libraryResp.status}`);
      }

      const library = await libraryResp.json();

      const addedImages = [];
      const updatedImages = [];
      const skippedImages = [];

      for (const key in library) {
        const imageUrl = library[key];

        const imageResp = await fetch(imageUrl);
        if (!imageResp.ok) continue;

        const imageData = await imageResp.json();
        const { dockerImage, dockerImages, name, description, envs, files, features, startCmd, stopCmd } =
          imageData;
        let dockerImagesList = [];

        if (dockerImages && Array.isArray(dockerImages)) {
          dockerImagesList = dockerImages;
        } else if (dockerImage) {
          dockerImagesList.push(dockerImage);
        }

        if (!dockerImage || !name) continue;

        const existingImage = unsqh
          .list("images")
          .find((img) => img.dockerImage === dockerImage);

        const normalized = {
          dockerImage,
          dockerImages: dockerImagesList,
          name,
          description: description || "",
          envs: envs || {},
          files: files || [],
          features: Array.isArray(features) ? features : [],
          startCmd: startCmd || "",
          stopCmd: stopCmd || "",
        };

        if (existingImage) {
          const identical =
            existingImage.name === normalized.name &&
            existingImage.description === normalized.description &&
            existingImage.startCmd === normalized.startCmd &&
            existingImage.stopCmd === normalized.stopCmd &&
            JSON.stringify(existingImage.envs || {}) ===
              JSON.stringify(normalized.envs) &&
            JSON.stringify(existingImage.files || []) ===
              JSON.stringify(normalized.files) &&
            JSON.stringify(existingImage.features || []) ===
              JSON.stringify(normalized.features) &&
            JSON.stringify(existingImage.dockerImages || []) ===
              JSON.stringify(normalized.dockerImages);

          if (identical) {
            skippedImages.push(name);
            continue;
          }

          const updated = {
            ...existingImage,
            ...normalized,
            updatedAt: Date.now(),
          };

          unsqh.put("images", existingImage.id, updated);
          updatedImages.push(updated);
        } else {
          // CREATE new image
          const id = crypto.randomUUID();

          const image = {
            id,
            ...normalized,
            createdAt: Date.now(),
          };

          unsqh.put("images", id, image);
          addedImages.push(image);
        }
      }

      Logger.log(
        `Images synced: ${addedImages.length} added, ${updatedImages.length} updated, ${skippedImages.length} unchanged.`
      );

      addedImages.forEach((img) =>
        Logger.log(`+ Added: ${img.name} (${img.dockerImage})`)
      );

      updatedImages.forEach((img) =>
        Logger.log(`~ Updated: ${img.name} (${img.dockerImage})`)
      );

      skippedImages.forEach((name) =>
        Logger.log(`= Skipped: ${name}`)
      );
    } catch (err) {
      Logger.log("Error fetching images:", err.message);
    }
  }

  process.exit(0);
})();
