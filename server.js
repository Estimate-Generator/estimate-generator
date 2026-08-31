import express from "express";
import { execFile } from "child_process";
import { randomUUID } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { promisify } from "util";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();

app.use(express.json({ limit: "1mb" }));
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "simple.html"));
});
app.use(express.static(path.join(__dirname, "public")));

app.post(
  "/api/atlasia/transcribe",
  express.raw({
    type: ["audio/webm", "audio/wav", "audio/mpeg", "application/octet-stream"],
    limit: "25mb"
  }),
  async (req, res) => {
    const audio = Buffer.isBuffer(req.body) ? req.body : null;
    if (!audio?.length) {
      return res.status(400).json({ error: "Audio manquant." });
    }

    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "atlasia-"));
    const extension = audioExtension(req.headers["content-type"]);
    const audioPath = path.join(tempDir, `${randomUUID()}${extension}`);
    const scriptPath = path.join(__dirname, "scripts", "atlasia_stt.py");
    const pythonBin = process.env.ATLASIA_PYTHON || "python3";

    try {
      if (process.env.DARIJA_DOCS_API_URL) {
        const remoteResult = await transcribeWithDarijaDocsApi({
          audio,
          contentType: req.headers["content-type"] || "application/octet-stream",
          extension,
          documentType: req.headers["x-document-type"] || "devis"
        });
        return res.json(remoteResult);
      }

      await fs.writeFile(audioPath, audio);
      const { stdout } = await execFileAsync(pythonBin, [scriptPath, audioPath], {
        timeout: 120000,
        maxBuffer: 1024 * 1024
      });
      const result = JSON.parse(stdout);
      return res.json({
        text: String(result.text || "").trim(),
        model: result.model || "atlasia/moulsot.v0.3"
      });
    } catch (error) {
      return res.status(503).json({
        error: "Transcription Atlasia indisponible.",
        details: cleanProcessError(error),
        install:
          "Installe les dependances avec: python3 -m pip install -r requirements-atlasia.txt"
      });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
);

app.post("/api/quote", async (req, res) => {
  const payload = req.body || {};
  const description = String(payload.description || "").trim();
  const businessName = String(payload.businessName || "").trim();
  const clientName = String(payload.clientName || "").trim();
  const city = String(payload.city || "").trim();
  const withVat = Boolean(payload.withVat);
  const marginPercent = Number(payload.marginPercent || 0);
  const issueDate = String(payload.issueDate || "").trim();
  const moneyHint = detectMoneyHint(description);

  if (!description) {
    return res.status(400).json({ error: "Description manquante." });
  }

  try {
    const result = await generateQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      issueDate,
      documentType: "devis",
      moneyHint
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: "Erreur serveur lors de la generation du devis.",
      details: error?.message || "unknown"
    });
  }
});

app.post("/api/invoice", async (req, res) => {
  const payload = req.body || {};
  const description = String(payload.description || "").trim();
  const businessName = String(payload.businessName || "").trim();
  const clientName = String(payload.clientName || "").trim();
  const city = String(payload.city || "").trim();
  const withVat = Boolean(payload.withVat);
  const marginPercent = Number(payload.marginPercent || 0);
  const invoiceNumber = String(payload.invoiceNumber || "").trim();
  const issueDate = String(payload.issueDate || "").trim();
  const dueDate = String(payload.dueDate || "").trim();
  const moneyHint = detectMoneyHint(description);

  if (!description) {
    return res.status(400).json({ error: "Description manquante." });
  }

  try {
    const result = await generateInvoice({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      invoiceNumber,
      issueDate,
      dueDate,
      documentType: "facture",
      moneyHint
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: "Erreur serveur lors de la generation de la facture.",
      details: error?.message || "unknown"
    });
  }
});

