const axios = require("axios");
require("dotenv").config();

const TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const TEMPLATE_NAME = process.env.WHATSAPP_WELCOME_TEMPLATE_NAME || "tianso_welcome";
const TEMPLATE_LANGUAGE = process.env.WHATSAPP_TEMPLATE_LANGUAGE || "en";
const recipient = process.argv[2];

if (!TOKEN || !PHONE_NUMBER_ID) {
  console.error("Missing WHATSAPP_TOKEN or PHONE_NUMBER_ID in environment.");
  process.exit(1);
}

if (!recipient) {
  console.error("Usage: node send_welcome_template.js <customer_phone_number_with_country_code>");
  console.error("Example: node send_welcome_template.js 919876543210");
  process.exit(1);
}

async function sendWelcomeTemplate() {
  const client = axios.create({
    baseURL: `https://graph.facebook.com/v23.0/${PHONE_NUMBER_ID}`,
    timeout: 15000,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json"
    }
  });

  const response = await client.post("/messages", {
    messaging_product: "whatsapp",
    to: recipient.replace(/\D/g, ""),
    type: "template",
    template: {
      name: TEMPLATE_NAME,
      language: {
        code: TEMPLATE_LANGUAGE
      },
      components: [
        {
          type: "button",
          sub_type: "quick_reply",
          index: "0",
          parameters: [{ type: "payload", payload: "view_fabrics" }]
        },
        {
          type: "button",
          sub_type: "quick_reply",
          index: "1",
          parameters: [{ type: "payload", payload: "talk_sales" }]
        }
      ]
    }
  });

  console.log("Welcome template sent.");
  console.log(JSON.stringify(response.data, null, 2));
}

sendWelcomeTemplate().catch((error) => {
  console.error("Failed to send welcome template:");
  console.error(error.response?.data || error.message);
  process.exit(1);
});
