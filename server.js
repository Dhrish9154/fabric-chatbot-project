const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
require("dotenv").config();

const app = express();
app.disable("x-powered-by");
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    }
  })
);

const CATALOG_PATH = path.join(__dirname, "data", "catalog.json");
const CATALOG_DOCUMENTS_PATH = path.join(__dirname, "data", "catalog_documents.json");
const INTERACTION_LOG_PATH = path.join(__dirname, "data", "interaction_log.jsonl");
const CUSTOMER_PROFILES_PATH = path.join(__dirname, "data", "customer_profiles.json");

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const SALES_NUMBER = process.env.SALES_NUMBER || "+91XXXXXXXXXX";
const WEBSITE_URL = process.env.WEBSITE_URL || "";
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || process.env.APP_SECRET;
const LOW_STOCK_THRESHOLD = Number.parseFloat(process.env.LOW_STOCK_THRESHOLD || "250");
const userState = {};
const customerProfiles = loadCustomerProfiles();
const whatsappClient = axios.create({
  baseURL: `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  }
});

function validateEnvironment() {
  const required = ["WHATSAPP_TOKEN", "PHONE_NUMBER_ID", "VERIFY_TOKEN"];
  const missing = required.filter((name) => !process.env[name]);

  if (process.env.NODE_ENV === "production" && !APP_SECRET) {
    missing.push("WHATSAPP_APP_SECRET");
  }

  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (!APP_SECRET) {
    console.warn("WHATSAPP_APP_SECRET is not set. Webhook signature checks are disabled.");
  }
}

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function loadCustomerProfiles() {
  try {
    if (!fs.existsSync(CUSTOMER_PROFILES_PATH)) {
      return {};
    }

    return loadJson(CUSTOMER_PROFILES_PATH);
  } catch (error) {
    console.error("Customer profile load error:", error.message);
    return {};
  }
}

function saveCustomerProfiles() {
  try {
    fs.mkdirSync(path.dirname(CUSTOMER_PROFILES_PATH), { recursive: true });
    fs.writeFileSync(CUSTOMER_PROFILES_PATH, JSON.stringify(customerProfiles, null, 2));
  } catch (error) {
    console.error("Customer profile save error:", error.message);
  }
}

function loadCatalogData() {
  return {
    catalog: loadJson(CATALOG_PATH),
    catalogDocuments: loadJson(CATALOG_DOCUMENTS_PATH)
  };
}

function logInteraction(eventType, details = {}) {
  try {
    fs.mkdirSync(path.dirname(INTERACTION_LOG_PATH), { recursive: true });
    fs.appendFileSync(
      INTERACTION_LOG_PATH,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        event_type: eventType,
        ...details
      })}\n`
    );
  } catch (error) {
    console.error("Interaction log error:", error.message);
  }
}

function getCustomerProfile(to) {
  customerProfiles[to] = {
    whatsappNumber: to,
    companyName: "",
    phoneNumber: "",
    onboardingStep: "not_started",
    onboardingComplete: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(customerProfiles[to] || {})
  };

  return customerProfiles[to];
}

function updateCustomerProfile(to, updates) {
  customerProfiles[to] = {
    ...getCustomerProfile(to),
    ...updates,
    updatedAt: new Date().toISOString()
  };
  saveCustomerProfiles();
  return customerProfiles[to];
}

function normalizePhoneNumber(value) {
  const text = String(value || "").trim();
  const leadingPlus = text.startsWith("+") ? "+" : "";
  const digits = text.replace(/\D/g, "");
  return `${leadingPlus}${digits}`;
}

function isValidPhoneNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15;
}

function normalizeWhatsAppLinkNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function buildSalesWhatsAppLink(to) {
  const salesNumber = normalizeWhatsAppLinkNumber(SALES_NUMBER);

  if (!salesNumber) {
    return null;
  }

  const profile = getCustomerProfile(to);
  const message = [
    "Hello Tianso Global sales team,",
    "",
    "I want to discuss fabrics / place an order.",
    "",
    `Company name: ${profile.companyName || "Not shared"}`,
    `Customer phone: ${profile.phoneNumber || "Not shared"}`,
    `WhatsApp number: +${normalizeWhatsAppLinkNumber(profile.whatsappNumber || to)}`
  ].join("\n");

  return `https://wa.me/${salesNumber}?text=${encodeURIComponent(message)}`;
}

