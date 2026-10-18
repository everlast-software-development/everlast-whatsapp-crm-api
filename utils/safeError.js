// What of an error is safe to write to the log. An axios error carries the
// whole request in err.config — including the Authorization header with a
// WhatsApp access token — and logging it as-is puts that token in the host's
// log viewer. Keep the message, code and stack; for an HTTP error add only the
// response status and body (Meta's error explanation).
const safeError = (err) => {
  if (!err || typeof err !== "object") return err;
  const out = { name: err.name, message: err.message };
  if (err.code !== undefined) out.code = err.code;
  if (err.response) {
    out.status = err.response.status;
    out.data = err.response.data;
  }
  if (err.stack) out.stack = err.stack;
  return out;
};

module.exports = safeError;
