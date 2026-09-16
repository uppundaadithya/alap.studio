require("dotenv").config({ path: require("path").join(__dirname, ".env") });

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const cors = require("cors");
const express = require("express");
const helmet = require("helmet");
const multer = require("multer");
const Razorpay = require("razorpay");
const { v4: uuidv4 } = require("uuid");

const {
  attachOrderToTrack,
  createTrack,
  getOrderById,
  getTrackById,
  listTracks,
  markTrackPaid,
  publicTrack,
  databaseMode,
  uploadBufferToStorage,
  getSignedUrlForFile,
  createStorageClient,
  generateId,
  createTrackWithId,
  updateTrackFields,
} = require("./database");

const app = express();
// Log unhandled errors to surface them in Vercel function logs quickly.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason && reason.stack ? reason.stack : reason);
});
const PORT = Number(process.env.PORT || 3000);
const PRODUCER_NAME = process.env.PRODUCER_NAME || "Aalap Studio";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "alap-admin-change-me";
const PREVIEW_BYTES = Number(process.env.PREVIEW_BYTES || 1024 * 1024 * 2);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRIVATE_UPLOAD_DIR = process.env.PRIVATE_UPLOAD_DIR || path.join(os.tmpdir(), "alap_private_uploads");

try {
  fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });
} catch (err) {
  console.warn(`Could not create PRIVATE_UPLOAD_DIR (${PRIVATE_UPLOAD_DIR}):`, err && err.message);
}

const hasRazorpayConfig = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = hasRazorpayConfig()
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

const allowedMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);

// Note: File upload temporarily disabled. Using Google Drive links instead.
// const upload = multer({
//   storage: multer.memoryStorage(),
//   limits: {
//     fileSize: Number(process.env.MAX_UPLOAD_BYTES || 200 * 1024 * 1024),
//   },
//   fileFilter: (_req, file, callback) => {
//     if (!allowedMimeTypes.has(file.mimetype)) {
//       callback(new Error("Only WAV and MP3 files are allowed."));
//       return;
//     }
//     callback(null, true);
//   },
// });

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "https://checkout.razorpay.com",
          "https://cdn.razorpay.com",
          "https://*.razorpay.com",
          "https://www.gstatic.com",
          "https://www.googletagmanager.com",
          "https://vercel.live",
          "https://*.vercel.live",
        ],
        connectSrc: [
          "'self'",
          "https://*.razorpay.com",
          "https://*.googleapis.com",
          "https://*.firebaseio.com",
          "https://*.firebaseapp.com",
          "https://www.google-analytics.com",
          "https://region1.google-analytics.com",
        ],
        frameSrc: [
          "https://api.razorpay.com",
          "https://checkout.razorpay.com",
          "https://vercel.live",
          "https://*.vercel.live",
        ],
        frameAncestors: ["'self'", "https://vercel.live", "https://*.vercel.live"],
        imgSrc: ["'self'", "data:", "https:"],
        mediaSrc: ["'self'", "https:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://*.razorpay.com"],
        fontSrc: ["'self'", "https://*.razorpay.com", "data:"],
      },
    },
  }),
);
app.use(cors());
app.use("/api/payment/webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "1mb" }));

const safeCompare = (received, expected) => {
  const receivedBuffer = Buffer.from(received || "");
  const expectedBuffer = Buffer.from(expected || "");
  return receivedBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(receivedBuffer, expectedBuffer);
};

const requireAdmin = (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");

  if (scheme === "Basic" && encoded) {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    const username = decoded.slice(0, separatorIndex);
    const password = decoded.slice(separatorIndex + 1);

    if (safeCompare(username, ADMIN_USERNAME) && safeCompare(password, ADMIN_PASSWORD)) {
      return next();
    }
  }

  res.setHeader("WWW-Authenticate", 'Basic realm="ALAP Admin Dashboard"');
  return res.status(401).send("Admin login required.");
};

app.get("/", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "portfolio.html"));
});

