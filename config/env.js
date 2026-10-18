const dotenv = require("dotenv");
dotenv.config({ path: "./config.env" });

// WhatsApp numbers now live in the database, so WHATSAPP_PHONE_NUMBER_ID,
// WHATSAPP_WABA_ID and WHATSAPP_ACCESS_TOKEN are no longer hard requirements —
// they are the bootstrap source for `npm run seed:numbers` and the token behind
// the seeded row. VERIFY_TOKEN and APP_SECRET stay required: both are Meta
// APP-level, shared by every number, and inbound webhooks fail closed without them.
const required = [
  "DATABASE_URL",
  "JWT_SECRET",
  "PORT",
  "WHATSAPP_VERIFY_TOKEN",
  "WHATSAPP_APP_SECRET",
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
}

// Only warn about the storage backend that's actually active, so switching
// providers doesn't spam warnings about the unused one.
const storageProvider = (process.env.STORAGE_PROVIDER || "cloudinary").toLowerCase();
const storageVars = storageProvider === "r2"
  ? ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_NAME", "R2_PUBLIC_URL"]
  : ["CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY", "CLOUDINARY_API_SECRET"];

const recommended = [...storageVars];
for (const key of recommended) {
  if (!process.env[key]) {
    console.warn(`[Config] Warning: ${key} is not set — some features will be unavailable`);
  }
}

// On Railway, anything but NODE_ENV=production means insecure cookies, API docs
// and the /api/dev tools exposed on a public URL.
if (process.env.RAILWAY_ENVIRONMENT && process.env.NODE_ENV !== "production") {
  console.warn(
    `\n[Config] !!! WARNING: running on Railway with NODE_ENV=${process.env.NODE_ENV || "(unset)"}` +
    " — set NODE_ENV=production. Cookies are not Secure, /api-docs and /api/dev are exposed. !!!\n",
  );
}

// Without FRONTEND_URL, CORS and sockets fall back to http://localhost:3000
// and the deployed frontend can't call the API at all.
if (process.env.NODE_ENV === "production") {
  for (const key of ["FRONTEND_URL"]) {
    if (!process.env[key]) console.warn(`[Config] Warning: ${key} is required in production but is not set`);
  }
}

// Expose API version so all modules use the same one
process.env.WHATSAPP_API_VERSION = process.env.WHATSAPP_API_VERSION || "v19.0";
