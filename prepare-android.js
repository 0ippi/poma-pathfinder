// Runs after "npx cap add android": installs the plugin, registers it and adds permissions.
const fs = require("fs"), path = require("path");
const dir = path.join("android", "app", "src", "main", "java", "fi", "poma", "pathfinder");
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync("PomaSensorsPlugin.java", path.join(dir, "PomaSensorsPlugin.java"));
fs.writeFileSync(path.join(dir, "MainActivity.java"), `package fi.poma.pathfinder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PomaSensorsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`);
const mf = path.join("android", "app", "src", "main", "AndroidManifest.xml");
let xml = fs.readFileSync(mf, "utf8");
xml = xml.replace(/\s*<uses-permission android:name="android.permission.INTERNET"\s*\/>/g, "");
xml = xml.replace("<application", fs.readFileSync("manifest-permissions.xml", "utf8") + "\n    <application");
fs.writeFileSync(mf, xml);

// Extra web files: the workflow only copies index.html, script.js, wireless.js and styles.css into www/.
for (const f of ["ai.js", "logo.png"]) {
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join("www", f));
}

// Launcher icon: use icon.png for every density and drop the adaptive-icon XML so the PNG is used.
const res = path.join("android", "app", "src", "main", "res");
if (fs.existsSync("icon.png") && fs.existsSync(res)) {
  for (const d of fs.readdirSync(res)) {
    if (d.startsWith("mipmap-anydpi")) fs.rmSync(path.join(res, d), { recursive: true, force: true });
  }
  for (const d of fs.readdirSync(res)) {
    if (!/^mipmap-(m|h|xh|xxh|xxxh)dpi$/.test(d)) continue;
    for (const n of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
      fs.copyFileSync("icon.png", path.join(res, d, n));
    }
  }
}
console.log("Android project prepared");
