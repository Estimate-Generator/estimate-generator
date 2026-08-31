const micButton = document.getElementById("single-mic-btn");
const statusText = document.getElementById("voice-status");
const downloadLink = document.getElementById("document-download");
const preview = document.getElementById("document-preview");

let recorder = null;
let chunks = [];
let recordingTimer = null;
let speechRecognition = null;
let speechActive = false;
let speechTimer = null;
let audioContext = null;
let audioStream = null;
let audioSource = null;
let audioProcessor = null;
let pcmChunks = [];
let pcmRecording = false;

micButton.addEventListener("click", async () => {
  if (speechActive) {
    speechRecognition?.stop();
    return;
  }
  if (recorder?.state === "recording") {
    recorder.stop();
    return;
  }
  if (pcmRecording) {
    await stopPcmRecording();
    return;
  }
  if (navigator.mediaDevices?.getUserMedia && (window.AudioContext || window.webkitAudioContext)) {
    await startPcmRecording();
    return;
  }
  if (navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
    await startRecording();
    return;
  }
  if (window.SpeechRecognition || window.webkitSpeechRecognition) {
    startSpeechRecognition();
    return;
  }
  setStatus("Micro non supporte sur ce navigateur.");
});

async function startPcmRecording() {
  resetDocument();
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioContext = new AudioContextClass();
    audioSource = audioContext.createMediaStreamSource(audioStream);
    audioProcessor = audioContext.createScriptProcessor(4096, 1, 1);
    pcmChunks = [];

    audioProcessor.onaudioprocess = (event) => {
      const input = event.inputBuffer.getChannelData(0);
      pcmChunks.push(new Float32Array(input));
    };

    audioSource.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
    pcmRecording = true;
    micButton.classList.add("recording");
    setStatus("Parle en darija. Arret auto dans 7 secondes.");
    recordingTimer = setTimeout(() => {
      if (pcmRecording) stopPcmRecording();
    }, 7000);
  } catch (error) {
    cleanupPcmRecording();
    setStatus(`Micro indisponible: ${error.message}`);
  }
}

async function stopPcmRecording() {
  if (!pcmRecording) return;
  const sampleRate = audioContext?.sampleRate || 44100;
  cleanupPcmRecording();
  micButton.disabled = true;
  setStatus("Transcription en cours...");
  try {
    const audio = encodeWav(pcmChunks, sampleRate);
    const transcript = await transcribe(audio);
    setStatus("Generation du document...");
    const document = await generateDocument(transcript);
    showFile(document);
    setStatus("Document pret.");
  } catch (error) {
    setStatus(error.message);
  } finally {
    micButton.disabled = false;
  }
}

function cleanupPcmRecording() {
  pcmRecording = false;
  micButton.classList.remove("recording");
  if (recordingTimer) clearTimeout(recordingTimer);
  recordingTimer = null;
  audioProcessor?.disconnect();
  audioSource?.disconnect();
  audioStream?.getTracks().forEach((track) => track.stop());
  audioContext?.close();
  audioProcessor = null;
  audioSource = null;
  audioStream = null;
  audioContext = null;
}

function startSpeechRecognition() {
  resetDocument();
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = "ar-MA";
  speechRecognition.interimResults = false;
  speechRecognition.continuous = false;
  speechRecognition.maxAlternatives = 1;

  let handled = false;
  speechRecognition.onresult = async (event) => {
    handled = true;
    const transcript = event.results[0][0].transcript;
    micButton.disabled = true;
    setStatus("Generation du document...");
    try {
      const document = await generateDocument(transcript);
      showFile(document);
      setStatus("Document pret.");
    } catch (error) {
      setStatus(error.message);
    } finally {
      micButton.disabled = false;
      cleanupSpeechRecognition();
    }
  };
  speechRecognition.onerror = (event) => {
    setStatus(`Micro: ${event.error || "erreur reconnaissance"}`);
    cleanupSpeechRecognition();
  };
  speechRecognition.onend = () => {
    if (!handled && speechActive) {
      setStatus("Aucun texte detecte. Reessaie.");
    }
    cleanupSpeechRecognition();
  };

  speechActive = true;
  micButton.classList.add("recording");
  setStatus("Parle en darija...");
  speechTimer = setTimeout(() => {
    if (speechActive) {
      setStatus("Temps ecoule. Reessaie avec une phrase plus courte.");
      speechRecognition.stop();
    }
  }, 20000);
  speechRecognition.start();
}

function cleanupSpeechRecognition() {
  speechActive = false;
  micButton.classList.remove("recording");
  if (speechTimer) clearTimeout(speechTimer);
  speechTimer = null;
}