app.post("/api/intake", async (req, res) => {
  const payload = req.body || {};
  const message = String(payload.message || "").trim();
  const sessionId = String(payload.sessionId || "").trim() || "default";
  const formSnapshot = payload.formSnapshot || {};

  if (!message) {
    return res.status(400).json({ error: "Message manquant." });
  }

  try {
    const session = getSession(sessionId);
    session.messages.push({ role: "user", content: message });
    trimMessages(session);

    let result = null;
    if (hasConfiguredTextModel()) {
      result = await llmIntake({
        message,
        session,
        formSnapshot
      });
    }

    const fallback = fallbackIntake({
      message,
      session,
      formSnapshot
    });

    const merged = mergeIntakeResults(fallback, result);
    session.fields = { ...session.fields, ...merged.fields };
    if (merged.allowEstimate) session.allowEstimate = true;

    const readiness = computeReadiness(session);
    const reply = merged.reply || readiness.reply;
    const response = {
      reply,
      ready: readiness.ready
    };

    if (readiness.ready) {
      response.payload = buildPayloadFromSession(session);
    }

    session.messages.push({ role: "assistant", content: reply });
    trimMessages(session);
    return res.json(response);
  } catch (error) {
    return res.status(500).json({
      error: "Erreur serveur lors de l'intake.",
      details: error?.message || "unknown"
    });
  }
});

app.post("/api/analyze", async (req, res) => {
  const payload = req.body || {};
  const description = String(payload.description || "").trim();
  const businessName = String(payload.businessName || "").trim();
  const clientName = String(payload.clientName || "").trim();
  const city = String(payload.city || "").trim();
  const withVat = Boolean(payload.withVat);
  const marginPercent = Number(payload.marginPercent || 0);
  const documentType = String(payload.documentType || "devis").trim();

  if (!description) {
    return res.status(400).json({ error: "Description manquante." });
  }

  try {
    const result = await analyzeQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      documentType
    });
    return res.json(result);
  } catch (error) {
    return res.status(500).json({
      error: "Erreur serveur lors de l'analyse.",
      details: error?.message || "unknown"
    });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`DevisAI running on http://localhost:${PORT}`);
});

function audioExtension(contentType = "") {
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  return ".webm";
}

function cleanProcessError(error) {
  const message = error?.stderr || error?.stdout || error?.message || "unknown";
  return String(message).trim().slice(0, 1200);
}

async function transcribeWithDarijaDocsApi({
  audio,
  contentType,
  extension,
  documentType
}) {
  const baseUrl = process.env.DARIJA_DOCS_API_URL.replace(/\/$/, "");
  const form = new FormData();
  form.append(
    "audio",
    new Blob([audio], { type: contentType }),
    `audio-${Date.now()}${extension}`
  );
  form.append("document_type", documentType);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let response;
  let raw;
  try {
    response = await fetch(`${baseUrl}/audio/document`, {
      method: "POST",
      body: form,
      signal: controller.signal
    });
    raw = await response.text();
    if (!response.ok) {
      throw new Error(raw || `Remote Darija API failed with ${response.status}`);
    }
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Remote Darija API timed out after 30 seconds");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }

  const data = safeJsonParse(raw) || {};
  const text =
    data.text ||
    data.transcript ||
    data.transcription ||
    data.document?.description ||
    data.payload?.description ||
    "";

  return {
    text: String(text || "").trim(),
    model: data.model || "darija-docs-api",
    remote: data
  };
}

function hasConfiguredTextModel() {
  return Boolean(process.env.QWEN_API_URL || process.env.OPENAI_API_KEY);
}

async function generateText({ prompt, temperature = 0.2, maxTokens = 700 }) {
  if (process.env.QWEN_API_URL) {
    const response = await fetch(process.env.QWEN_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt,
        max_tokens: maxTokens,
        temperature
      })
    });
    if (!response.ok) return "";
    const data = await response.json();
    return String(data.generated_text || data.text || data.response || "").trim();
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4.1-mini",
      input: prompt,
      temperature
    })
  });
  if (!response.ok) return "";
  const data = await response.json();
  return (
    data?.output?.[0]?.content?.[0]?.text ||
    data?.choices?.[0]?.message?.content ||
    ""
  ).trim();
}

