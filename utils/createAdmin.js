// The first admin on an empty (production) database: `npm run create-admin`.
//
// Reads ADMIN_USERNAME and ADMIN_PASSWORD from the environment — never from
// the command line, where they would land in shell history — and never prints
// the password. Idempotent: if the account already exists nothing changes,
// unless `--reset` is passed, which sets its password from ADMIN_PASSWORD,
// re-enables it, and signs out all its sessions.
//
//   ADMIN_USERNAME=owner ADMIN_PASSWORD='…' npm run create-admin
//   ADMIN_USERNAME=owner ADMIN_PASSWORD='…' npm run create-admin -- --reset
//
// On Railway: set both variables on the service, run the command once from
// the service's shell (`railway run npm run create-admin` or `railway ssh`),
// then delete ADMIN_PASSWORD from the variables.
require("../config/env");
const prisma = require("../config/prisma");
const bcryptjs = require("bcryptjs");

const RESET = process.argv.includes("--reset");

const fail = (message) => {
  console.error(`create-admin: ${message}`);
  process.exit(1);
};

const main = async () => {
  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const password = String(process.env.ADMIN_PASSWORD || "");

  if (!username) fail("set ADMIN_USERNAME");
  if (!/^[A-Za-z0-9._-]{3,20}$/.test(username)) {
    fail("ADMIN_USERNAME must be 3–20 characters: letters, digits, dot, dash or underscore");
  }
  if (!password) fail("set ADMIN_PASSWORD");
  // The one account that can do everything, on a public URL: refuse a weak one.
  if (password.length < 12 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) {
    fail("ADMIN_PASSWORD must be at least 12 characters and contain a letter and a number");
  }

  const existing = await prisma.user.findUnique({ where: { username }, select: { id: true, role: true } });

  if (existing) {
    if (!RESET) {
      console.log(`create-admin: "${username}" already exists — nothing changed (pass --reset to set its password).`);
      return;
    }
    if (existing.role !== "ADMIN") {
      fail(`"${username}" exists but is ${existing.role}, not ADMIN — refusing to reset it. Use another username.`);
    }
    const passwordHash = await bcryptjs.hash(password, 12);
    await prisma.user.update({
      where: { id: existing.id },
      data: { passwordHash, isActive: true, tokenVersion: { increment: 1 } },
    });
    console.log(`create-admin: password of admin "${username}" reset; its other sessions are signed out.`);
    return;
  }

  const passwordHash = await bcryptjs.hash(password, 12);
  await prisma.user.create({ data: { username, name: "Admin", passwordHash, role: "ADMIN" } });
  console.log(`create-admin: admin "${username}" created. Sign in, then remove ADMIN_PASSWORD from the environment.`);
};

main()
  .then(() => prisma.$disconnect())
  .catch(async (err) => {
    console.error("create-admin failed:", err.message);
    await prisma.$disconnect();
    process.exit(1);
  });
