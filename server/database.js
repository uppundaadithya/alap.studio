const fs = require("fs");
const path = require("path");
const os = require("os");
const { randomUUID } = require("crypto");

// Diagnose optional Google Cloud client requires so initialization failures
// surface as clear console errors instead of crashing the whole module.
let FieldValue = null;
let Firestore = null;
let Storage = null;
try {
  const _firestore = require("@google-cloud/firestore");
  FieldValue = _firestore.FieldValue;
  Firestore = _firestore.Firestore || _firestore.default || _firestore;
} catch (err) {
  console.error("Could not require @google-cloud/firestore:", err && err.message);
}

try {
  const _storage = require("@google-cloud/storage");
  Storage = _storage.Storage || _storage.default || _storage;
} catch (err) {
  console.error("Could not require @google-cloud/storage:", err && err.message);
}

const LOCAL_DATA_DIR = process.env.LOCAL_DATA_DIR || path.join(os.tmpdir(), "alap_private_data");
const LOCAL_DATA_FILE = path.join(LOCAL_DATA_DIR, "tracks.json");

const isPlaceholder = (value = "") =>
  value.includes("replace_with") || value.includes("firebase-adminsdk@example") || value.includes("your_");

const hasFirebaseCredentials = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    return !isPlaceholder(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
  }

  return Boolean(
    process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY &&
      !isPlaceholder(process.env.FIREBASE_CLIENT_EMAIL) &&
      !isPlaceholder(process.env.FIREBASE_PRIVATE_KEY),
  );
};

const parseServiceAccount = () => {
  if (process.env.FIREBASE_SERVICE_ACCOUNT_JSON) {
    const parsed = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
    const privateKey = parsed.private_key || parsed.privateKey;

    return {
      projectId: parsed.project_id || parsed.projectId,
      clientEmail: parsed.client_email || parsed.clientEmail,
      privateKey: privateKey?.replace(/\\n/g, "\n"),
    };
  }

  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  };
};

const createFirestoreClient = () => {
  if (!Firestore) {
    throw new Error("@google-cloud/firestore module not available. Ensure dependency is installed.");
  }

  const serviceAccount = parseServiceAccount();

  if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
    throw new Error("Firebase service account credentials are incomplete.");
  }

  return new Firestore({
    projectId: serviceAccount.projectId,
    credentials: {
      client_email: serviceAccount.clientEmail,
      private_key: serviceAccount.privateKey,
    },
  });
};

const createStorageClient = () => {
  if (!Storage) {
    throw new Error("@google-cloud/storage module not available. Ensure dependency is installed.");
  }

  const serviceAccount = parseServiceAccount();
  if (!serviceAccount.projectId || !serviceAccount.clientEmail || !serviceAccount.privateKey) {
    throw new Error("Firebase service account credentials are incomplete for storage.");
  }

  return new Storage({
    projectId: serviceAccount.projectId,
    credentials: {
      client_email: serviceAccount.clientEmail,
      private_key: serviceAccount.privateKey,
    },
  });
};

