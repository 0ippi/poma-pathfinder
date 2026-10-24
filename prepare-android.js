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
console.log("Android project prepared");
