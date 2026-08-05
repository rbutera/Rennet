const { app } = require("electron");

app.whenReady().then(() => {
  try {
    const sqlite = require("node:sqlite");
    const db = new sqlite.DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (value TEXT NOT NULL)");
    db.prepare("INSERT INTO probe (value) VALUES (?)").run("rennet");
    const row = db.prepare("SELECT value FROM probe").get();
    db.close();

    if (row.value !== "rennet") {
      throw new Error(`unexpected round-trip value: ${row.value}`);
    }

    console.log(JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      nodeSqlite: true,
      roundTrip: true,
    }));
    app.exit(0);
  } catch (error) {
    console.error(JSON.stringify({
      electron: process.versions.electron,
      node: process.versions.node,
      nodeSqlite: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    app.exit(1);
  }
});
