// Native full-lane fixture: no windows, accounts, tools or non-disposable stores.
import { app } from "electron";
import { getAppPaths } from "../../../src/main/core/app-paths";
import { admitStorageRoot, prepareFrameworkStorage } from "../../../src/main/core/storage-admission";
const report = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
app.setName("Mumbler storage admission test");
if (!app.requestSingleInstanceLock()) {
  report({ kind: "excluded" });
  app.exit(0);
} else {
  try {
    const admission = await admitStorageRoot(getAppPaths());
    await prepareFrameworkStorage(admission, app);
    const beforeReady = !app.isReady();
    void app.whenReady().then(() => {
    report({ kind: "ready", beforeReady, firstRun: admission.firstRun, userData: app.getPath("userData"), sessionData: app.getPath("sessionData") });
    process.stdin.on("data", () => app.exit(0));
    process.stdin.resume();
    });
  } catch (error) {
    report({ kind: "failed", message: String(error) });
    app.exit(1);
  }
}
