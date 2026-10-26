const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");
const numbers = require("./whatsappNumbers");
const { mayUseNumber } = require("../middleware/whatsappNumber");
const { roleHasPermission } = require("../config/permissions");

// Two rooms per line. `number:<id>` carries the inbox — messages, conversation
// changes, notes — and is only joined with conversation:read.
// `number:<id>:campaigns` carries campaign live updates (progress, paused,
// approved…) and is joined by everyone on the line, so MARKETING, who has no
// inbox access, still sees their sends move.
const numberRoom = (numberId) => `number:${numberId}`;
const campaignRoom = (numberId) => `number:${numberId}:campaigns`;
const canReadInbox = (user) => roleHasPermission(user?.role, "conversation:read");

let io;
// How long after a user's last tab closes before they show as offline.
const OFFLINE_GRACE_MS = Number(process.env.OFFLINE_GRACE_MS) || 60 * 1000;

const initSocket = (httpServer) => {
  io = require("socket.io")(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  // Authenticate every socket connection. The browser sends the httpOnly JWT
  // cookie on the handshake (client must use withCredentials); non-browser
  // clients may pass the token via handshake auth instead. Reject anything
  // without a valid token so message events are never broadcast to strangers.
  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || "");
      const token = cookies.token || socket.handshake.auth?.token;
      if (!token) return next(new Error("Unauthorized"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Same authoritative check as middleware/auth.js. Trusting the handshake
      // claims alone would let a deactivated or deleted user keep receiving
      // every message.created event in the system for up to 8 hours.
      //
      // findUnique, not update: a socket lives for hours, so bumping
      // lastActiveAt here would make "last active" meaningless.
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, username: true, role: true, isActive: true, tokenVersion: true },
      });
      if (!user || !user.isActive) return next(new Error("Unauthorized"));
      // Signed out by a password change or reset (see middleware/auth.js).
      if ((decoded.tv ?? 0) !== user.tokenVersion) return next(new Error("Unauthorized"));

      socket.user = { id: user.id, username: user.username, role: user.role };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", async (socket) => {
    // Per-user room so user.controller can force-disconnect one specific
    // account the instant it's deactivated, deleted, or demoted. This room is
    // only ever a kick target.
    socket.join(`user:${socket.user.id}`);

    // Join the number room from the HANDSHAKE, before any event can be
    // delivered. Doing it here rather than via a follow-up "subscribe" emit is
    // what removes the window in which the previous number's events would still
    // arrive after the user switched.
    await joinNumberRoom(socket, socket.handshake.auth?.whatsappNumberId);

    console.log("Socket client connected:", socket.id, "user:", socket.user?.username);

    // Kept as well as the handshake join: a client that switches numbers without
    // reconnecting can re-room in place.
    socket.on("number.subscribe", async (payload, ack) => {
      const id = typeof payload === "object" && payload !== null ? payload.whatsappNumberId : payload;
      const ok = await joinNumberRoom(socket, id);
      if (typeof ack === "function") ack({ ok, whatsappNumberId: socket.data.whatsappNumberId ?? null });
    });

    // The number is taken from the socket's own room, never from the client
    // payload — otherwise a client could inject typing indicators into another
    // number's inbox.
    socket.on("typing.start", ({ conversationId, username }) => {
      const room = socket.data.whatsappNumberId;
      if (!room || !roleHasPermission(socket.user.role, "conversation:write")) return;
      socket.to(numberRoom(room)).emit("typing.start", { conversationId, username });
    });

    socket.on("typing.stop", ({ conversationId, username }) => {
      const room = socket.data.whatsappNumberId;
      if (!room || !roleHasPermission(socket.user.role, "conversation:write")) return;
      socket.to(numberRoom(room)).emit("typing.stop", { conversationId, username });
    });

    // Using the app means being available: an agent the app marked offline
    // (browser closed) is online again when they come back. A break they set
    // themselves is left alone.
    if (socket.user?.id) {
      prisma.user
        .updateMany({ where: { id: socket.user.id, status: "OFFLINE", isActive: true }, data: { status: "ONLINE" } })
        .catch(() => {});
    }

    socket.on("disconnect", () => {
      console.log("Socket client disconnected:", socket.id);
      // Closing the browser used to leave an agent "Online" forever (presence
      // only changed at login/logout). Once their last tab has been gone for
      // a short while — long enough to survive a page reload — they are offline.
      const userId = socket.user?.id;
      if (userId) {
        setTimeout(async () => {
          try {
            const live = await io.in(`user:${userId}`).fetchSockets();
            if (live.length === 0) {
              await prisma.user.updateMany({ where: { id: userId, status: { not: "OFFLINE" } }, data: { status: "OFFLINE" } });
            }
          } catch (err) {
            console.error("Socket: presence update failed:", err.message);
          }
        }, OFFLINE_GRACE_MS);
      }
    });
  });

  return io;
};

