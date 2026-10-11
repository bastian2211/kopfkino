// Verwaltungsbefehle, auf dem Server im API-Container ausführen:
//   docker compose exec api node dist/cli.js invite --admin   → Einladungslink (Admin)
//   docker compose exec api node dist/cli.js invite           → Einladungslink (Nutzer)
//   docker compose exec -T api node dist/cli.js vapid         → Push-Schlüssel für die .env
import webpush from "web-push";
import { createInvite, INVITE_DAYS, inviteLink } from "./auth.js";
import { loadConfig } from "./config.js";
import { createPool, migrate } from "./db.js";

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "vapid": {
      // Gibt nur .env-Zeilen aus, damit man sie direkt anhängen kann (>> .env)
      const keys = webpush.generateVAPIDKeys();
      process.stdout.write(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}\n`);
      return;
    }
    case "invite": {
      const config = loadConfig();
      const db = createPool(config.DATABASE_URL);
      try {
        await migrate(db, () => undefined);
        const role = args.includes("--admin") ? "admin" : "user";
        const { code } = await createInvite(db, { role, createdBy: null, note: "per Kommandozeile" });
        console.log(`\nEinladung (${role}), ${INVITE_DAYS} Tage gültig, nur einmal nutzbar:\n`);
        console.log(inviteLink(config.APP_URL, code));
        console.log("");
      } finally {
        await db.end();
      }
      return;
    }
    default:
      console.error("Befehle: invite [--admin] | vapid");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
