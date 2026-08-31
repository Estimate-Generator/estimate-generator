const form = document.getElementById("quote-form");
const output = document.getElementById("quote-output");
const printBtn = document.getElementById("print-btn");
const analyzeBtn = document.getElementById("analyze-btn");
const analysisOutput = document.getElementById("analysis-output");
const chatMessages = document.getElementById("chat-messages");
const chatText = document.getElementById("chat-text");
const chatSend = document.getElementById("chat-send");
const micBtn = document.getElementById("mic-btn");
const atlasLanguage = document.getElementById("atlas-language");
const atlasDocumentType = document.getElementById("atlas-document-type");
const atlasTranscript = document.getElementById("atlas-transcript");
const atlasMicBtn = document.getElementById("atlas-mic-btn");
const atlasTestBtn = document.getElementById("atlas-test-btn");
const atlasGenerateBtn = document.getElementById("atlas-generate-btn");
const atlasStatus = document.getElementById("atlas-status");
const sessionId = getSessionId();
let recognition = null;
let atlasRecognition = null;
let atlasRecorder = null;
let atlasAudioChunks = [];

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  output.classList.add("loading");
  output.classList.remove("empty");
  output.textContent = "Generation en cours...";
  printBtn.disabled = true;

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.withVat = formData.get("withVat") === "on";
  payload.marginPercent = Number(payload.marginPercent || 0);
  payload.documentType = payload.documentType || "devis";

  try {
    const endpoint = payload.documentType === "facture" ? "/api/invoice" : "/api/quote";
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Erreur inconnue");
    }
    renderQuote(data);
    printBtn.disabled = false;
  } catch (error) {
    output.classList.remove("loading");
    output.textContent = `Erreur: ${error.message}`;
  }
});

analyzeBtn.addEventListener("click", async () => {
  analysisOutput.classList.add("loading");
  analysisOutput.classList.remove("empty");
  analysisOutput.textContent = "Analyse IA en cours...";
  analyzeBtn.disabled = true;

  const formData = new FormData(form);
  const payload = Object.fromEntries(formData.entries());
  payload.withVat = formData.get("withVat") === "on";
  payload.marginPercent = Number(payload.marginPercent || 0);
  payload.documentType = payload.documentType || "devis";

  try {
    const response = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Erreur inconnue");
    }
    renderAnalysis(data);
  } catch (error) {
    analysisOutput.classList.remove("loading");
    analysisOutput.textContent = `Erreur: ${error.message}`;
  } finally {
    analyzeBtn.disabled = false;
  }
});

chatSend.addEventListener("click", async () => {
  const text = chatText.value.trim();
  if (!text) return;
  chatText.value = "";
  await sendChat(text);
});

chatText.addEventListener("keydown", async (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    chatSend.click();
  }
});

micBtn.addEventListener("click", () => {
  toggleSpeech();
});

atlasMicBtn.addEventListener("click", () => {
  toggleAtlasSpeech();
});

atlasTestBtn.addEventListener("click", async () => {
  await runAtlasTest({ generate: false });
});

atlasGenerateBtn.addEventListener("click", async () => {
  await runAtlasTest({ generate: true });
});

printBtn.addEventListener("click", () => {
  window.print();
});

