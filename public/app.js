import { initializeApp } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-app.js";
import { getAnalytics } from "https://www.gstatic.com/firebasejs/9.22.1/firebase-analytics.js";

const firebaseConfig = {
  apiKey: "AIzaSyCjG381SVbOjSdRbjXSnjK6imREZunXmfc",
  authDomain: "studio-b9a3b.firebaseapp.com",
  databaseURL: "https://studio-b9a3b-default-rtdb.firebaseio.com",
  projectId: "studio-b9a3b",
  storageBucket: "studio-b9a3b.firebasestorage.app",
  messagingSenderId: "974529192259",
  appId: "1:974529192259:web:dd3f45858e0beca5c14ff6",
  measurementId: "G-JM94Y6HDE8",
};

const firebaseApp = initializeApp(firebaseConfig);
let analytics;
try {
  analytics = getAnalytics(firebaseApp);
} catch (error) {
  console.info("Firebase analytics not initialized:", error);
}

const state = {
  currentTrack: null,
};

const formatCurrency = (value) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));

const escapeHtml = (value = "") =>
  String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });

const requestJson = async (url, options = {}) => {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed");
  }

  return data;
};

const getTrackUrl = (id) => `${window.location.origin}/track.html?id=${encodeURIComponent(id)}`;

const setMessage = (element, text, type = "") => {
  if (!element) return;
  element.textContent = text;
  element.className = `message ${type}`.trim();
};

const copyToClipboard = async (text) => {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
};

const loadDashboardTracks = async () => {
  const table = document.querySelector("#tracksTable");
  if (!table) return;

  try {
    const { tracks } = await requestJson("/api/tracks");
    const totalTracks = document.querySelector("#totalTracks");
    const paidTracks = document.querySelector("#paidTracks");

    totalTracks.textContent = tracks.length;
    paidTracks.textContent = tracks.filter((track) => track.status === "PAID").length;

    if (!tracks.length) {
      table.innerHTML = '<tr><td colspan="5" class="muted-cell">No tracks uploaded yet.</td></tr>';
      return;
    }

    table.innerHTML = tracks
      .map((track) => {
        const link = getTrackUrl(track.id);
        const statusClass = track.status === "PAID" ? "paid" : "pending";
        return `
          <tr>
            <td>
              <strong>${escapeHtml(track.title)}</strong><br />
              <small>${escapeHtml(track.fileName || "Audio master")}</small>
            </td>
            <td>
              ${escapeHtml(track.clientName)}<br />
              <small>${escapeHtml(track.clientEmail)}</small>
            </td>
            <td>${formatCurrency(track.price)}</td>
            <td><span class="status ${statusClass}">${track.status}</span></td>
            <td><a class="link-button" href="${link}" target="_blank" rel="noreferrer">Open</a></td>
          </tr>
        `;
      })
      .join("");
  } catch (error) {
    table.innerHTML = `<tr><td colspan="5" class="muted-cell">${escapeHtml(error.message)}</td></tr>`;
  }
};

const initDashboard = () => {
  const form = document.querySelector("#uploadForm");
  const message = document.querySelector("#uploadMessage");
  const shareResult = document.querySelector("#shareResult");

  loadDashboardTracks();

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector("button[type='submit']");
    const formData = new FormData(form);
    submitButton.disabled = true;
    setMessage(message, "Uploading your master...");

    try {
      const result = await requestJson("/api/upload", {
        method: "POST",
        body: formData,
      });

      const shareUrl = getTrackUrl(result.trackId);
      shareResult.className = "share-box";
      shareResult.innerHTML = `
        <strong>${escapeHtml(result.title)}</strong>
        <a href="${shareUrl}" target="_blank" rel="noreferrer">${shareUrl}</a>
        <div class="action-row" style="margin-top: 14px;">
          <button id="copyShareLink" class="secondary-button" type="button">Copy link</button>
        </div>
      `;

      document.querySelector("#copyShareLink")?.addEventListener("click", async () => {
        await copyToClipboard(shareUrl);
        setMessage(message, "Share link copied.", "success");
      });

      form.reset();
      setMessage(message, "Track uploaded and secure link generated.", "success");
      await loadDashboardTracks();
    } catch (error) {
      setMessage(message, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });
};