async function generateQuote({
  description,
  businessName,
  clientName,
  city,
  withVat,
  marginPercent,
  issueDate,
  documentType,
  moneyHint
}) {
  if (!hasConfiguredTextModel()) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      issueDate,
      documentType,
      moneyHint
    });
  }

  const prompt = `
Tu es un assistant pour artisans au Maroc. Genere un devis simple et pro.
Retourne UNIQUEMENT un JSON strict avec ce schema:
{
  "title": "string",
  "currency": "MAD",
  "items": [
    { "label": "string", "qty": number, "unit": "string", "unitPrice": number }
  ],
  "notes": "string"
}
Contexte:
- Description: "${description}"
- Entreprise: "${businessName || "Non renseignee"}"
- Client: "${clientName || "Non renseigne"}"
- Ville: "${city || "Non renseignee"}"
${moneyHint?.amount ? `- Budget indique: ${moneyHint.amount} ${moneyHint.currency || "MAD"}` : ""}
Contraintes:
- 2 a 6 lignes d'articles.
- Prix raisonnables pour le Maroc.
- Si un budget est indique, garde un total proche de ce budget avant marge/TVA.
- Unites simples: m2, ml, forfait, piece.
`;

  const text = await generateText({ prompt, temperature: 0.2, maxTokens: 700 });
  if (!text) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      issueDate,
      documentType,
      moneyHint
    });
  }

  const parsed = safeJsonParse(text);
  if (!parsed?.items?.length) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      issueDate,
      documentType,
      moneyHint
    });
  }

  return formatQuote(prepareModelQuote(parsed, { description, moneyHint, city, withVat }), {
    withVat,
    marginPercent,
    businessName,
    clientName,
    city,
    issueDate,
    documentType,
    moneyHint
  });
}

async function generateInvoice({
  description,
  businessName,
  clientName,
  city,
  withVat,
  marginPercent,
  invoiceNumber,
  issueDate,
  dueDate,
  documentType,
  moneyHint
}) {
  if (!hasConfiguredTextModel()) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      invoiceNumber,
      issueDate,
      dueDate,
      documentType,
      moneyHint
    });
  }

  const prompt = `
Tu es un assistant pour artisans au Maroc. Genere une facture simple et pro.
Retourne UNIQUEMENT un JSON strict avec ce schema:
{
  "title": "string",
  "currency": "MAD",
  "items": [
    { "label": "string", "qty": number, "unit": "string", "unitPrice": number }
  ],
  "notes": "string"
}
Contexte:
- Description: "${description}"
- Entreprise: "${businessName || "Non renseignee"}"
- Client: "${clientName || "Non renseigne"}"
- Ville: "${city || "Non renseignee"}"
${moneyHint?.amount ? `- Budget indique: ${moneyHint.amount} ${moneyHint.currency || "MAD"}` : ""}
Contraintes:
- 2 a 6 lignes d'articles.
- Prix raisonnables pour le Maroc.
- Si un budget est indique, garde un total proche de ce budget avant marge/TVA.
- Unites simples: m2, ml, forfait, piece.
`;

  const text = await generateText({ prompt, temperature: 0.2, maxTokens: 700 });
  if (!text) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      invoiceNumber,
      issueDate,
      dueDate,
      documentType,
      moneyHint
    });
  }

  const parsed = safeJsonParse(text);
  if (!parsed?.items?.length) {
    return buildFallbackQuote({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      invoiceNumber,
      issueDate,
      dueDate,
      documentType,
      moneyHint
    });
  }

  return formatQuote(prepareModelQuote(parsed, { description, moneyHint, city, withVat }), {
    withVat,
    marginPercent,
    businessName,
    clientName,
    city,
    invoiceNumber,
    issueDate,
    dueDate,
    documentType,
    moneyHint
  });
}