function isUpdateDetailsMessage(text) {
  const normalizedText = String(text || "").trim().toLowerCase();
  return ["update details", "reset details", "change details", "change company", "change phone"].includes(
    normalizedText
  );
}

function getTemplateButtonAction(message) {
  if (message.type !== "button") {
    return null;
  }

  const buttonValue = String(message.button?.payload || message.button?.text || "")
    .trim()
    .toLowerCase();

  if (buttonValue === "view_fabrics" || buttonValue === "view fabrics") {
    return "view_fabrics";
  }

  if (buttonValue === "talk_sales" || buttonValue === "contact sales" || buttonValue === "contact_sales") {
    return "talk_sales";
  }

  return null;
}

function getAvailableQualities(catalog) {
  return Object.keys(catalog.qualities || {}).sort();
}

function getVisibleDesigns(quality, catalog) {
  return (catalog.qualities?.[quality] || []).filter((design) => !design.hidden_from_catalog);
}

function getVisibleDesignExamples(catalog, preferredQuality) {
  const qualities = preferredQuality
    ? [preferredQuality, ...getAvailableQualities(catalog).filter((quality) => quality !== preferredQuality)]
    : getAvailableQualities(catalog);
  const examples = [];

  for (const quality of qualities) {
    const designs = getVisibleDesigns(quality, catalog);
    if (designs[0]) {
      examples.push(designs[0].id);
    }

    if (examples.length >= 2) {
      break;
    }
  }

  return examples;
}

function findVisibleDesign(designId, catalog, preferredQuality) {
  const normalizedDesignId = normalizeDesignLookup(designId);
  const qualities = preferredQuality
    ? [preferredQuality, ...Object.keys(catalog.qualities || {}).filter((quality) => quality !== preferredQuality)]
    : Object.keys(catalog.qualities || {});

  for (const quality of qualities) {
    const match = (catalog.qualities?.[quality] || []).find((item) => {
      if (item.hidden_from_catalog) {
        return false;
      }

      const itemId = normalizeDesignLookup(item.id);
      const normalizedQuality = normalizeDesignLookup(quality);
      const shortId = itemId.startsWith(normalizedQuality) ? itemId.slice(normalizedQuality.length) : itemId;

      return itemId === normalizedDesignId || shortId === normalizedDesignId;
    });

    if (match) {
      return { quality, design: match };
    }
  }

  return null;
}

function getStockStatus(stock) {
  if (typeof stock !== "number" || Number.isNaN(stock)) {
    return {
      label: "Unavailable",
      line: "Stock status: currently unavailable"
    };
  }

  if (stock <= 0) {
    return {
      label: "Out of stock",
      line: "Stock status: out of stock"
    };
  }

  if (stock <= LOW_STOCK_THRESHOLD) {
    return {
      label: "Low stock",
      line: `Stock status: low stock (${stock} metres available)`
    };
  }

  return {
    label: "Available",
    line: `Stock status: available (${stock} metres available)`
  };
}

function normalizeDesignLookup(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[\s_-]+/g, "");
}

function formatColorAvailability(design) {
  if (design.color_stock && typeof design.color_stock === "object") {
    const colorEntries = Object.entries(design.color_stock)
      .filter((entry) => typeof entry[1] === "number" && entry[1] > 0)
      .sort((left, right) => right[1] - left[1])
      .map(([color, stock]) => `- ${color}: ${stock} m`);

    if (colorEntries.length) {
      return `Colour-wise stock:\n${colorEntries.join("\n")}`;
    }
  }

  if (Array.isArray(design.colors) && design.colors.length) {
    return `Colours available: ${design.colors.join(", ")}`;
  }

  return null;
}