function renderQuote(quote) {
  const { items, totals } = quote;
  const currency = quote.currency || "MAD";
  window.currentCurrency = currency;
  const lines = items
    .map(
      (item) =>
        `<tr>
          <td>${escapeHtml(item.label)}</td>
          <td>${item.qty}</td>
          <td>${escapeHtml(item.unit)}</td>
          <td>${formatMoney(item.unitPrice)}</td>
          <td>${formatMoney(item.qty * item.unitPrice)}</td>
        </tr>`
    )
    .join("");

  output.classList.remove("loading");
  output.innerHTML = `
    <div class="quote-header">
      <div>
        <h3>${escapeHtml(quote.title)}</h3>
        <p class="muted">Entreprise: ${escapeHtml(quote.businessName || "-")}</p>
        <p class="muted">Client: ${escapeHtml(quote.clientName || "-")}</p>
        <p class="muted">Ville: ${escapeHtml(quote.city || "-")}</p>
      </div>
      <div class="quote-meta">
        <p class="muted">Date: ${formatDate(quote.issueDate) || new Date().toLocaleDateString("fr-MA")}</p>
        ${
          quote.documentType === "facture"
            ? `<p class="muted">Facture: ${escapeHtml(quote.invoiceNumber || "-")}</p>`
            : ""
        }
        ${
          quote.documentType === "facture"
            ? `<p class="muted">Echeance: ${formatDate(quote.dueDate) || "-"}</p>`
            : ""
        }
        <p class="muted">Devise: ${escapeHtml(currency)}</p>
      </div>
    </div>

    <table class="items">
      <thead>
        <tr>
          <th>Prestation</th>
          <th>Qté</th>
          <th>Unité</th>
          <th>PU (${escapeHtml(currency)})</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        ${lines}
      </tbody>
    </table>

    <div class="totals">
      <div class="total-line">
        <span>Sous-total</span>
        <strong>${formatMoney(totals.subtotal)}</strong>
      </div>
      <div class="total-line">
        <span>Marge (${totals.marginPercent}%)</span>
        <strong>${formatMoney(totals.marginAmount)}</strong>
      </div>
      <div class="total-line">
        <span>TVA (${totals.vatRate}%)</span>
        <strong>${formatMoney(totals.vatAmount)}</strong>
      </div>
      <div class="total-line grand">
        <span>Total TTC</span>
        <strong>${formatMoney(totals.total)}</strong>
      </div>
    </div>

    ${
      quote.advancePercent
        ? `<p class="notes">Acompte demande: ${quote.advancePercent}%</p>`
        : ""
    }
    <p class="notes">${escapeHtml(quote.notes || "")}</p>
    <div class="watermark">DevisAI - Version gratuite</div>
  `;
}

function initChat() {
  addMessage(
    "assistant",
    "Salut ! Dis-moi si tu veux un devis ou une facture, et decris la prestation."
  );
}

async function sendChat(text) {
  addMessage("user", text);
  const payload = {
    message: text,
    sessionId,
    formSnapshot: collectFormSnapshot()
  };

  try {
    const response = await fetch("/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Erreur inconnue");
    }
    if (data.reply) {
      addMessage("assistant", data.reply);
      speakText(data.reply);
    }
    if (data.ready && data.payload) {
      fillFormFromPayload(data.payload);
      form.dispatchEvent(new Event("submit"));
    }
  } catch (error) {
    addMessage("assistant", `Erreur: ${error.message}`);
  }
}

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = `chat-message ${role}`;
  div.textContent = text;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function collectFormSnapshot() {
  const formData = new FormData(form);
  return Object.fromEntries(formData.entries());
}

function fillFormFromPayload(payload) {
  setFormValue("documentType", payload.documentType);
  setFormValue("description", payload.description);
  setFormValue("businessName", payload.businessName);
  setFormValue("clientName", payload.clientName);
  setFormValue("city", payload.city);
  setFormValue("invoiceNumber", payload.invoiceNumber);
  setFormValue("issueDate", payload.issueDate);
  setFormValue("dueDate", payload.dueDate);
  if (payload.withVat !== undefined) {
    form.querySelector("[name='withVat']").checked = Boolean(payload.withVat);
  }
  if (payload.marginPercent !== undefined) {
    setFormValue("marginPercent", payload.marginPercent);
  }
}

function setFormValue(name, value) {
  if (value === undefined || value === null || value === "") return;
  const field = form.querySelector(`[name='${name}']`);
  if (field) field.value = value;
}

function getSessionId() {
  const key = "devisai_session";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const created = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  localStorage.setItem(key, created);
  return created;
}