async function analyzeQuote({
  description,
  businessName,
  clientName,
  city,
  withVat,
  marginPercent,
  documentType
}) {
  if (!hasConfiguredTextModel()) {
    return buildFallbackAnalysis({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent
    });
  }

  const prompt = `
Tu aides un artisan marocain a optimiser son ${documentType === "facture" ? "facture" : "devis"}.
Retourne UNIQUEMENT un JSON strict avec ce schema:
{
  "summary": "string",
  "questions": ["string"],
  "materials": ["string"],
  "risks": ["string"],
  "marginAdvice": "string"
}
Contexte:
- Description: "${description}"
- Entreprise: "${businessName || "Non renseignee"}"
- Client: "${clientName || "Non renseigne"}"
- Ville: "${city || "Non renseignee"}"
- TVA: ${withVat ? "Oui" : "Non"}
- Marge actuelle: ${marginPercent}%
Contraintes:
- 3 a 6 questions.
- 3 a 6 elements materiaux/main d'oeuvre.
- 2 a 5 risques.
- Style simple et pro.
`;

  const text = await generateText({ prompt, temperature: 0.2, maxTokens: 500 });
  if (!text) {
    return buildFallbackAnalysis({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      documentType
    });
  }

  const parsed = safeJsonParse(text);
  if (!parsed?.summary) {
    return buildFallbackAnalysis({
      description,
      businessName,
      clientName,
      city,
      withVat,
      marginPercent,
      documentType
    });
  }

  return normalizeAnalysis(parsed);
}

function buildFallbackQuote({
  description,
  businessName,
  clientName,
  city,
  withVat,
  marginPercent,
  invoiceNumber,
  issueDate,
  dueDate,
  documentType,
  moneyHint
}) {
  const basePrice = estimateBasePrice(description);
  const items = buildItemsFromHint({
    description,
    basePrice,
    moneyHint
  });
  return formatQuote(
    {
      title: documentType === "facture" ? "Facture - Prestation" : "Devis - Prestation",
      currency: moneyHint?.currency || "MAD",
      items,
      notes:
        documentType === "facture"
          ? "Facture generee automatiquement. Merci de verifier les details."
          : "Ce devis est une estimation. Les prix peuvent varier selon la visite technique."
    },
    {
      withVat,
      marginPercent,
      businessName,
      clientName,
      city,
      invoiceNumber,
      issueDate,
      dueDate,
      documentType,
      moneyHint
    }
  );
}

function buildFallbackAnalysis({ description, marginPercent }) {
  return {
    summary: `Prestation demandee: ${description.slice(0, 140)}.`,
    questions: [
      "Quelle est la surface/quantite exacte a traiter ?",
      "Etat du chantier actuel (neuf, renovation) ?",
      "Acces au site et contraintes horaires ?",
      "Fourniture des materiaux par l'artisan ou le client ?"
    ],
    materials: [
      "Materiaux principaux (ex: ciment, carrelage, cables)",
      "Main d'oeuvre (ouvriers, chef d'equipe)",
      "Transport et deplacement",
      "Preparation et nettoyage du chantier"
    ],
    risks: [
      "Travaux supplementaires apres visite technique",
      "Variations de prix des materiaux"
    ],
    marginAdvice: `Marge actuelle ${marginPercent}%. Ajuster selon complexite et delai.`
  };
}

