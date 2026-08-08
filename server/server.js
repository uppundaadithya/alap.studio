require("dotenv").config();

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
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
} = require("./database");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const PRODUCER_NAME = process.env.PRODUCER_NAME || "Aalap Studio";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "alap-admin-change-me";
// Razorpay Payment Page used when API credentials are not configured.
const PAYMENT_PAGE_URL =
  process.env.RAZORPAY_PAYMENT_LINK || "https://razorpay.me/@adithya8106";
const PREVIEW_BYTES = Number(process.env.PREVIEW_BYTES || 1024 * 1024 * 2);
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const PRIVATE_UPLOAD_DIR = path.join(__dirname, "private_uploads");

fs.mkdirSync(PRIVATE_UPLOAD_DIR, { recursive: true });

const hasRazorpayConfig = () => Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
const razorpay = hasRazorpayConfig()
  ? new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    })
  : null;

const allowedMimeTypes = new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/wave"]);

const storage = multer.diskStorage({
  destination: (_req, _file, callback) => callback(null, PRIVATE_UPLOAD_DIR),
  filename: (_req, file, callback) => {
    const extension = path.extname(file.originalname).toLowerCase();
    callback(null, `${uuidv4()}${extension}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 200 * 1024 * 1024),
  },
  fileFilter: (_req, file, callback) => {
    if (!allowedMimeTypes.has(file.mimetype)) {
      callback(new Error("Only WAV and MP3 files are allowed."));
      return;
    }
    callback(null, true);
  },
});

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
        ],
        connectSrc: ["'self'", "https://*.razorpay.com"],
        frameSrc: ["https://api.razorpay.com", "https://checkout.razorpay.com"],
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
app.use(express.static(PUBLIC_DIR));

const asyncHandler = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

const requireRazorpayConfig = () => {
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    throw Object.assign(new Error("Razorpay credentials are not configured."), { status: 500 });
  }
};

const removeUploadedFile = (file) => {
  if (file?.path) {
    fs.promises.unlink(file.path).catch(() => {});
  }
};

const centsFromInr = (price) => Math.round(Number(price) * 100);

app.post(
  "/api/upload",
  upload.single("audio"),
  asyncHandler(async (req, res) => {
    const { title, clientName, clientEmail, price } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Audio file is required." });
    }

    if (!title || !clientName || !clientEmail || !price || Number(price) <= 0) {
      removeUploadedFile(req.file);
      return res.status(400).json({ error: "Title, client details, and valid price are required." });
    }

    const track = await createTrack({
      title: title.trim(),
      clientName: clientName.trim(),
      clientEmail: clientEmail.trim().toLowerCase(),
      price: Number(price),
      producerName: PRODUCER_NAME,
      fileName: req.file.originalname,
      mimeType: req.file.mimetype,
      storagePath: req.file.path,
      storageMode: "local-private",
    });

    res.status(201).json({
      trackId: track.id,
      title: track.title,
      link: `/track.html?id=${track.id}`,
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

    res.json({
      track: {
        ...publicTrack(track),
        previewUrl: `/api/preview/${encodeURIComponent(track.id)}`,
        audioUrl: `/api/audio/${encodeURIComponent(track.id)}`,
      },
    });
  }),
);

app.get(
  "/api/preview/:id",
  asyncHandler(async (req, res) => {
    const track = await getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: "Track not found." });
    }

    const stat = await fs.promises.stat(track.storagePath);
    const totalSize = stat.size;
    // Only expose the leading portion of the file as a preview.
    const previewEnd = Math.min(totalSize, PREVIEW_BYTES) - 1;

    // Parse the browser's Range header so the audio player can seek and
    // calculate duration correctly. Requests beyond the preview window are
    // clamped to the preview boundary.
    const rangeHeader = req.headers.range;
    let start = 0;
    let end = previewEnd;

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

    const stat = await fs.promises.stat(track.storagePath);
    const totalSize = stat.size;

    const rangeHeader = req.headers.range;
    let start = 0;
    let end = totalSize - 1;

    if (rangeHeader) {
      const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
      if (match) {
        const requestedStart = match[1] ? parseInt(match[1], 10) : 0;
        const requestedEnd = match[2] ? parseInt(match[2], 10) : totalSize - 1;
        start = Math.max(0, Math.min(Number.isNaN(requestedStart) ? 0 : requestedStart, totalSize - 1));
        end = Math.max(0, Math.min(Number.isNaN(requestedEnd) ? totalSize - 1 : requestedEnd, totalSize - 1));
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

    if (!hasRazorpayConfig()) {
      const order = {
        id: `demo_order_${uuidv4()}`,
        amount: centsFromInr(track.price),
        currency: "INR",
        status: "created",
      };

      await attachOrderToTrack({
        trackId: track.id,
        razorpayOrderId: order.id,
        amount: order.amount,
        currency: order.currency,
      });

      return res.json({
        demoMode: true,
        paymentPageUrl: PAYMENT_PAGE_URL,
        order,
        track: publicTrack(track),
      });
    }

    requireRazorpayConfig();

    const order = await razorpay.orders.create({
      amount: centsFromInr(track.price),
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

    if (!hasRazorpayConfig()) {
      if (!razorpay_order_id.startsWith("demo_order_") || !razorpay_payment_id.startsWith("demo_payment_")) {
        return res.status(400).json({ error: "Invalid demo payment payload." });
      }

      const paidTrack = await markTrackPaid({
        trackId: track.id,
        razorpayOrderId: razorpay_order_id,
        razorpayPaymentId: razorpay_payment_id,
      });

return res.json({
        verified: true,
        demoMode: true,
        track: {
          ...publicTrack(paidTrack),
          previewUrl: `/api/preview/${encodeURIComponent(paidTrack.id)}`,
          audioUrl: `/api/audio/${encodeURIComponent(paidTrack.id)}`,
        },
      });
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

app.listen(PORT, () => {
  console.log(`MasterDrop server running at http://localhost:${PORT}`);
  console.log(`Database mode: ${databaseMode}`);
  if (!hasRazorpayConfig()) {
    console.log("Razorpay credentials not found. Payment runs in local demo unlock mode.");
  }
});
