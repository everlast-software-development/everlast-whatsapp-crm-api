const jwt = require("jsonwebtoken");
const bcryptjs = require("bcryptjs");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const logAudit = require("../../utils/audit");
const { COOKIE_OPTIONS } = require("../../config/cookies");
const { permissionsFor } = require("../../config/permissions");

// Sign a session and set it as the auth cookie. `tv` is the user's
// tokenVersion: protect() and the socket handshake reject a token whose `tv`
// no longer matches, which is how a password change signs out every other
// session. Also used by changeMyPassword to keep the current tab signed in.
const issueAuthCookie = (res, user) => {
  const token = jwt.sign(
    { id: user.id, username: user.username, role: user.role, tv: user.tokenVersion ?? 0 },
    process.env.JWT_SECRET,
    { expiresIn: "8h" },
  );
  res.cookie("token", token, COOKIE_OPTIONS);
};

const login = async (req, res, next) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return next(new AppError("Username and password are required", 400));
    }

    const user = await prisma.user.findUnique({ where: { username } });
    const isMatch = user ? await bcryptjs.compare(password, user.passwordHash) : false;
    if (!isMatch) {
      // The attempted username and the IP only — never the password.
      logAudit({
        action: "auth.login_failed",
        actor: null,
        targetType: "user",
        targetId: user?.id ?? 0,
        details: { username: String(username).slice(0, 40), ip: req.ip },
      });
      return next(new AppError("Invalid credentials", 401));
    }
    // Checked after the password, so this can't be used to discover which
    // usernames exist. Previously a deactivated account was issued a token and
    // only rejected on its next request.
    if (!user.isActive) {
      return next(new AppError("This account has been deactivated", 401, "ACCOUNT_DEACTIVATED"));
    }

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "ONLINE", lastActiveAt: new Date() },
    });

    issueAuthCookie(res, user);

    logAudit({ action: "auth.login", actor: user, targetType: "user", targetId: user.id, details: { ip: req.ip } });

    res.status(200).json({
      success: true,
      user: {
        id: user.id,
        name: user.name,
        username: user.username,
        role: user.role,
        permissions: permissionsFor(user.role),
        status: "ONLINE",
      },
    });
  } catch (err) {
    next(err);
  }
};

const logout = async (req, res, next) => {
  try {
    await prisma.user.update({
      where: { id: req.user.id },
      data: { status: "OFFLINE" },
    });

    res.clearCookie("token", COOKIE_OPTIONS);
    logAudit({ action: "auth.logout", actor: req.user, targetType: "user", targetId: req.user.id, details: null });
    res.status(200).json({ success: true, message: "Logged out" });
  } catch (err) {
    next(err);
  }
};

module.exports = { login, logout, issueAuthCookie };