app.get("/admin", requireAdmin, (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

app.use(["/index.html", "/api/upload", "/api/tracks"], requireAdmin);
app.get("/browser-client.mjs", (_req, res) => {
  res.type("application/javascript").sendFile(path.join(PUBLIC_DIR, "browser-client.mjs"));
});

app.get("/style.css", (_req, res) => {
  res.type("text/css").sendFile(path.join(PUBLIC_DIR, "style.css"));
});

app.get("/alap-logo.png", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "alap-logo.png"));
});

app.use(express.static(PUBLIC_DIR));

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const requireRazorpayConfig = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(
      new Error("Razorpay is not configured. Add RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET before taking payments."),
      { status: 503 },
    );
  }
};

const removeUploadedFile = (file) => {
  if (file?.path) {
    fs.promises.unlink(file.path).catch(() => {});
  }
};

const centsFromInr = (price) => Math.round(Number(price) * 100);

const safeAudioFileName = (fileName = "audio") => {
  const parsed = path.parse(fileName);
  const base = parsed.name.replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "") || "audio";
  const ext = parsed.ext.toLowerCase() || ".mp3";
  return `${base}${ext}`;
};

const getPublicBaseUrl = (req) => {
  const configuredUrl = process.env.PUBLIC_APP_URL || process.env.VERCEL_URL;
  if (configuredUrl) {
    return configuredUrl.startsWith("http") ? configuredUrl : `https://${configuredUrl}`;
  }

  const protocol = req.headers["x-forwarded-proto"] || req.protocol || "http";
  return `${protocol}://${req.get("host")}`;
};

const buildTrackLinks = (req, trackId) => {
  const linkPath = `/track.html?id=${encodeURIComponent(trackId)}`;
  return {
    linkPath,
    deliveryLink: `${getPublicBaseUrl(req)}${linkPath}`,
  };
};

const expectedTrackAmount = (track) => centsFromInr(track.price);

const assertOrderMatchesTrack = (track, order) => {
  const expectedAmount = expectedTrackAmount(track);

  if (Number(order.amount) !== expectedAmount || order.currency !== "INR") {
    throw Object.assign(new Error("Payment order amount does not match this track."), { status: 400 });
  }
};

const assertPaymentUnlocksTrack = async ({ track, order, razorpayOrderId, razorpayPaymentId }) => {
  assertOrderMatchesTrack(track, order);

  const payment = await razorpay.payments.fetch(razorpayPaymentId);
  const expectedAmount = expectedTrackAmount(track);

  if (payment.order_id !== razorpayOrderId) {
    throw Object.assign(new Error("Payment does not belong to this order."), { status: 400 });
  }

  if (Number(payment.amount) !== expectedAmount || payment.currency !== "INR") {
    throw Object.assign(new Error("Paid amount does not match the required track amount."), { status: 400 });
  }

  if (payment.status !== "captured") {
    throw Object.assign(new Error("Payment is not captured yet. Audio will unlock after payment is complete."), {
      status: 402,
    });
  }

  return payment;
};

app.post(
  "/api/upload",
  asyncHandler(async (req, res) => {
    const { title, clientName, clientEmail, price, driveLink } = req.body;

    if (!title || !clientName || !clientEmail || !price || Number(price) <= 0) {
      return res.status(400).json({ error: "Title, client details, and valid price are required." });
    }

    if (!driveLink) {
      return res.status(400).json({ error: "Google Drive link is required." });
    }

    // Validate that it's a Google Drive link
    if (!driveLink.includes("drive.google.com") && !driveLink.includes("docs.google.com")) {
      return res.status(400).json({ error: "Please provide a valid Google Drive link." });
    }

    const track = await createTrack({
      title: title.trim(),
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      price: Number(price),
      producerName: PRODUCER_NAME,
      driveLink: driveLink.trim(),
      fileName: "Google Drive file",
      mimeType: "application/octet-stream",
      storageMode: "drive-link",
    });

    const trackLinks = buildTrackLinks(req, track.id);
    const updatedTrack = await updateTrackFields(track.id, trackLinks);

    res.status(201).json({
      trackId: updatedTrack.id,
      title: updatedTrack.title,
      link: updatedTrack.deliveryLink,
      linkPath: updatedTrack.linkPath,
    });
  }),
);