// The disconnect timer above lives in memory: if the server stops or crashes
// while people are connected, nobody marks them offline and they show
// "Online" forever. This sweep is the source of truth — anyone shown as online
// (or on a break) with no open connection to this server is offline. Runs once
// shortly after start-up (open browsers reconnect within seconds of a
// restart) and then every couple of minutes. Assumes one backend instance,
// like the rest of the app's in-memory state.
const PRESENCE_SWEEP_MS = 2 * 60 * 1000;

async function sweepPresence() {
  if (!io) return 0;
  const shown = await prisma.user.findMany({ where: { status: { not: "OFFLINE" } }, select: { id: true } });
  const gone = [];
  for (const { id } of shown) {
    const live = await io.in(`user:${id}`).fetchSockets();
    if (live.length === 0) gone.push(id);
  }
  if (gone.length) {
    await prisma.user.updateMany({ where: { id: { in: gone }, status: { not: "OFFLINE" } }, data: { status: "OFFLINE" } });
  }
  return gone.length;
}

function startPresenceSweep() {
  const run = () =>
    sweepPresence()
      .then((n) => n && console.log(`[Presence] marked ${n} user(s) offline (no open connection)`))
      .catch((err) => console.error("[Presence] sweep failed:", err.message));
  setTimeout(run, Math.max(OFFLINE_GRACE_MS, 30 * 1000));
  setInterval(run, PRESENCE_SWEEP_MS).unref();
}

// Move a socket into exactly one number room, validating that the user may use
// it. Falls back to the default number so a client that sends nothing still
// receives its own traffic rather than silently receiving none.
const joinNumberRoom = async (socket, requestedId) => {
  try {
    const id = Number(requestedId);
    let number = Number.isInteger(id) && id > 0 ? await numbers.getById(id) : null;
    if (!number || !number.isActive) number = await numbers.getDefaultFor(socket.user);
    if (!number || !mayUseNumber(socket.user, number)) return false;

    for (const room of socket.rooms) {
      if (room.startsWith("number:")) socket.leave(room);
    }
    socket.join(campaignRoom(number.id));
    if (canReadInbox(socket.user)) socket.join(numberRoom(number.id));
    socket.data.whatsappNumberId = number.id;
    return true;
  } catch (err) {
    console.error("Socket: failed to join number room:", err.message);
    return false;
  }
};

const getIO = () => {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
};

// Emit to everyone currently viewing one number. Every scoped event must go
// through this rather than io.emit — a global broadcast leaks one line's
// messages, unread counts and campaign progress to agents working another.
//
// The id is stamped into the payload as well as used for routing, so a client
// can still tell events apart if it is ever in more than one room.
//
// campaign.* events go to both rooms (socket.io delivers once per socket even
// when it is in both); everything else is inbox traffic and goes to the inbox
// room only.
const emitToNumber = (numberId, event, payload) => {
  if (!io) return;
  if (numberId === null || numberId === undefined) {
    console.warn(`Socket: "${event}" emitted with no number — dropped rather than broadcast`);
    return;
  }
  const rooms = event.startsWith("campaign.") ? [numberRoom(numberId), campaignRoom(numberId)] : numberRoom(numberId);
  io.to(rooms).emit(event, { ...payload, whatsappNumberId: numberId });
};

// For genuinely account-wide events that are not tied to one line.
const emitGlobal = (event, payload) => {
  if (!io) return;
  io.emit(event, payload);
};

// Alert every connected user who could pick up a chat on this number —
// whichever line they're currently viewing — and nobody else. For moments that
// need a person (a flow handing a customer over), where emitToNumber would
// miss an agent looking at another line, and emitGlobal would tell everyone.
const emitToNumberStaff = async (numberId, event, payload) => {
  if (!io) return;
  try {
    const number = await numbers.getById(numberId);
    if (!number) return;
    for (const socket of io.sockets.sockets.values()) {
      const user = socket.user;
      if (user && roleHasPermission(user.role, "conversation:write") && mayUseNumber(user, number)) {
        socket.emit(event, { ...payload, whatsappNumberId: numberId });
      }
    }
  } catch (err) {
    console.error(`Socket: "${event}" staff alert failed:`, err.message);
  }
};

// Drop every live socket belonging to one user. Called after deactivate,
// delete, and role change so the socket layer can't outlive the HTTP layer's
// authoritative check.
//
// Checks `io` directly rather than calling getIO(), which throws when the
// socket layer was never initialised — e.g. under `npm run seed`.
// Tell one person (all their open tabs), whatever line they are looking at.
const emitToUser = (userId, event, payload) => {
  if (!io || !userId) return;
  io.to(`user:${userId}`).emit(event, payload);
};

const disconnectUser = (userId) => {
  if (!io) return;
  io.in(`user:${userId}`).disconnectSockets(true);
};

module.exports = { initSocket, getIO, disconnectUser, emitToNumber, emitGlobal, emitToNumberStaff, emitToUser, startPresenceSweep, sweepPresence };
