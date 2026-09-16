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

const loadDashboardPayments = async () => {
  const table = document.querySelector("#paymentsTable");
  if (!table) return;

  try {
    const { payments, summary } = await requestJson("/api/payments");

    if (!payments.length) {
      table.innerHTML = '<tr><td colspan="5" class="muted-cell">No payments received yet.</td></tr>';
      return;
    }

    table.innerHTML = payments
      .map((payment) => {
        const paidDate = new Date(payment.paidAt).toLocaleDateString('en-IN', {
          year: 'numeric',
          month: 'short',
          day: 'numeric'
        });
        return `
          <tr>
            <td>
              <strong>${escapeHtml(payment.title)}</strong>
            </td>
            <td>
              ${escapeHtml(payment.clientName)}<br />
              <small>${escapeHtml(payment.clientEmail)}</small>
            </td>
            <td><strong>${formatCurrency(payment.amount)}</strong></td>
            <td><span class="status paid">${payment.status}</span></td>
            <td>${paidDate}</td>
          </tr>
        `;
      })
      .join("");
  } catch (error) {
    table.innerHTML = `<tr><td colspan="5" class="muted-cell">${escapeHtml(error.message)}</td></tr>`;
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
        const link = track.deliveryLink || getTrackUrl(track.id);
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

  loadDashboardPayments();
  loadDashboardTracks();

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector("button[type='submit']");
    submitButton.disabled = true;
    setMessage(message, "Saving your track...");

    try {
      const formData = new FormData(form);
      const data = {
        title: formData.get("title"),
        clientName: formData.get("clientName"),
        clientEmail: formData.get("clientEmail"),
        price: formData.get("price"),
        driveLink: formData.get("driveLink"),
        password: formData.get("password") || "",
      };

      const result = await requestJson("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      const shareUrl = result.link || getTrackUrl(result.trackId);
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
      setMessage(message, "Track saved and secure link generated.", "success");
      await loadDashboardTracks();
    } catch (error) {
      setMessage(message, error.message, "error");
    } finally {
      submitButton.disabled = false;
    }
  });

  document.querySelector("#refreshPayments")?.addEventListener("click", async () => {
    const btn = document.querySelector("#refreshPayments");
    btn.disabled = true;
    btn.textContent = "↻ Refreshing...";
    await loadDashboardPayments();
    btn.disabled = false;
    btn.textContent = "↻ Refresh";
  });
};

const renderTrack = (track) => {
  const card = document.querySelector("#trackCard");
  
  // ❌ STRICT CHECK: Only show link if payment status is PAID AND link exists
  const paid = track.status === "PAID" && track.driveLink;
  
  if (track.status === "PAID" && !track.driveLink) {
    console.warn("⚠️ WARNING: Track marked as PAID but driveLink is missing!");
  }

  console.log(`Track Status: ${track.status} | Has Drive Link: ${!!track.driveLink} | Locked: ${!paid}`);

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

${paid ? `
      <div class="delivery-panel unlocked">
        <p class="eyebrow">Download link</p>
        <div class="drive-link-box">
          <a href="${track.driveLink}" target="_blank" rel="noreferrer" class="drive-link">${escapeHtml(track.driveLink)}</a>
        </div>
        ${track.password ? `
        <p class="eyebrow" style="margin-top: 16px; margin-bottom: 8px;">Password</p>
        <div class="password-box">
          <code class="password-text">${escapeHtml(track.password)}</code>
          <button id="copyPassword" class="password-copy-btn" type="button" title="Copy password">📋</button>
        </div>
        ` : ''}
      </div>
    ` : `
      <div class="delivery-panel locked">
        <p class="eyebrow">Download link</p>
        <p class="lock-message">🔒 Link will be available after payment is verified</p>
      </div>
    `}

    <div class="price-line">
      <span>${paid ? "Full audio unlocked" : "Unlock full-quality audio"}</span>
      <strong>${formatCurrency(track.price)}</strong>
    </div>

    <div id="paymentActions" class="action-row">
      ${paid ? `<button id="copyLink" class="primary-button" type="button">Copy Link</button>` : `<button id="payButton" class="primary-button" type="button">Pay ${formatCurrency(track.price)} & Unlock</button>`}
    </div>
    <p id="paymentMessage" class="message" role="status" aria-live="polite"></p>
  `;

  if (!paid) {
    document.querySelector("#payButton")?.addEventListener("click", () => startPayment(track.id));
  } else {
    document.querySelector("#copyLink")?.addEventListener("click", async () => {
      await copyToClipboard(track.driveLink);
      setMessage(document.querySelector("#paymentMessage"), "Link copied to clipboard.", "success");
    });
    document.querySelector("#copyPassword")?.addEventListener("click", async () => {
      await copyToClipboard(track.password);
      setMessage(document.querySelector("#paymentMessage"), "Password copied to clipboard.", "success");
    });
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
    console.log(`Loading track: ${id}`);
    const { track } = await requestJson(`/api/track/${encodeURIComponent(id)}`);
    
    console.log(`✓ Track loaded | Status: ${track.status} | Has Drive Link: ${!!track.driveLink}`);
    
    if (track.status === "PAID" && !track.driveLink) {
      console.error("⚠️ SECURITY WARNING: Track status is PAID but driveLink is missing!");
      throw new Error("Track data is incomplete. Please contact support.");
    }
    
    state.currentTrack = track;
    renderTrack(track);
  } catch (error) {
    console.error(`✗ Failed to load track: ${error.message}`);
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
        setMessage(message, "Verifying payment in your Razorpay account...");

        try {
          console.log("Payment response received:", response.razorpay_payment_id);
          
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

          if (!verification.verified) {
            throw new Error("Payment could not be verified.");
          }

          if (!verification.track.driveLink) {
            console.error("❌ SECURITY: Payment verified but driveLink is missing!");
            throw new Error("Payment verified but link data is missing. Please contact support.");
          }

          console.log("✅ Payment verified successfully");
          state.currentTrack = verification.track;
          renderTrack(verification.track);
          setMessage(
            document.querySelector("#paymentMessage"), 
            "✅ Payment verified & credited to your account. Link unlocked!",
            "success"
          );
        } catch (error) {
          console.error("❌ Payment verification failed:", error.message);
          
          // Show clear error message without unlocking link
          const errorMessage = error.message.includes("not captured")
            ? "⏳ Payment is processing. This can take a few moments. Please wait and refresh the page."
            : "❌ Payment verification failed: " + error.message;
          
          setMessage(
            document.querySelector("#paymentMessage"), 
            errorMessage,
            "error"
          );
          
          // DO NOT render track - link stays locked
          console.warn("Link NOT unlocked - payment not verified");
        }
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