function speakText(text) {
  if (!("speechSynthesis" in window)) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "fr-FR";
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function toggleSpeech() {
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    addMessage("assistant", "Micro non supporte sur ce navigateur.");
    return;
  }

  if (!recognition) {
    recognition = new SpeechRecognition();
    recognition.lang = "fr-FR";
    recognition.interimResults = false;
    recognition.maxAlternatives = 1;
    recognition.onresult = async (event) => {
      const transcript = event.results[0][0].transcript;
      await sendChat(transcript);
    };
    recognition.onend = () => {
      micBtn.classList.remove("active");
    };
    recognition.onerror = () => {
      micBtn.classList.remove("active");
    };
  }

  if (micBtn.classList.contains("active")) {
    recognition.stop();
    micBtn.classList.remove("active");
  } else {
    micBtn.classList.add("active");
    recognition.start();
  }
}

function toggleAtlasSpeech() {
  if (atlasLanguage.value === "atlasia") {
    toggleAtlasRecording();
    return;
  }

  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    setAtlasStatus("Micro non supporte sur ce navigateur.", "empty");
    return;
  }

  if (atlasMicBtn.classList.contains("active")) {
    atlasRecognition?.stop();
    atlasMicBtn.classList.remove("active");
    return;
  }

  atlasRecognition = new SpeechRecognition();
  atlasRecognition.lang = atlasLanguage.value || "ar-MA";
  atlasRecognition.interimResults = false;
  atlasRecognition.maxAlternatives = 1;
  atlasRecognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript;
    atlasTranscript.value = [atlasTranscript.value.trim(), transcript]
      .filter(Boolean)
      .join(" ");
    setAtlasStatus(`Transcript detecte: ${transcript}`, "empty");
  };
  atlasRecognition.onend = () => {
    atlasMicBtn.classList.remove("active");
  };
  atlasRecognition.onerror = () => {
    atlasMicBtn.classList.remove("active");
    setAtlasStatus("Erreur micro pendant la transcription.", "empty");
  };

  atlasMicBtn.classList.add("active");
  setAtlasStatus("Ecoute en cours...", "loading");
  atlasRecognition.start();
}

async function toggleAtlasRecording() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setAtlasStatus("Enregistrement audio non supporte sur ce navigateur.", "empty");
    return;
  }

  if (atlasRecorder?.state === "recording") {
    atlasRecorder.stop();
    atlasMicBtn.textContent = "Parler";
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = getAtlasMimeType();
    atlasAudioChunks = [];
    atlasRecorder = new MediaRecorder(
      stream,
      mimeType ? { mimeType } : undefined
    );

    atlasRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        atlasAudioChunks.push(event.data);
      }
    };
    atlasRecorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      atlasMicBtn.classList.remove("active");
      atlasMicBtn.textContent = "Parler";
      const audioBlob = new Blob(atlasAudioChunks, {
        type: atlasRecorder.mimeType || "audio/webm"
      });
      await transcribeWithAtlasia(audioBlob);
    };

    atlasMicBtn.classList.add("active");
    atlasMicBtn.textContent = "Stop";
    setAtlasStatus("Enregistrement Atlasia en cours... clique Stop quand tu as fini.", "loading");
    atlasRecorder.start();
  } catch (error) {
    atlasMicBtn.classList.remove("active");
    atlasMicBtn.textContent = "Parler";
    setAtlasStatus(`Micro indisponible: ${error.message}`, "empty");
  }
}

async function transcribeWithAtlasia(audioBlob) {
  if (!audioBlob.size) {
    setAtlasStatus("Aucun audio enregistre.", "empty");
    return;
  }

  setAtlasStatus("Transcription Atlasia/MoulSot en cours...", "loading");
  try {
    const response = await fetch("/api/atlasia/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": audioBlob.type || "application/octet-stream",
        "X-Document-Type": atlasDocumentType.value || "devis"
      },
      body: audioBlob
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.install || data.error || "Erreur Atlasia");
    }

    const transcript = String(data.text || "").trim();
    atlasTranscript.value = [atlasTranscript.value.trim(), transcript]
      .filter(Boolean)
      .join(" ");
    setAtlasStatus(
      `Atlasia (${data.model || "atlasia/moulsot.v0.3"}) a transcrit: ${transcript || "-"}`,
      "empty"
    );
  } catch (error) {
    setAtlasStatus(`Atlasia indisponible: ${error.message}`, "empty");
  }
}