function prepareModelQuote(base, { description, moneyHint, city, withVat }) {
  const quote = {
    ...base,
    items: Array.isArray(base.items) ? base.items.map((item) => ({ ...item })) : []
  };
  if (!withVat && String(quote.notes || "").toLowerCase().includes("tva")) {
    quote.notes = "Document genere sans TVA. Merci de verifier les details.";
  }
  quote.items = quote.items.map((item) => {
    const label = String(item.label || "").trim();
    const looksLikeCity =
      city && label.toLowerCase() === String(city).toLowerCase();
    return {
      ...item,
      label: !label || looksLikeCity ? description.slice(0, 80) : label
    };
  });

  if (!moneyHint?.amount || quote.items.length === 0) {
    return quote;
  }

  const subtotal = quote.items.reduce((sum, item) => {
    return sum + Number(item.qty || 1) * Number(item.unitPrice || 0);
  }, 0);

  if (subtotal <= 0) {
    quote.items[0].qty = Number(quote.items[0].qty || 1);
    quote.items[0].unitPrice = round2(moneyHint.amount / quote.items[0].qty);
    return quote;
  }

  const ratio = moneyHint.amount / subtotal;
  quote.items = quote.items.map((item) => ({
    ...item,
    unitPrice: round2(Number(item.unitPrice || 0) * ratio)
  }));
  return quote;
}

function estimateBasePrice(description) {
  const text = description.toLowerCase();
  if (text.includes("peinture") || text.includes("peint")) return 1500;
  if (text.includes("clim")) return 2800;
  if (text.includes("plomb")) return 900;
  if (text.includes("carrelage")) return 2200;
  if (text.includes("electric")) return 1200;
  return 1600;
}

function formatQuote(base, meta) {
  const items = base.items.map((item) => ({
    ...item,
    qty: Number(item.qty || 1),
    unitPrice: Number(item.unitPrice || 0)
  }));
  const normalizedCurrency = meta?.moneyHint?.currency || base.currency || "MAD";
  const subtotal = items.reduce(
    (sum, item) => sum + item.qty * item.unitPrice,
    0
  );
  const marginRate = Number(meta.marginPercent || 0) / 100;
  const marginAmount = subtotal * marginRate;
  const subtotalWithMargin = subtotal + marginAmount;
  const vatRate = meta.withVat ? 0.2 : 0;
  const vatAmount = subtotalWithMargin * vatRate;
  const total = subtotalWithMargin + vatAmount;

  return {
    title:
      base.title ||
      (meta.documentType === "facture"
        ? "Facture - Prestation"
        : "Devis - Prestation"),
    currency: normalizedCurrency,
    businessName: meta.businessName || "",
    clientName: meta.clientName || "",
    city: meta.city || "",
    documentType: meta.documentType || "devis",
    invoiceNumber: meta.invoiceNumber || "",
    issueDate: meta.issueDate || "",
    dueDate: meta.dueDate || "",
    notes: base.notes || "",
    advancePercent: meta?.moneyHint?.advancePercent || 0,
    items,
    totals: {
      subtotal: round2(subtotal),
      marginPercent: Number(meta.marginPercent || 0),
      marginAmount: round2(marginAmount),
      vatRate: vatRate ? 20 : 0,
      vatAmount: round2(vatAmount),
      total: round2(total)
    }
  };
}

function safeJsonParse(text) {
  const raw = String(text || "").trim();
  const cleaned = raw
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {}

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

function normalizeAnalysis(data) {
  return {
    summary: String(data.summary || "").trim(),
    questions: normalizeList(data.questions),
    materials: normalizeList(data.materials),
    risks: normalizeList(data.risks),
    marginAdvice: String(data.marginAdvice || "").trim()
  };
}

function normalizeList(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => String(item || "").trim())
    .filter((item) => item.length > 0)
    .slice(0, 8);
}

function detectMoneyHint(description) {
  const text = description.toLowerCase();
  const currency = text.includes("euro") || text.includes("eur") ? "EUR" : "MAD";
  const amountMatch = text.match(/(\d+(?:[.,]\d+)?)(\s?)(eur|euro|mad|dh)/i);
  const percentMatch = text.match(/(\d{1,2})\s?%|(\d{1,2})\s?pour\s?cent/i);
  const rawAmount = amountMatch ? Number(amountMatch[1].replace(",", ".")) : null;
  const advancePercent = percentMatch ? Number(percentMatch[1] || percentMatch[2]) : 0;

  if (!rawAmount && !advancePercent) return null;
  return {
    currency,
    amount: rawAmount,
    advancePercent
  };
}

