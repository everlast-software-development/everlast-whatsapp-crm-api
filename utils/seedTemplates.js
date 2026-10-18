require("../config/env");
const prisma = require("../config/prisma");

const seed = async () => {
  // Remove all TEST templates
  const deleted = await prisma.template.deleteMany({
    where: { name: { startsWith: "[TEST]" } },
  });
  console.log(`Deleted ${deleted.count} test templates`);

  // Add hello_world
  const existing = await prisma.template.findFirst({
    where: { metaTemplateName: "hello_world" },
  });

  if (existing) {
    console.log("hello_world already exists — skipped");
  } else {
    await prisma.template.create({
      data: {
        name: "Hello World",
        category: "RE_ENGAGEMENT",
        language: "en_US",
        body: "Hello! This is a test re-engagement message from Everlast Wellness.",
        approvalStatus: "APPROVED",
        metaTemplateName: "hello_world",
        metaTemplateId: "hello_world",
      },
    });
    console.log("Created: Hello World");
  }

  await prisma.$disconnect();
};

seed().catch((e) => {
  console.error(require("./safeError")(e));
  prisma.$disconnect();
  process.exit(1);
});