app.get(
  "/api/tracks",
  asyncHandler(async (_req, res) => {
    const tracks = await listTracks();
    res.json({ tracks: tracks.map(publicTrack) });
  }),
);

app.get(
  "/api/track/:id",
  asyncHandler(async (req, res) => {
    const track = await getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }

    const trackData = {
      ...publicTrack(track),
      previewUrl: `/api/preview/${encodeURIComponent(track.id)}`,
      audioUrl: `/api/audio/${encodeURIComponent(track.id)}`,
    };

    // Include drive link if paid
    if (track.status === "PAID" && track.driveLink) {
      trackData.driveLink = track.driveLink;
    }

    res.json({ track: trackData });
  }),
);

app.get(
  "/api/preview/:id",
  asyncHandler(async (req, res) => {
    const track = await getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }
    let totalSize;
    const rangeHeader = req.headers.range;
    let start = 0;
    let end;

    if (track.storageMode === "gcs") {
      // storagePath is stored as "bucket/name"
      const [bucketName, ...nameParts] = (track.storagePath || "").split("/");
      const objectName = nameParts.join("/");
      const storage = createStorageClient();
      const file = storage.bucket(bucketName).file(objectName);
      const [meta] = await file.getMetadata();
      totalSize = Number(meta.size || 0);
      const previewEnd = Math.min(totalSize, PREVIEW_BYTES) - 1;

      // parse range header
      if (rangeHeader) {
        const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
        if (match) {
          const requestedStart = match[1] ? parseInt(match[1], 10) : 0;
          const requestedEnd = match[2] ? parseInt(match[2], 10) : previewEnd;
          start = Math.max(0, Math.min(Number.isNaN(requestedStart) ? 0 : requestedStart, previewEnd));
          end = Math.min(Number.isNaN(requestedEnd) ? previewEnd : requestedEnd, previewEnd);
          if (end < start) end = start;
        }
      } else {
        end = previewEnd;
      }

      res.setHeader("Content-Type", track.mimeType || "audio/mpeg");
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Length", end - start + 1);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
      res.status(rangeHeader ? 206 : 200);

      const stream = file.createReadStream({ start, end });
      stream.on("error", (err) => {
        console.error("GCS stream error:", err);
        res.destroy(err);
      });
      stream.pipe(res);
      return;
    }

    // Local fallback
    const stat = await fs.promises.stat(track.storagePath);
    totalSize = stat.size;
    // Only expose the leading portion of the file as a preview.
    const previewEnd = Math.min(totalSize, PREVIEW_BYTES) - 1;

    // Parse the browser's Range header so the audio player can seek and
    // calculate duration correctly. Requests beyond the preview window are
    // clamped to the preview boundary.
    start = 0;
    end = previewEnd;

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const requestedStart = match[1] ? parseInt(match[1], 10) : 0;
        const requestedEnd = match[2] ? parseInt(match[2], 10) : previewEnd;
        start = Math.max(0, Math.min(Number.isNaN(requestedStart) ? 0 : requestedStart, previewEnd));
        end = Math.min(Number.isNaN(requestedEnd) ? previewEnd : requestedEnd, previewEnd);
        if (end < start) end = start;
      }
    }

    res.setHeader("Content-Type", track.mimeType || "audio/mpeg");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Content-Length", end - start + 1);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${totalSize}`);
    res.status(rangeHeader ? 206 : 200);

    fs.createReadStream(track.storagePath, { start, end }).pipe(res);
  }),
);