function buildItemsFromHint({ description, basePrice, moneyHint }) {
  const label = description.slice(0, 80);
  if (!moneyHint?.amount) {
    return [
      {
        label,
        qty: 1,
        unit: "forfait",
        unitPrice: basePrice
      }
    ];
  }
  return [
    {
      label,
      qty: 1,
      unit: "forfait",
      unitPrice: moneyHint.amount
    }
  ];
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      messages: [],
      fields: {},
      allowEstimate: false
    });
  }
  return sessions.get(sessionId);
}

function trimMessages(session) {
  if (session.messages.length > 12) {
    session.messages = session.messages.slice(-12);
  }
}

function mergeIntakeResults(fallback, llmResult) {
  if (!llmResult) return fallback;
  return {
    reply: llmResult.reply || fallback.reply,
    allowEstimate: llmResult.allowEstimate || fallback.allowEstimate,
    fields: {
      ...fallback.fields,
      ...llmResult.fields
    }
  };
}

async function llmIntake({ message, session, formSnapshot }) {
  const prompt = `
Tu es un assistant vocal pour artisans. Tu dois collecter les infos pour generer un devis ou une facture.
Tu comprends le francais, l'arabe marocain darija et la darija ecrite en alphabet latin.
Retourne UNIQUEMENT un JSON strict avec ce schema:
{
  "reply": "string",
  "allowEstimate": boolean,
  "fields": {
    "documentType": "devis|facture|",
    "description": "string",
    "businessName": "string",
    "clientName": "string",
    "city": "string",
    "amount": number,
    "currency": "MAD|EUR|",
    "advancePercent": number,
    "invoiceNumber": "string",
    "issueDate": "YYYY-MM-DD",
    "dueDate": "YYYY-MM-DD",
    "withVat": boolean,
    "marginPercent": number
  }
}
Contexte:
- Message utilisateur: "${message}"
- Champs deja connus: ${JSON.stringify(session.fields)}
- Formulaire actuel: ${JSON.stringify(formSnapshot)}
Règles:
- Si info manque, pose UNE question claire.
- Si l'utilisateur dit "estime" ou "pas de budget", allowEstimate=true.
- En darija, "bghit devis", "bghit factura", "chhal", "dh", "bla tva" doivent etre compris.
- Ne jamais inventer de montants si non fournis.
`;

  const text = await generateText({ prompt, temperature: 0.2, maxTokens: 500 });
  if (!text) return null;
  const parsed = safeJsonParse(text);
  if (!parsed || !parsed.fields) return null;
  return {
    reply: String(parsed.reply || "").trim(),
    allowEstimate: Boolean(parsed.allowEstimate),
    fields: normalizeIntakeFields(parsed.fields)
  };
}

function normalizeIntakeFields(fields) {
  const normalized = {};
  if (!fields || typeof fields !== "object") return normalized;
  if (fields.documentType) normalized.documentType = String(fields.documentType);
  if (fields.description) normalized.description = String(fields.description);
  if (fields.businessName) normalized.businessName = String(fields.businessName);
  if (fields.clientName) normalized.clientName = String(fields.clientName);
  if (fields.city) normalized.city = String(fields.city);
  if (fields.invoiceNumber) normalized.invoiceNumber = String(fields.invoiceNumber);
  if (fields.issueDate) normalized.issueDate = String(fields.issueDate);
  if (fields.dueDate) normalized.dueDate = String(fields.dueDate);
  if (fields.currency) normalized.currency = String(fields.currency);
  if (fields.amount !== undefined && fields.amount !== null) {
    normalized.amount = Number(fields.amount);
  }
  if (fields.advancePercent !== undefined && fields.advancePercent !== null) {
    normalized.advancePercent = Number(fields.advancePercent);
  }
  if (fields.marginPercent !== undefined && fields.marginPercent !== null) {
    normalized.marginPercent = Number(fields.marginPercent);
  }
  if (fields.withVat !== undefined) {
    normalized.withVat = Boolean(fields.withVat);
  }
  return normalized;
}