const renderTrack = (track) => {
  const card = document.querySelector("#trackCard");
  const paid = track.status === "PAID";

  card.innerHTML = `
    <a class="brand-mark compact" href="/" aria-label="ALAP home">
      <img src="/alap-logo.png" alt="ALAP Music & SFX" />
    </a>
    <p class="eyebrow">ALAP delivery</p>
    <h1>${escapeHtml(track.title)}</h1>
    <p class="lede">
      Prepared for ${escapeHtml(track.clientName)} by ${escapeHtml(track.producerName)}.
    </p>

    <div class="track-meta">
      <span class="meta-pill">${escapeHtml(track.fileName || "Audio master")}</span>
      <span class="meta-pill">${paid ? "Payment complete" : "Payment pending"}</span>
    </div>

${
      paid
        ? `
      <div class="audio-panel unlocked">
        <p class="eyebrow">Full audio</p>
        <audio controls preload="metadata" src="${track.audioUrl}"></audio>
      </div>
    `
        : `
      <div class="audio-panel locked">
        <p class="eyebrow">Preview</p>
        <audio controls preload="metadata" src="${track.previewUrl}"></audio>
        <div class="lock-overlay">
          <span class="lock-icon" aria-hidden="true">&#128274;</span>
          <strong>Preview only</strong>
          <p>Pay to unlock the full audio player.</p>
        </div>
      </div>
    `
    }

    <div class="price-line">
      <span>${paid ? "Full audio unlocked" : "Unlock full-quality audio"}</span>
      <strong>${formatCurrency(track.price)}</strong>
    </div>

    <div id="paymentActions" class="action-row">
      ${
        paid
          ? `<a class="primary-button download-button" href="/api/download/${encodeURIComponent(track.id)}">Download Full Quality Audio</a>`
          : `<button id="payButton" class="primary-button" type="button">Pay & Unlock Audio</button>`
      }
    </div>
    <p id="paymentMessage" class="message" role="status" aria-live="polite"></p>
  `;

  if (!paid) {
    document.querySelector("#payButton")?.addEventListener("click", () => startPayment(track.id));
  }
};

const loadTrackPage = async () => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("id");
  const card = document.querySelector("#trackCard");

  if (!id) {
    card.innerHTML = `
      <p class="eyebrow">Missing link</p>
      <h1>Track ID not found.</h1>
      <p class="lede">Ask the producer for a complete delivery link.</p>
    `;
    return;
  }

  try {
    const { track } = await requestJson(`/api/track/${encodeURIComponent(id)}`);
    state.currentTrack = track;
    renderTrack(track);
  } catch (error) {
    card.innerHTML = `
      <p class="eyebrow">Unavailable</p>
      <h1>Track could not be loaded.</h1>
      <p class="lede">${escapeHtml(error.message)}</p>
    `;
  }
};

const startPayment = async (trackId) => {
  const button = document.querySelector("#payButton");
  const message = document.querySelector("#paymentMessage");
  button.disabled = true;
  setMessage(message, "Creating secure payment order...");

  try {
    const { order, keyId, track } = await requestJson("/api/payment/order", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });

    const checkout = new Razorpay({
      key: keyId,
      amount: order.amount,
      currency: order.currency,
      name: "ALAP Music & SFX",
      description: track.title,
      order_id: order.id,
      prefill: {
        name: track.clientName,
        email: track.clientEmail,
      },
      theme: {
        color: "#ff3038",
      },
      handler: async (response) => {
        setMessage(message, "Verifying payment...");

        const verification = await requestJson("/api/payment/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            trackId,
            razorpay_order_id: response.razorpay_order_id,
            razorpay_payment_id: response.razorpay_payment_id,
            razorpay_signature: response.razorpay_signature,
          }),
        });

        state.currentTrack = verification.track;
        renderTrack(verification.track);
        setMessage(document.querySelector("#paymentMessage"), "Payment verified. Download unlocked.", "success");
      },
      modal: {
        ondismiss: () => {
          button.disabled = false;
          setMessage(message, "Payment was cancelled. You can try again when ready.");
        },
      },
    });

    checkout.open();
  } catch (error) {
    button.disabled = false;
    setMessage(message, error.message, "error");
  }
};

document.addEventListener("DOMContentLoaded", () => {
  const page = document.body.dataset.page;
  if (page === "dashboard") initDashboard();
  if (page === "track") loadTrackPage();
});