function getAtlasMimeType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

async function runAtlasTest({ generate }) {
  const text = atlasTranscript.value.trim();
  if (!text) {
    setAtlasStatus("Ajoute un message ou parle avant de tester.", "empty");
    return;
  }

  atlasTestBtn.disabled = true;
  atlasGenerateBtn.disabled = true;
  setAtlasStatus("Test de comprehension en cours...", "loading");

  try {
    const documentType = atlasDocumentType.value || "devis";
    const normalizedText = text.toLowerCase();
    const hasDocumentType =
      normalizedText.includes("devis") ||
      normalizedText.includes("facture") ||
      normalizedText.includes("factura");
    const response = await fetch("/api/intake", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: hasDocumentType ? text : `${documentType} ${text}`,
        sessionId: `${sessionId}-atlas`,
        formSnapshot: {
          ...collectFormSnapshot(),
          documentType
        }
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Erreur inconnue");
    }

    renderAtlasResult(data);
    if (data.payload) {
      fillFormFromPayload(data.payload);
    }
    if (generate && data.ready && data.payload) {
      form.dispatchEvent(new Event("submit"));
    } else if (generate && !data.ready) {
      setAtlasStatus(
        `${atlasStatus.innerHTML}<p class="muted">Atlas demande encore une precision avant generation.</p>`,
        "empty",
        true
      );
    }
  } catch (error) {
    setAtlasStatus(`Erreur: ${error.message}`, "empty");
  } finally {
    atlasTestBtn.disabled = false;
    atlasGenerateBtn.disabled = false;
  }
}

function renderAtlasResult(data) {
  const payload = data.payload || {};
  const payloadRows = Object.entries(payload)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(
      ([key, value]) =>
        `<div class="payload-row"><span>${escapeHtml(key)}</span><strong>${escapeHtml(value)}</strong></div>`
    )
    .join("");

  setAtlasStatus(
    `<div class="analysis-block">
      <h3>Reponse assistant</h3>
      <p>${escapeHtml(data.reply || "-")}</p>
    </div>
    <div class="analysis-block">
      <h3>Etat</h3>
      <p>${data.ready ? "Pret a generer." : "Infos incompletes."}</p>
    </div>
    <div class="analysis-block">
      <h3>Payload compris</h3>
      ${payloadRows || "<p class=\"muted\">Aucun payload pret.</p>"}
    </div>`,
    "empty",
    true
  );
}

function setAtlasStatus(content, state, html = false) {
  atlasStatus.classList.remove("loading", "empty");
  if (state) atlasStatus.classList.add(state);
  if (html) {
    atlasStatus.innerHTML = content;
  } else {
    atlasStatus.textContent = content;
  }
}

function renderAnalysis(data) {
  analysisOutput.classList.remove("loading");
  analysisOutput.innerHTML = `
    <div class="analysis-block">
      <h3>Resume client</h3>
      <p>${escapeHtml(data.summary || "-")}</p>
    </div>
    <div class="analysis-block">
      <h3>Questions a poser</h3>
      ${renderList(data.questions)}
    </div>
    <div class="analysis-block">
      <h3>Materiaux & main d'oeuvre</h3>
      ${renderList(data.materials)}
    </div>
    <div class="analysis-block">
      <h3>Risques / contraintes</h3>
      ${renderList(data.risks)}
    </div>
    <div class="analysis-block">
      <h3>Conseil marge</h3>
      <p>${escapeHtml(data.marginAdvice || "-")}</p>
    </div>
  `;
}

function renderList(list) {
  if (!Array.isArray(list) || list.length === 0) {
    return "<p class=\"muted\">-</p>";
  }
  return `<ul>${list.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function formatMoney(value) {
  return new Intl.NumberFormat("fr-MA", {
    style: "currency",
    currency: window.currentCurrency || "MAD",
    maximumFractionDigits: 2
  }).format(value || 0);
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-MA");
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

initChat();