async function startRecording() {
  resetDocument();
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus("Micro non supporte sur ce navigateur.");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mimeType = getMimeType();
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);

    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = async () => {
      if (recordingTimer) clearTimeout(recordingTimer);
      recordingTimer = null;
      stream.getTracks().forEach((track) => track.stop());
      micButton.classList.remove("recording");
      micButton.disabled = true;
      setStatus("Transcription en cours...");
      try {
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        const transcript = await transcribe(audio);
        setStatus("Generation du document...");
        const document = await generateDocument(transcript);
        showFile(document);
        setStatus("Document pret.");
      } catch (error) {
        setStatus(error.message);
      } finally {
        micButton.disabled = false;
      }
    };

    micButton.classList.add("recording");
    setStatus("Parle en darija. Arret auto dans 7 secondes.");
    recorder.start();
    recordingTimer = setTimeout(() => {
      if (recorder?.state === "recording") recorder.stop();
    }, 7000);
  } catch (error) {
    setStatus(`Micro indisponible: ${error.message}`);
  }
}

async function transcribe(audio) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch("/api/atlasia/transcribe", {
      method: "POST",
      headers: {
        "Content-Type": audio.type || "application/octet-stream",
        "X-Document-Type": "devis"
      },
      body: audio,
      signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.details || data.error || "Transcription indisponible.");
    }
    const text = String(data.text || "").trim();
    if (!text) {
      throw new Error("Aucun texte detecte. Reessaie avec un audio plus clair.");
    }
    return text;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Transcription trop longue. Reessaie.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function generateDocument(transcript) {
  const documentType = guessDocumentType(transcript);
  const intakeResponse = await fetch("/api/intake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      message: transcript,
      sessionId: `simple-${Date.now()}`,
      formSnapshot: { documentType }
    })
  });
  const intake = await intakeResponse.json();
  if (!intakeResponse.ok) {
    throw new Error(intake.error || "Erreur comprehension.");
  }

  const payload = {
    documentType,
    description: transcript,
    marginPercent: 15,
    withVat: false,
    ...(intake.payload || {})
  };
  const endpoint = payload.documentType === "facture" ? "/api/invoice" : "/api/quote";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const document = await response.json();
  if (!response.ok) {
    throw new Error(document.error || "Erreur generation.");
  }
  return document;
}

function showFile(document) {
  const filename = `${document.documentType || "document"}-${Date.now()}.html`;
  const html = renderDocumentHtml(document);
  const blob = new Blob([html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  downloadLink.href = url;
  downloadLink.download = filename;
  downloadLink.textContent = filename;
  downloadLink.classList.remove("hidden");
  preview.textContent = renderDocumentText(document);
  preview.classList.remove("hidden");
}

function renderDocumentHtml(document) {
  const rows = (document.items || [])
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.label)}</td>
        <td>${escapeHtml(item.qty)}</td>
        <td>${escapeHtml(item.unit)}</td>
        <td>${escapeHtml(item.unitPrice)}</td>
      </tr>`
    )
    .join("");
  return `<!doctype html>
<html lang="fr">
<meta charset="utf-8" />
<title>${escapeHtml(document.title || "Document")}</title>
<body>
  <h1>${escapeHtml(document.title || "Document")}</h1>
  <p>Entreprise: ${escapeHtml(document.businessName || "-")}</p>
  <p>Client: ${escapeHtml(document.clientName || "-")}</p>
  <p>Ville: ${escapeHtml(document.city || "-")}</p>
  <table border="1" cellspacing="0" cellpadding="6">
    <thead><tr><th>Prestation</th><th>Qte</th><th>Unite</th><th>Prix</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <h2>Total: ${escapeHtml(document.totals?.total || 0)} ${escapeHtml(document.currency || "MAD")}</h2>
  <p>${escapeHtml(document.notes || "")}</p>
</body>
</html>`;
}

function renderDocumentText(document) {
  const total = document.totals?.total || 0;
  return `${document.title || "Document"}\nTotal: ${total} ${document.currency || "MAD"}`;
}

function encodeWav(buffers, sampleRate) {
  const samples = mergeAudioBuffers(buffers);
  const bytesPerSample = 2;
  const dataSize = samples.length * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(view, 8, "WAVE");
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeString(view, 36, "data");
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }

  return new Blob([view], { type: "audio/wav" });
}

function mergeAudioBuffers(buffers) {
  const length = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
  const result = new Float32Array(length);
  let offset = 0;
  for (const buffer of buffers) {
    result.set(buffer, offset);
    offset += buffer.length;
  }
  return result;
}

function writeString(view, offset, value) {
  for (let i = 0; i < value.length; i += 1) {
    view.setUint8(offset + i, value.charCodeAt(i));
  }
}

function guessDocumentType(text) {
  const lower = text.toLowerCase();
  if (["facture", "factura", "fatora", "fatoura"].some((term) => lower.includes(term))) {
    return "facture";
  }
  return "devis";
}

function resetDocument() {
  downloadLink.classList.add("hidden");
  preview.classList.add("hidden");
  preview.textContent = "";
}

function setStatus(message) {
  statusText.textContent = message;
}

function getMimeType() {
  return ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