function fallbackIntake({ message, session, formSnapshot }) {
  const fields = { ...session.fields };
  const lower = message.toLowerCase();
  if (matchesAny(lower, ["facture", "factura", "fatora", "fatoura"])) {
    fields.documentType = "facture";
  }
  if (matchesAny(lower, ["devis", "devi", "divi", "ta9dir", "takdir"])) {
    fields.documentType = "devis";
  }
  if (!fields.description) fields.description = message;
  const withoutVat =
    lower.includes("tva") &&
    matchesAny(lower, ["sans", "bla", "bila", "no"]);
  if (withoutVat) {
    fields.withVat = false;
  } else if (lower.includes("tva")) {
    fields.withVat = true;
  }
  if (
    matchesAny(lower, [
      "estime",
      "estimi",
      "pas de budget",
      "ma 3raftch",
      "ma 3rftch",
      "ma kaynch budget",
      "makaynch budget"
    ])
  ) {
    session.allowEstimate = true;
  }

  const money = detectMoneyHint(message);
  if (money?.amount) fields.amount = money.amount;
  if (money?.currency) fields.currency = money.currency;
  if (money?.advancePercent) fields.advancePercent = money.advancePercent;
  if (!fields.city) {
    fields.city = detectMoroccanCity(message);
  }

  if (!fields.documentType && formSnapshot.documentType) {
    fields.documentType = formSnapshot.documentType;
  }

  let reply = "Tu veux un devis ou une facture ?";
  if (fields.documentType && !fields.description) {
    reply = "Decris la prestation en quelques mots.";
  } else if (fields.documentType && fields.description && !fields.amount && !session.allowEstimate) {
    reply = "Quel est le montant ou le budget total ?";
  } else if (fields.documentType && fields.description && fields.amount && !fields.advancePercent) {
    reply = "Souhaites-tu un acompte ? (ex: 30%)";
  }

  return {
    reply,
    allowEstimate: session.allowEstimate,
    fields
  };
}

function matchesAny(text, terms) {
  return terms.some((term) => text.includes(term));
}

function detectMoroccanCity(text) {
  const cities = [
    "Casablanca",
    "Rabat",
    "Marrakech",
    "Fes",
    "Tanger",
    "Agadir",
    "Meknes",
    "Oujda",
    "Kenitra",
    "Tetouan"
  ];
  const lower = text.toLowerCase();
  return cities.find((city) => lower.includes(city.toLowerCase())) || "";
}

function computeReadiness(session) {
  const fields = session.fields;
  if (!fields.documentType) {
    return { ready: false, reply: "Tu veux un devis ou une facture ?" };
  }
  if (!fields.description) {
    return { ready: false, reply: "Decris la prestation en quelques mots." };
  }
  if (!fields.amount && !session.allowEstimate) {
    return {
      ready: false,
      reply: "Quel est le montant ou budget total ? (ou dis 'estime')"
    };
  }
  return { ready: true, reply: "Parfait, je genere le document." };
}

function buildPayloadFromSession(session) {
  const fields = session.fields;
  let description = fields.description || "";
  if (fields.amount && fields.currency) {
    description += ` (budget ${fields.amount} ${fields.currency})`;
  }
  if (fields.advancePercent) {
    description += ` (acompte ${fields.advancePercent}%)`;
  }

  return {
    documentType: fields.documentType || "devis",
    description,
    businessName: fields.businessName || "",
    clientName: fields.clientName || "",
    city: fields.city || "",
    invoiceNumber: fields.invoiceNumber || "",
    issueDate: fields.issueDate || "",
    dueDate: fields.dueDate || "",
    withVat: fields.withVat,
    marginPercent: fields.marginPercent
  };
}