function extractDesignCodeFromText(text, preferredQuality, catalog) {
  const normalizedText = String(text || "").toUpperCase();
  const qualities = getAvailableQualities(catalog);
  const qualityPattern = qualities
    .map((quality) => quality.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");

  const qualityMatch = qualityPattern
    ? normalizedText.match(new RegExp(`\\b(${qualityPattern})[\\s_-]*(\\d{1,5})\\b`))
    : null;
  if (qualityMatch) {
    return `${qualityMatch[1]}_${qualityMatch[2]}`;
  }

  if (preferredQuality) {
    const shortCodeMatch = normalizedText.match(/\b(\d{1,5})\b/);
    if (shortCodeMatch) {
      return `${preferredQuality}_${shortCodeMatch[1]}`;
    }
  }

  return null;
}

function getQualityByListNumber(text, catalog) {
  const trimmedText = String(text || "").trim();

  if (!/^\d+$/.test(trimmedText)) {
    return null;
  }

  const index = Number.parseInt(trimmedText, 10) - 1;
  const qualities = getAvailableQualities(catalog);
  return qualities[index] || null;
}

function getQualityByName(text, catalog) {
  const normalizedText = String(text || "").trim().toUpperCase();
  return getAvailableQualities(catalog).find((quality) => quality.toUpperCase() === normalizedText) || null;
}

function isGreetingMessage(text) {
  const normalizedText = text.trim().toLowerCase();
  const greetings = new Set([
    "hi",
    "hii",
    "hiii",
    "hello",
    "helo",
    "hey",
    "heyy",
    "hlo",
    "hy",
    "start"
  ]);

  return greetings.has(normalizedText);
}

function isCatalogIntentMessage(text) {
  const normalizedText = text.trim().toLowerCase();
  return ["catalog", "catalogue", "collection", "show fabrics", "view fabrics", "fabrics"].some(
    (phrase) => normalizedText.includes(phrase)
  );
}

function isHelpIntentMessage(text) {
  const normalizedText = text.trim().toLowerCase();
  return ["help", "options", "menu", "support"].some((phrase) => normalizedText === phrase);
}

function isCommercialIntentMessage(text) {
  const normalizedText = text.trim().toLowerCase();
  const compactText = normalizedText.replace(/[^\p{L}\p{N}]+/gu, " ").trim();

  if (!normalizedText) {
    return false;
  }

  const salesPhrases = [
    "place order",
    "want to order",
    "i want",
    "want",
    "buy",
    "book order",
    "confirm order",
    "what is the rate",
    "what's the rate",
    "price",
    "pricing",
    "delivery",
    "deliver",
    "receive",
    "recieve",
    "how long",
    "lead time",
    "when will i get",
    "when will i receive",
    "when can i get",
    "metre",
    "meter",
    "quantity",
    "qty",
    "required quantity",
    "i require",
    "required",
    "i need",
    "minimum order",
    "moq",
    "colour",
    "color",
    "shade",
    "stock by colour",
    "stock by color",
    "which colour",
    "which color",
    "how much stock",
    "available stock",
    "recieve my stock",
    "receive my stock",
    "when will i recieve",
    "till when will i recieve my stock",
    "till when will i receive my stock",
    "what is the price",
    "whats the price",
    "what is the rate",
    "whats the rate",
    "whate is the rate"
  ];

  const salesPatterns = [
    /\b(order|purchase|book)\b/,
    /\b(?:want|need|require|buy|order|book|confirm)\b.*\b\d+(?:\.\d+)?\s*(?:m|meter|meters|metre|metres)\b/,
    /\b\d+(?:\.\d+)?\s*m\b/,
    /\b\d+(?:\.\d+)?\s*(?:m|meter|meters|metre|metres)\b.*\b[a-z0-9][a-z0-9\s_-]*\b\d{1,5}\b/,
    /\b(rate|price|pricing|cost)\b/,
    /\b(?:what|whats|what's|whate)\b.*\b(rate|price|pricing|cost)\b/,
    /\b(delivery|deliver|dispatch|shipment|ship)\b/,
    /\b(receive|recieve|get it|arrival|lead time)\b/,
    /\b(?:till|until|when)\b.*\b(receive|recieve|deliver|delivery|dispatch)\b/,
    /\b(?:qty|quantity|metre|meter|meters|metres)\b/,
    /\bminimum order|moq\b/,
    /\b(?:which|what)\s+(?:colour|color|shade)\b/,
    /\b(?:colour|color|shade)\b.*\b(?:stock|available|availability)\b/,
    /\b(?:stock|available|availability)\b.*\b(?:colour|color|shade)\b/,
    /\bneed\b.*\b\d+(?:\.\d+)?\s*(?:m|meter|meters|metre|metres)\b/,
    /\brequire\b.*\b\d+(?:\.\d+)?\s*(?:m|meter|meters|metre|metres)\b/,
    /\brequired\b/,
    /\bmy stock\b.*\b(?:receive|recieve|delivery|deliver|dispatch)\b/,
    /\b(?:receive|recieve|delivery|deliver|dispatch)\b.*\bmy stock\b/
  ];

  return (
    /^\d+(?:\.\d+)?\s*m$/.test(compactText) ||
    salesPhrases.some((phrase) => normalizedText.includes(phrase)) ||
    salesPatterns.some((pattern) => pattern.test(normalizedText))
  );
}

function isStockIntentMessage(text) {
  const normalizedText = text.trim().toLowerCase();

  if (!normalizedText) {
    return false;
  }

  const stockPhrases = ["check stock", "stock", "available", "availability", "in stock"];
  const stockPatterns = [
    /\bcheck\b.*\bstock\b/,
    /\bhow much\b.*\bstock\b/,
    /\bstock\b.*\bfor\b/,
    /\bavailable\b.*\bfor\b/
  ];

  return (
    stockPhrases.some((phrase) => normalizedText.includes(phrase)) ||
    stockPatterns.some((pattern) => pattern.test(normalizedText))
  );
}

function isValidSignature(req) {
  if (!APP_SECRET) {
    return true;
  }

  const signatureHeader = req.get("x-hub-signature-256");

  if (!signatureHeader || !req.rawBody) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", APP_SECRET)
    .update(req.rawBody)
    .digest("hex")}`;
  const actualSignature = Buffer.from(signatureHeader);
  const expectedSignatureBuffer = Buffer.from(expectedSignature);

  if (actualSignature.length !== expectedSignatureBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualSignature, expectedSignatureBuffer);
}

async function sendMessage(payload) {
  try {
    await whatsappClient.post("/messages", payload);
    return true;
  } catch (error) {
    console.error("WhatsApp send error:");
    console.error(error.response?.data || error.message);
    return false;
  }
}

async function sendCompanyNamePrompt(to) {
  updateCustomerProfile(to, {
    onboardingStep: "company_name",
    onboardingComplete: false
  });

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        "Welcome to Tianso Global.\n" +
        "Before we show the fabric menu, please share your company name."
    }
  });

  logInteraction("company_name_prompt_sent", { to });
}

async function sendPhoneNumberPrompt(to, companyName) {
  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        `Thank you, ${companyName}.\n` +
        "Please share your phone number for sales follow-up."
    }
  });

  logInteraction("phone_number_prompt_sent", { to });
}

async function handleOnboarding(message) {
  const from = message.from;
  let profile = getCustomerProfile(from);
  const pendingAction = getTemplateButtonAction(message);

  if (pendingAction) {
    updateCustomerProfile(from, { pendingAction });
    profile = getCustomerProfile(from);
  }

  if (message.type === "text" && isUpdateDetailsMessage(message.text.body)) {
    updateCustomerProfile(from, {
      companyName: "",
      phoneNumber: "",
      onboardingStep: "not_started",
      onboardingComplete: false
    });
    profile = getCustomerProfile(from);
  }

  if (profile.onboardingComplete && !(message.type === "text" && isUpdateDetailsMessage(message.text.body))) {
    return false;
  }

  if (profile.onboardingStep === "not_started" || message.type !== "text") {
    await sendCompanyNamePrompt(from);
    return true;
  }

  const rawText = message.text.body.trim();

  if (!rawText) {
    await sendCompanyNamePrompt(from);
    return true;
  }

  if (profile.onboardingStep === "company_name") {
    if (!profile.companyName && isGreetingMessage(rawText)) {
      await sendCompanyNamePrompt(from);
      return true;
    }

    const companyName = rawText;

    updateCustomerProfile(from, {
      companyName,
      onboardingStep: "phone_number"
    });

    await sendPhoneNumberPrompt(from, companyName);
    logInteraction("company_name_collected", { from, company_name: companyName });
    return true;
  }

  if (profile.onboardingStep === "phone_number") {
    const phoneNumber = normalizePhoneNumber(rawText);

    if (!isValidPhoneNumber(phoneNumber)) {
      await sendMessage({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: {
          body: "Please send a valid phone number with country code if possible. Example: +91XXXXXXXXXX"
        }
      });
      logInteraction("phone_number_invalid", { from, attempted_value: rawText });
      return true;
    }

    updateCustomerProfile(from, {
      phoneNumber,
      onboardingStep: "complete",
      onboardingComplete: true,
      pendingAction: ""
    });

    logInteraction("phone_number_collected", { from, phone_number: phoneNumber });

    await sendMessage({
      messaging_product: "whatsapp",
      to: from,
      type: "text",
      text: {
        body: "Thank you. Your details are saved."
      }
    });

    if (profile.pendingAction === "view_fabrics") {
      await sendAllQualities(from);
    } else if (profile.pendingAction === "talk_sales") {
      await sendSales(from, "welcome_template_button");
    } else {
      await sendWelcome(from);
    }
    return true;
  }

  await sendCompanyNamePrompt(from);
  return true;
}

function buildWelcomeSections() {
  const sections = [
    {
      title: "Quick actions",
      rows: [
        { id: "view_fabrics", title: "View fabrics" },
        { id: "confirm_order", title: "Confirm order" },
        { id: "talk_sales", title: "Talk to sales" }
      ]
    }
  ];

  if (WEBSITE_URL) {
    sections[0].rows.push({ id: "view_website", title: "View website" });
  }

  return sections;
}

async function sendWelcome(to) {
  userState[to] = {
    ...(userState[to] || {}),
    welcomePage: 0
  };

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "list",
      body: {
        text:
          "Welcome to Tianso Global.\n" +
          "Threads That Speak. Exclusive premium shirting. Fabric That Defines Your Style.\n" +
          "Choose an option to continue:"
      },
      action: {
        button: "Open menu",
        sections: buildWelcomeSections()
      }
    }
  });

  logInteraction("welcome_sent", { to });
}

async function sendAllQualities(to) {
  const { catalog } = loadCatalogData();
  const qualities = getAvailableQualities(catalog);
  const qualityList = qualities.map((quality, index) => `${index + 1}. ${quality}`).join("\n");

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        `Available fabric qualities (${qualities.length}):\n\n` +
        `${qualityList}\n\n` +
        "Reply with the quality number or quality name to receive its catalog PDF."
    }
  });

  logInteraction("qualities_list_sent", { to, quality_count: qualities.length });
}

async function sendWebsite(to) {
  const body = WEBSITE_URL
    ? `You can explore our website here:\n${WEBSITE_URL}`
    : "Our website link is not configured right now. Please contact our sales team for assistance.";

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body }
  });

  logInteraction("website_requested", { to, website_url_configured: Boolean(WEBSITE_URL) });
}

async function sendSales(to, context = "sales_support") {
  const salesWhatsAppLink = buildSalesWhatsAppLink(to);

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        "To confirm your order, please contact our sales team.\n" +
        "They will help with quantity, rate, delivery timeline, and color-wise stock confirmation.\n" +
        `Contact: ${SALES_NUMBER}` +
        (salesWhatsAppLink
          ? `\n\nTap here to open sales chat with your details filled in:\n${salesWhatsAppLink}`
          : "")
    }
  });

  logInteraction("sales_requested", { to, context, sales_link_sent: Boolean(salesWhatsAppLink) });
}

async function sendHelp(to) {
  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        "You can use this chatbot in a few simple ways:\n" +
        "- Choose View fabrics to open the quality menu\n" +
        "- Reply with a quality number like 1 or 2 to receive that catalog\n" +
        "- Send a design code like BALI_388, bali-388, or bali 388 to check stock\n" +
        "- Ask commercial questions like price, delivery, order, quantity, or colour-wise stock to connect with sales\n" +
        "- Send update details to change your company name or phone number"
    }
  });

  await sendWelcome(to);
  logInteraction("help_requested", { to });
}

async function sendQualityDesigns(to, quality) {
  const { catalog, catalogDocuments } = loadCatalogData();
  const designs = getVisibleDesigns(quality, catalog);
  const documentInfo = catalogDocuments[quality];

  if (!designs.length) {
    await sendMessage({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: `No active designs are available for ${quality} right now.`
      }
    });
    return sendWelcome(to);
  }

  userState[to] = {
    ...(userState[to] || {}),
    currentQuality: quality
  };

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        `${quality} collection from Tianso Global.\n` +
        "Exclusive design development with consistent hand-feel, shade accuracy, and on-time replenishment.\n" +
        `Reply with the design code to check stock.\nExample format:\n*${designs[0].id}*`
    }
  });

  let documentSent = false;

  if (documentInfo?.media_id || documentInfo?.url) {
    const documentPayload = documentInfo.media_id
      ? {
          id: documentInfo.media_id,
          filename: documentInfo.filename || `${quality}_catalog.pdf`
        }
      : {
          link: documentInfo.url,
          filename: documentInfo.filename || `${quality}_catalog.pdf`
        };

    documentSent = await sendMessage({
      messaging_product: "whatsapp",
      to,
      type: "document",
      document: documentPayload
    });
  }

  if (!documentInfo?.media_id && !documentInfo?.url) {
    await sendMessage({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body: `Catalog PDF is not available for ${quality} right now.`
      }
    });
  } else if (!documentSent) {
    await sendMessage({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body:
          `We could not send the ${quality} catalog PDF right now.\n` +
          `Please contact our sales team for assistance: ${SALES_NUMBER}`
      }
    });
  }

  if (documentSent) {
    await sendMessage({
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: {
        body:
          `After reviewing the catalog, please contact our sales team to confirm your order.\n` +
          `Contact: ${SALES_NUMBER}`
      }
    });
  }

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "Choose your next step:"
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: `restart_${quality}`, title: "Send catalog again" }
          },
          {
            type: "reply",
            reply: { id: "confirm_order", title: "Confirm order" }
          },
          {
            type: "reply",
            reply: { id: "talk_sales", title: "Talk to sales" }
          }
        ]
      }
    }
  });

  logInteraction("quality_opened", { to, quality, document_sent: documentSent });
}

async function sendInvalidDesignMessage(to, catalog, preferredQuality) {
  const examples = getVisibleDesignExamples(catalog, preferredQuality);
  const examplesLine = examples.length ? `Try codes like *${examples.join("* or *")}*.` : "";

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        "We could not find that design code in the active Tianso Global collection.\n" +
        "Please choose a quality first or send a valid design code.\n" +
        examplesLine
    }
  });
}

async function sendStock(to, designId, source = "text") {
  const { catalog } = loadCatalogData();
  const preferredQuality = userState[to]?.currentQuality;
  const foundMatch = findVisibleDesign(designId, catalog, preferredQuality);

  if (!foundMatch) {
    await sendInvalidDesignMessage(to, catalog, preferredQuality);
    logInteraction("stock_lookup_missing", {
      to,
      design_id: designId,
      preferred_quality: preferredQuality || null,
      source
    });
    return;
  }

  const { design: found, quality: foundQuality } = foundMatch;
  const colorAvailability = formatColorAvailability(found);
  const stockStatus = getStockStatus(found.stock);
  const salesWhatsAppLink = buildSalesWhatsAppLink(to);

  userState[to] = {
    ...(userState[to] || {}),
    currentQuality: foundQuality
  };

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: {
      body:
        "Crafted Elegance, Worn with Pride.\n" +
        "Design selected.\n" +
        `Quality: ${foundQuality}\n` +
        `Design: ${found.id}\n` +
        `${stockStatus.line}\n` +
        `${colorAvailability ? `${colorAvailability}\n` : ""}` +
        `Please contact our sales team to confirm your order: ${SALES_NUMBER}` +
        (salesWhatsAppLink
          ? `\n\nOpen sales chat with your details filled in:\n${salesWhatsAppLink}`
          : "")
    }
  });

  await sendMessage({
    messaging_product: "whatsapp",
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: "What would you like to do next?"
      },
      action: {
        buttons: [
          {
            type: "reply",
            reply: { id: `restart_${foundQuality}`, title: "Send catalog again" }
          },
          {
            type: "reply",
            reply: { id: "confirm_order", title: "Confirm order" }
          },
          {
            type: "reply",
            reply: { id: "talk_sales", title: "Talk to sales" }
          }
        ]
      }
    }
  });

  logInteraction("stock_lookup", {
    to,
    design_id: found.id,
    quality: foundQuality,
    stock_status: stockStatus.label,
    source
  });
}

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

app.get("/", (req, res) => {
  res.status(200).json({
    ok: true,
    service: "tianso-fabric-chatbot"
  });
});

app.get("/health", (req, res) => {
  try {
    const { catalog, catalogDocuments } = loadCatalogData();
    res.status(200).json({
      ok: true,
      qualities: Object.keys(catalog.qualities || {}).length,
      catalog_documents: Object.keys(catalogDocuments || {}).length
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      error: "Catalog data could not be loaded"
    });
  }
});

async function handleIncomingMessage(message) {
  if (!message) {
    return;
  }

  const from = message.from;
  logInteraction("message_received", { from, message_type: message.type });

  if (await handleOnboarding(message)) {
    return;
  }

  if (message.type === "text") {
    const rawText = message.text.body.trim();
    const { catalog } = loadCatalogData();
    const preferredQuality = userState[from]?.currentQuality;
    const extractedDesignCode = extractDesignCodeFromText(rawText, preferredQuality, catalog);
    const selectedQualityByName = getQualityByName(rawText, catalog);
    const selectedQualityByNumber = getQualityByListNumber(rawText, catalog);
    const commercialIntent = isCommercialIntentMessage(rawText);
    const stockIntent = isStockIntentMessage(rawText);

    if (isGreetingMessage(rawText)) {
      await sendWelcome(from);
    } else if (isHelpIntentMessage(rawText)) {
      await sendHelp(from);
    } else if (isCatalogIntentMessage(rawText)) {
      await sendAllQualities(from);
    } else if (selectedQualityByName) {
      await sendQualityDesigns(from, selectedQualityByName);
    } else if (selectedQualityByNumber) {
      await sendQualityDesigns(from, selectedQualityByNumber);
    } else if (commercialIntent) {
      await sendSales(from, "commercial_question");
    } else if (extractedDesignCode) {
      await sendStock(from, extractedDesignCode, "design_code");
    } else if (stockIntent) {
      await sendMessage({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: {
          body:
            "Please send the design code to check stock.\n" +
            "Example: BALI_388, bali-388, or bali 388."
        }
      });
    } else {
      await sendInvalidDesignMessage(from, catalog, preferredQuality);
    }
  }

  if (message.type === "interactive") {
    const replyId =
      message.interactive.list_reply?.id ||
      message.interactive.button_reply?.id;

    if (!replyId) {
      return;
    }

    if (replyId.startsWith("quality_")) {
      const quality = replyId.replace("quality_", "");
      await sendQualityDesigns(from, quality);
    } else if (replyId.startsWith("restart_")) {
      const quality = replyId.replace("restart_", "");
      await sendQualityDesigns(from, quality);
    } else if (replyId === "view_fabrics" || replyId === "view_qualities") {
      await sendAllQualities(from);
    } else if (replyId === "talk_sales") {
      await sendSales(from, "talk_sales_button");
    } else if (replyId === "confirm_order") {
      await sendSales(from, "confirm_order_button");
    } else if (replyId === "view_website") {
      await sendWebsite(from);
    }
  }

  if (message.type === "button") {
    const buttonAction = getTemplateButtonAction(message);

    if (buttonAction === "view_fabrics") {
      await sendAllQualities(from);
    } else if (buttonAction === "talk_sales") {
      await sendSales(from, "welcome_template_button");
    }
  }
}

function getWebhookMessages(body) {
  return (body.entry || []).flatMap((entry) =>
    (entry.changes || []).flatMap((change) => change.value?.messages || [])
  );
}

app.post("/webhook", async (req, res) => {
  try {
    if (!isValidSignature(req)) {
      return res.sendStatus(403);
    }

    const messages = getWebhookMessages(req.body);

    for (const message of messages) {
      await handleIncomingMessage(message);
    }

    return res.sendStatus(200);
  } catch (error) {
    console.error("Webhook error:", error);
    return res.sendStatus(500);
  }
});

validateEnvironment();

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Bot running on port ${port}`);
});