app.get(
  "/api/audio/:id",
  asyncHandler(async (req, res) => {
    const track = await getTrackById(req.params.id);

    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }

    if (track.status !== "PAID") {
      return res.status(403).json({ error: "Payment required to play the full audio." });
    }

        if (track.storageMode === "gcs") {
          const [bucketName, ...nameParts] = (track.storagePath || "").split("/");
          const objectName = nameParts.join("/");
          const storage = createStorageClient();
          const file = storage.bucket(bucketName).file(objectName);
          const [meta] = await file.getMetadata();
          const totalSize = Number(meta.size || 0);

          const rangeHeader = req.headers.range;
          let start2 = 0;
          let end2 = totalSize - 1;

          if (rangeHeader) {
            const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
            if (match) {
              const requestedStart = match[1] ? parseInt(match[1], 10) : 0;
              const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
              start2 = Math.max(0, Math.min(Number.isNaN(requestedStart) ? 0 : requestedStart, totalSize - 1));
              end2 = Math.max(0, Math.min(Number.isNaN(requestedEnd) ? totalSize - 1 : requestedEnd, totalSize - 1));
              if (end2 < start2) end2 = start2;
            }
          }

          res.setHeader("Content-Type", track.mimeType || "audio/mpeg");
          res.setHeader("Accept-Ranges", "bytes");
          res.setHeader("Content-Length", end2 - start2 + 1);
          res.setHeader("Content-Range", `bytes ${start2}-${end2}/${totalSize}`);
          res.status(rangeHeader ? 206 : 200);

          const stream = file.createReadStream({ start: start2, end: end2 });
          stream.on("error", (err) => {
            console.error("GCS stream error:", err);
            res.destroy(err);
          });
          stream.pipe(res);
          return;
        }

        const stat = await fs.promises.stat(track.storagePath);
        const totalSize = stat.size;

        // For local fallback (full audio)
        const rangeHeader2 = req.headers.range;
        let start2 = 0;
        let end2 = totalSize - 1;

        if (rangeHeader2) {
          const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader2);
          if (match) {
            const requestedStart = match[1] ? parseInt(match[1], 10) : 0;
            const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
            start2 = Math.max(0, Math.min(Number.isNaN(requestedStart) ? 0 : requestedStart, totalSize - 1));
            end2 = Math.max(0, Math.min(Number.isNaN(requestedEnd) ? totalSize - 1 : requestedEnd, totalSize - 1));
            if (end2 < start2) end2 = start2;
          }
        }

        res.setHeader("Content-Type", track.mimeType || "audio/mpeg");
        res.setHeader("Accept-Ranges", "bytes");
        res.setHeader("Content-Length", end2 - start2 + 1);
        res.setHeader("Content-Range", `bytes ${start2}-${end2}/${totalSize}`);
        res.status(rangeHeader2 ? 206 : 200);

        fs.createReadStream(track.storagePath, { start: start2, end: end2 }).pipe(res);
  }),
);

app.post(
  "/api/payment/order",
  asyncHandler(async (req, res) => {
    const { trackId } = req.body;
    const track = await getTrackById(trackId);

    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }

    if (track.status === "PAID") {
      return res.status(409).json({ error: "This track is already paid and unlocked." });
    }

    requireRazorpayConfig();

    const amount = expectedTrackAmount(track);
    const order = await razorpay.orders.create({
      amount,
      currency: "INR",
      receipt: `track_${track.id.slice(0, 24)}`,
      notes: {
        trackId: track.id,
        title: track.title,
        clientEmail: track.clientEmail,
      },
    });

    await attachOrderToTrack({
      trackId: track.id,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
    });

    res.json({
      keyId: process.env.RAZORPAY_KEY_ID,
      order,
      track: publicTrack(track),
    });
  }),
);