// Helpers for uploading to and generating signed URLs from Firebase/GCS storage.
const getStorageBucket = () => {
  const storage = createStorageClient();
  const serviceAccount = parseServiceAccount();
  const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.projectId}.appspot.com`;
  return storage.bucket(bucketName);
};

const uploadBufferToStorage = async (buffer, destination, contentType) => {
  const bucket = getStorageBucket();
  const file = bucket.file(destination);
  await file.save(buffer, { metadata: { contentType } });
  return { bucket: bucket.name, name: destination };
};

const getSignedUrlForFile = async (destination, expiresSeconds = 60 * 60) => {
  const bucket = getStorageBucket();
  const file = bucket.file(destination);
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresSeconds * 1000,
  });
  return url;
};

const serializeFirestoreTrack = (snapshot) => {
  if (!snapshot.exists) return null;

  const data = snapshot.data();
  return {
    id: snapshot.id,
    title: data.title,
    clientName: data.clientName,
    clientEmail: data.clientEmail,
    producerName: data.producerName,
    price: data.price,
    status: data.status,
    fileName: data.fileName,
    mimeType: data.mimeType,
    storagePath: data.storagePath,
    createdAt: data.createdAt?.toDate?.().toISOString() || data.createdAt || null,
    paidAt: data.paidAt?.toDate?.().toISOString() || data.paidAt || null,
    razorpayOrderId: data.razorpayOrderId || null,
    razorpayPaymentId: data.razorpayPaymentId || null,
  };
};

const readLocalData = async () => {
  await fs.promises.mkdir(LOCAL_DATA_DIR, { recursive: true });

  try {
    const raw = await fs.promises.readFile(LOCAL_DATA_FILE, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { tracks: {}, orders: {} };
  }
};

const writeLocalData = async (data) => {
  await fs.promises.mkdir(LOCAL_DATA_DIR, { recursive: true });
  await fs.promises.writeFile(LOCAL_DATA_FILE, JSON.stringify(data, null, 2));
};

const createLocalStore = () => ({
  mode: "local-demo",

  async createTrack(track) {
    const data = await readLocalData();
    const id = randomUUID();
    const now = new Date().toISOString();

    data.tracks[id] = {
      id,
      ...track,
      price: Number(track.price),
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    };

    await writeLocalData(data);
    return data.tracks[id];
  },

  async getTrackById(id) {
    const data = await readLocalData();
    return data.tracks[id] || null;
  },

  async listTracks() {
    const data = await readLocalData();
    return Object.values(data.tracks).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  },

  async attachOrderToTrack({ trackId, razorpayOrderId, amount, currency }) {
    const data = await readLocalData();
    const now = new Date().toISOString();

    if (!data.tracks[trackId]) {
      throw Object.assign(new Error("Track not found."), { status: 404 });
    }

    data.orders[razorpayOrderId] = {
      id: razorpayOrderId,
      trackId,
      amount,
      currency,
      status: "CREATED",
      createdAt: now,
      updatedAt: now,
    };
    data.tracks[trackId].razorpayOrderId = razorpayOrderId;
    data.tracks[trackId].updatedAt = now;

    await writeLocalData(data);
  },

  async getOrderById(orderId) {
    const data = await readLocalData();
    return data.orders[orderId] || null;
  },

  async markTrackPaid({ trackId, razorpayOrderId, razorpayPaymentId }) {
    const data = await readLocalData();
    const now = new Date().toISOString();

    if (!data.tracks[trackId]) {
      throw Object.assign(new Error("Track not found."), { status: 404 });
    }

    data.tracks[trackId] = {
      ...data.tracks[trackId],
      status: "PAID",
      razorpayOrderId,
      razorpayPaymentId,
      paidAt: now,
      updatedAt: now,
    };

    data.orders[razorpayOrderId] = {
      ...(data.orders[razorpayOrderId] || { id: razorpayOrderId, trackId }),
      razorpayPaymentId,
      status: "PAID",
      paidAt: now,
      updatedAt: now,
    };

    await writeLocalData(data);
    return data.tracks[trackId];
  },
});

const createFirestoreStore = () => {
  const db = createFirestoreClient();
  const tracksCollection = db.collection("tracks");
  const ordersCollection = db.collection("orders");

  return {
    mode: "firestore",

    async createTrack(track) {
      const now = FieldValue.serverTimestamp();
      const docRef = await tracksCollection.add({
        ...track,
        price: Number(track.price),
        status: "PENDING",
        createdAt: now,
        updatedAt: now,
      });

      const snapshot = await docRef.get();
      return serializeFirestoreTrack(snapshot);
    },

    async getTrackById(id) {
      const snapshot = await tracksCollection.doc(id).get();
      return serializeFirestoreTrack(snapshot);
    },

    async listTracks() {
      const snapshot = await tracksCollection.orderBy("createdAt", "desc").limit(100).get();
      return snapshot.docs.map(serializeFirestoreTrack);
    },

    async attachOrderToTrack({ trackId, razorpayOrderId, amount, currency }) {
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      const trackRef = tracksCollection.doc(trackId);
      const orderRef = ordersCollection.doc(razorpayOrderId);

      batch.set(orderRef, {
        trackId,
        amount,
        currency,
        status: "CREATED",
        createdAt: now,
        updatedAt: now,
      });

      batch.update(trackRef, {
        razorpayOrderId,
        updatedAt: now,
      });

      await batch.commit();
    },

    async getOrderById(orderId) {
      const snapshot = await ordersCollection.doc(orderId).get();
      if (!snapshot.exists) return null;
      return {
        id: snapshot.id,
        ...snapshot.data(),
      };
    },

    async markTrackPaid({ trackId, razorpayOrderId, razorpayPaymentId }) {
      const now = FieldValue.serverTimestamp();
      const batch = db.batch();
      const trackRef = tracksCollection.doc(trackId);
      const orderRef = ordersCollection.doc(razorpayOrderId);

      batch.update(trackRef, {
        status: "PAID",
        razorpayOrderId,
        razorpayPaymentId,
        paidAt: now,
        updatedAt: now,
      });

      batch.set(
        orderRef,
        {
          trackId,
          razorpayPaymentId,
          status: "PAID",
          paidAt: now,
          updatedAt: now,
        },
        { merge: true },
      );

      await batch.commit();
      const snapshot = await tracksCollection.doc(trackId).get();
      return serializeFirestoreTrack(snapshot);
    },
  };
};

const store = hasFirebaseCredentials() ? createFirestoreStore() : createLocalStore();

if (store.mode === "local-demo") {
  console.warn(
    `Firebase service account credentials were not found. Running with local demo JSON storage in ${LOCAL_DATA_DIR}.`,
  );
}

const publicTrack = (track) => {
  if (!track) return null;
  const { storagePath, razorpayOrderId, razorpayPaymentId, ...safeTrack } = track;
  return safeTrack;
};

module.exports = {
  createTrack: store.createTrack,
  getOrderById: store.getOrderById,
  getTrackById: store.getTrackById,
  listTracks: store.listTracks,
  attachOrderToTrack: store.attachOrderToTrack,
  markTrackPaid: store.markTrackPaid,
  publicTrack,
  databaseMode: store.mode,
  // Storage helpers (may throw if credentials are not configured)
  uploadBufferToStorage,
  getSignedUrlForFile,
  getStorageBucket,
  createStorageClient,
  // Diagnostics: report which optional cloud modules were loaded
  __diagnostics: () => ({
    firestoreLoaded: Boolean(Firestore),
    storageLoaded: Boolean(Storage),
    env: {
      FIREBASE_SERVICE_ACCOUNT_JSON: Boolean(process.env.FIREBASE_SERVICE_ACCOUNT_JSON),
      FIREBASE_PROJECT_ID: Boolean(process.env.FIREBASE_PROJECT_ID),
      FIREBASE_CLIENT_EMAIL: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
      FIREBASE_PRIVATE_KEY: Boolean(process.env.FIREBASE_PRIVATE_KEY),
      FIREBASE_STORAGE_BUCKET: Boolean(process.env.FIREBASE_STORAGE_BUCKET),
    },
  }),
};
