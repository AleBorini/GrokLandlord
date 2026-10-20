import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(import.meta.dirname, "migrations"));
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            REMINDERS_LIVE: "true",
            RESEND_API_KEY: "re_test_dummy",
            RESEND_API_URL: "https://resend.mock/emails",
            PUBLIC_URL: "https://reminders.test",
            FROM_EMAIL: "Reminders <reminders@example.test>",
            SEND_DELAY_MS: "0",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.js"] },
  };
});