app.post(
  "/api/payment/verify",
  asyncHandler(async (req, res) => {
    const { trackId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!trackId || !razorpay_order_id || !razorpay_payment_id) {
      return res.status(400).json({ error: "Payment verification payload is incomplete." });
    }

    const track = await getTrackById(trackId);
    const order = await getOrderById(razorpay_order_id);

    if (!track || !order || order.trackId !== track.id) {
      return res.status(400).json({ error: "Payment order does not match this track." });
    }

    requireRazorpayConfig();

    if (!razorpay_signature) {
      return res.status(400).json({ error: "Payment verification payload is incomplete." });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
      .update(`${razorpay_order_id}|${razorpay_payment_id}`)
      .digest("hex");

    const expectedBuffer = Buffer.from(expectedSignature);
    const receivedBuffer = Buffer.from(razorpay_signature);

    if (
      expectedBuffer.length !== receivedBuffer.length ||
      !crypto.timingSafeEqual(expectedBuffer, receivedBuffer)
    ) {
      return res.status(400).json({ error: "Invalid payment signature." });
    }

    await assertPaymentUnlocksTrack({
      track,
      order,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

    const paidTrack = await markTrackPaid({
      trackId: track.id,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
    });

res.json({
      verified: true,
      track: {
        ...publicTrack(paidTrack),
        previewUrl: `/api/preview/${encodeURIComponent(paidTrack.id)}`,
        audioUrl: `/api/audio/${encodeURIComponent(paidTrack.id)}`,
      },
    });
  }),
);

app.post(
  "/api/payment/webhook",
  asyncHandler(async (req, res) => {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!webhookSecret) {
      return res.status(204).send();
    }

    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto.createHmac("sha256", webhookSecret).update(req.body).digest("hex");

    if (
      !signature ||
      Buffer.from(expected).length !== Buffer.from(signature).length ||
      !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))
    ) {
      return res.status(400).json({ error: "Invalid webhook signature." });
    }

    const event = JSON.parse(req.body.toString("utf8"));
    if (event.event === "payment.captured") {
      const payment = event.payload.payment.entity;
      const order = await getOrderById(payment.order_id);
      if (order?.trackId) {
        const track = await getTrackById(order.trackId);
        if (
          !track ||
          Number(payment.amount) !== expectedTrackAmount(track) ||
          payment.currency !== "INR" ||
          Number(order.amount) !== expectedTrackAmount(track) ||
          order.currency !== "INR"
        ) {
          return res.status(400).json({ error: "Webhook payment amount does not match the track amount." });
        }

        await markTrackPaid({
          trackId: order.trackId,
          razorpayOrderId: payment.order_id,
          razorpayPaymentId: payment.id,
        });
      }
    }

    res.status(204).send();
  }),
);

app.get(
  "/api/download/:id",
  asyncHandler(async (req, res) => {
    const track = await getTrackById(req.params.id);

    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }

    if (track.status !== "PAID") {
      return res.status(403).json({ error: "Payment required before download." });
    }

    if (track.storageMode === "gcs") {
      // Provide a signed URL for download
      try {
        const [bucketName, ...nameParts] = (track.storagePath || "").split("/");
        const objectName = nameParts.join("/");
        const storage = createStorageClient();
        const file = storage.bucket(bucketName).file(objectName);
        const [url] = await file.getSignedUrl({
          version: "v4",
          action: "read",
          expires: Date.now() + 60 * 60 * 1000, // 1 hour
        });
        return res.redirect(url);
      } catch (err) {
        console.error("Failed to generate signed URL:", err);
        return res.status(500).json({ error: "Could not provide download." });
      }
    }

    res.download(track.storagePath, track.fileName || `${track.id}.audio`);
  }),
);

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.message });
  }

  const status = error.status || 500;
  res.status(status).json({
    error: status === 500 ? "Server error. Check logs for details." : error.message,
  });
  console.error(error);
});

if (!process.env.VERCEL) {
  const server = app.listen(PORT, () => {
    console.log(`MasterDrop server running at http://localhost:${PORT}`);
    console.log(`Database mode: ${databaseMode}`);
    if (!hasRazorpayConfig()) {
      console.log("Razorpay credentials not found. Real payments are disabled until credentials are configured.");
    }
  });

  server.on("error", (error) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use.`);
      console.error(`Stop the other process or start this app with another port, for example:`);
      console.error(`$env:PORT=3001; npm start`);
      process.exit(1);
    }

    throw error;
  });
} else {
  console.log("Detected Vercel environment; not starting HTTP listener.");
}

// Export the app so serverless platforms (Vercel, Netlify) can wrap it.
module.exports = app;
