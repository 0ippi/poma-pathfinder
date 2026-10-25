// Runs after "npx cap add android": installs the plugin, registers it and adds permissions.
const fs = require("fs"), path = require("path");
const dir = path.join("android", "app", "src", "main", "java", "fi", "poma", "pathfinder");
fs.mkdirSync(dir, { recursive: true });
// Optional on-device AI: only built when PomaAiPlugin.kt is in the repository root.
// If the build ever fails because of it, delete PomaAiPlugin.kt from the repo and the app builds without AI.
const AI = fs.existsSync("PomaAiPlugin.kt");
fs.copyFileSync("PomaSensorsPlugin.java", path.join(dir, "PomaSensorsPlugin.java"));
fs.writeFileSync(path.join(dir, "MainActivity.java"), `package fi.poma.pathfinder;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PomaSensorsPlugin.class);
${AI ? "        registerPlugin(PomaAiPlugin.class);\n" : ""}        super.onCreate(savedInstanceState);
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

if (AI) {
  fs.copyFileSync("PomaAiPlugin.kt", path.join(dir, "PomaAiPlugin.kt"));
  const edit = (file, fn) => { const t = fs.readFileSync(file, "utf8"); const n = fn(t); if (n === t) throw new Error("AI-asetus ei muuttanut tiedostoa: " + file); fs.writeFileSync(file, n); };
  // Kotlin Gradle plugin (the AI library is written in Kotlin and needs a recent compiler)
  edit(path.join("android", "build.gradle"), t => t.replace("classpath 'com.android.tools.build:gradle:8.7.2'", "classpath 'com.android.tools.build:gradle:8.7.2'\n        classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.21'"));
  // LiteRT-LM needs minSdk 24
  edit(path.join("android", "variables.gradle"), t => t.replace("minSdkVersion = 23", "minSdkVersion = 24"));
  edit(path.join("android", "app", "build.gradle"), t => t
    .replace("apply plugin: 'com.android.application'", "apply plugin: 'com.android.application'\napply plugin: 'org.jetbrains.kotlin.android'")
    .replace("dependencies {\n", "kotlin {\n    compilerOptions {\n        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_21\n    }\n}\n\ndependencies {\n    implementation 'com.google.ai.edge.litertlm:litertlm-android:0.18.0'\n    implementation \"androidx.activity:activity:$androidxActivityVersion\"\n"));
  // GPU libraries for the vision encoder
  edit(mf, t => t.replace("</application>", '    <uses-native-library android:name="libvndksupport.so" android:required="false" />\n        <uses-native-library android:name="libOpenCL.so" android:required="false" />\n    </application>'));
  console.log("AI-moduuli mukana (PomaAiPlugin.kt)");
} else console.log("AI-moduulia ei mukana (PomaAiPlugin.kt puuttuu)");
console.log("Android project prepared");
