/* Poma Pathfinder – assistant (Tekoäly tab).
 *
 * Right now this is a RULE-BASED navigation helper: it answers from the app's live state
 * (position, accuracy, sources, waypoints). It is NOT a language model and says so in the UI.
 *
 * A local multimodal model (images + speech) can be plugged in later with PomaAI.useBackend():
 *   PomaAI.useBackend({ name: "Gemma 3n", ask: async ({text, image, audio}, ctx) => "answer" })
 * When a backend is present it receives the same context object and is used for every question.
 */
(function (root) {
  "use strict";

  let backend = null;

  const fmtDist = m => m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + " km" : Math.round(m) + " m";
  const fmtAcc = m => "±" + fmtDist(m);
  const has = (q, re) => re.test(q);

  function turnText(turn) {
    const a = Math.abs(Math.round(turn));
    if (a <= 15) return "suoraan eteenpäin";
    if (a >= 165) return "käänny ympäri";
    return "käänny " + (turn > 0 ? "oikealle" : "vasemmalle") + " noin " + a + "°";
  }

  function whereAmI(c) {
    if (!c.pos) return "En tiedä vielä sijaintiasi. Paina Navigoi-välilehdellä \"Paikanna\" tai napauta karttaa lähtöpisteeksi.";
    let t = "Arvioitu sijaintisi on " + c.pos.lat.toFixed(5) + ", " + c.pos.lon.toFixed(5) + " (" + fmtAcc(c.sigma) + ", lähde: " + c.src + ").";
    if (c.sigma > 500) t += " Tarkkuus on heikko, joten oikea paikka voi olla kaukanakin tästä.";
    else if (c.sigma > 60) t += " Tarkkuus on kymmeniä metrejä: riittää suuntaa-antavaan navigointiin.";
    else t += " Tarkkuus on hyvä.";
    return t;
  }

  function accuracyWhy(c) {
    if (!c.pos) return "Sijaintia ei ole vielä, joten tarkkuuttakaan ei voi arvioida.";
    const why = [];
    if (/mobiiliasema/i.test(c.src) && !/wi-fi/i.test(c.src)) why.push("sijainti perustuu pelkkään mobiiliasemaan, joka antaa vain satojen metrien tai kilometrien tarkkuuden");
    if (c.scan && c.scan.wifi < 2 && c.methods.wifi) why.push("Wi-Fi-tukiasemia näkyy alle kaksi, eikä tietokantaan voi hakea niillä");
    if (c.scan && c.scan.throttled) why.push("Android rajoittaa Wi-Fi-skannauksia (noin 4 / 2 min), joten tiedot voivat olla vanhoja");
    if (c.steps > 30 && c.sigma > 20) why.push("askelseuranta kerryttää virhettä noin 0,5 m jokaista askelta kohden, kunnes saat uuden tarkan pisteen");
    if (c.message && /ei tietoa|404/i.test(c.message)) why.push("BeaconDB ei tunne aluetta (" + c.message + ")");
    return "Tarkkuus on " + fmtAcc(c.sigma) + (why.length ? ", koska " + why.join("; ") + "." : ". Mitään yksittäistä ongelmaa ei näy.");
  }

  function improve(c) {
    const tips = [];
    if (!c.methods.wifi) tips.push("Kytke Wi-Fi päälle Asetuksissa. Se on tärkein lähde sisällä ja kaupungissa.");
    if (!c.methods.cells) tips.push("Kytke mobiiliasemat päälle: ne antavat karkean sijainnin silloinkin, kun Wi-Fi-tukiasemia ei näy.");
    if (!c.methods.online) tips.push("Kytke Verkkotietokanta päälle, jos sinulla on netti: ilman sitä sijainti löytyy vain opituista paikoista.");
    if (c.pos && c.sigma > 30) tips.push("Napauta karttaa täsmälleen siihen kohtaan, jossa seisot, ja paina \"Aseta sijainnikseni\". Sen jälkeen paina \"Opi paikka\" Asetuksissa, niin tämä paikka tunnistetaan jatkossa ilman nettiä.");
    if (c.methods.gps === false) tips.push("Jos taivas näkyy, GPS-kytkin antaa heti 3–10 metrin tarkkuuden.");
    tips.push("Liiku ja paina Paikanna uudelleen 30 sekunnin välein: uudet Wi-Fi-havainnot tarkentavat arviota.");
    return "Näin parannat tarkkuutta:\n• " + tips.join("\n• ");
  }

  function direction(c, q) {
    if (!c.pos) return "Tarvitsen ensin sijaintisi, ennen kuin voin laskea suunnan.";
    const wps = c.waypoints || [];
    if (!wps.length) return "Sinulla ei ole reittipisteitä. Lisää niitä Kartta-välilehdellä napauttamalla karttaa tai Navigoi-välilehden \"Tallenna piste tähän\" -napilla.";
    let wp = wps.find(w => q.includes(w.name.toLowerCase())) || (c.target && wps.find(w => w.id === c.target)) || (wps.length === 1 ? wps[0] : null);
    if (!wp) return "Mihin pisteeseen? Valitse: " + wps.map(w => w.name).join(", ") + ".";
    if (wp.dist < 10) return "Olet perillä pisteessä " + wp.name + " (arviolta " + fmtDist(wp.dist) + " päässä).";
    let t = wp.name + ": " + fmtDist(wp.dist) + ", suunta " + Math.round(wp.bearing) + "° " + wp.cardinal + ".";
    if (c.heading != null) t += " Pidä puhelinta edessäsi: " + turnText(wp.turn) + ".";
    else t += " Kompassi ei anna suuntaa. Varmista, että Askeleet ja kompassi on päällä Asetuksissa ja pidä puhelinta kädessä.";
    if (c.sigma > wp.dist) t += " Huomaa: sijaintisi tarkkuus (" + fmtAcc(c.sigma) + ") on huonompi kuin matka pisteeseen, joten suunta on vain arvio.";
    return t;
  }

  function steps(c) {
    return c.steps ? "Olet ottanut " + c.steps + " askelta, noin " + fmtDist(c.meters) + " (askelpituus " + c.stepLen.toFixed(2).replace(".", ",") + " m, voit säätää pituuttasi Asetuksissa)." : "Askelia ei ole vielä laskettu. Käynnistä Navigoi-välilehdellä Seuranta ja kävele pidellen puhelinta kädessä.";
  }

  function methods(c) {
    const names = { gps: "GPS", wifi: "Wi-Fi", cells: "Mobiiliasemat", ble: "Bluetooth", online: "Verkkotietokanta", learned: "Opitut paikat", pdr: "Askeleet ja kompassi" };
    return "Päällä: " + (Object.keys(names).filter(k => c.methods[k]).map(k => names[k]).join(", ") || "ei mitään") + ".\nPois: " +
      (Object.keys(names).filter(k => !c.methods[k]).map(k => names[k]).join(", ") || "ei mitään") + ".";
  }

  function diagnose(c) {
    const out = [];
    if (c.problems && c.problems.length) out.push(...c.problems);
    if (c.message) out.push("Viimeisin haku: " + c.message);
    return out.length ? out.join("\n") : "En näe ongelmaa. Jos jokin ei toimi, avaa Asetukset → Loki ja kopioi loki.";
  }

  const HELP = "Osaan kertoa: missä olet, miksi tarkkuus on mikä on, miten parannat sitä, mihin suuntaan reittipisteet ovat, paljonko olet kävellyt ja mitkä menetelmät ovat päällä. Kysy esimerkiksi \"missä olen?\" tai \"miten parannan tarkkuutta?\".";

  function rules(q, c) {
    const s = q.toLowerCase();
    if (has(s, /paranna|tarkemm|parempi|tarkenna/)) return improve(c);
    if (has(s, /tarkk|epätarkk|virhe|±|miksi/) && !has(s, /ei toimi/)) return accuracyWhy(c);
    if (has(s, /ei toimi|ongelma|vika|loki|virhe/)) return diagnose(c);
    if (has(s, /suunta|mihin|reittipiste|perille|opasta|kohde|kuinka kaukana|matka .*piste/)) return direction(c, s);
    if (has(s, /askel|kuljet|kävel|matka/)) return steps(c);
    if (has(s, /menetelm|lähde|kytkin|gps|wifi|wi-fi|asema|bluetooth|käytät/)) return methods(c);
    if (has(s, /missä|sijainti|koordinaat|paikka/)) return whereAmI(c);
    if (has(s, /apua|mitä osaat|ohje|auta/)) return HELP;
    return "En ymmärtänyt kysymystä. " + HELP;
  }

  async function ask(input, ctx) {
    const text = String((input && input.text) || "").trim();
    const hasMedia = !!(input && (input.image || input.audio));
    if (backend) {
      try { return { text: await backend.ask({ text, image: input.image, audio: input.audio }, ctx), mode: "model" }; }
      catch (e) { return { text: "Mallin ajo epäonnistui: " + (e && e.message || e), mode: "error" }; }
    }
    if (hasMedia && !text) return { text: "En voi vielä katsoa kuvia tai kuunnella puhetta: paikallista tekoälymallia ei ole asennettu. Kirjoita kysymys.", mode: "rules" };
    return { text: rules(text, ctx), mode: "rules" };
  }


  /* ---------------------------------------------------------------- native model bridge (Android) */
  let nativePlugin;
  function plugin() {
    if (nativePlugin !== undefined) return nativePlugin;
    nativePlugin = null;
    try {
      const C = root.Capacitor;
      if (C && C.isNativePlatform && C.isNativePlatform()) nativePlugin = (C.Plugins && C.Plugins.PomaAI) || (C.registerPlugin && C.registerPlugin("PomaAI")) || null;
    } catch (e) { nativePlugin = null; }
    return nativePlugin;
  }

  const SYSTEM = "Olet Poma Pathfinder -sovelluksen navigointiapuri. Vastaa aina suomeksi, lyhyesti (enintään 3–4 lausetta) ja selkeästi. " +
    "Käytä vain sovelluksen antamia tietoja sijainnista, tarkkuudesta ja reittipisteistä. Älä keksi koordinaatteja, katuja tai paikannimiä. " +
    "Jos sijainnin tarkkuus on huono, sano se. Kuvasta kerro vain se, mikä siinä näkyy ja auttaa suunnistamaan (maamerkit, kyltit, suunta); " +
    "älä väitä tietäväsi tarkkaa sijaintia pelkästä kuvasta. Hätätilanteessa neuvo soittamaan 112.";

  function stateText(c) {
    if (!c) return "";
    const l = [];
    if (c.pos) l.push("Sijainti: " + c.pos.lat.toFixed(5) + ", " + c.pos.lon.toFixed(5) + ", tarkkuus " + fmtAcc(c.sigma) + ", lähde: " + c.src + ".");
    else l.push("Sijaintia ei vielä tiedossa.");
    if (c.heading != null) l.push("Puhelimen suunta: " + Math.round(c.heading) + " astetta.");
    if (c.steps) l.push("Askelia: " + c.steps + " (" + fmtDist(c.meters) + ").");
    const wps = (c.waypoints || []).filter(w => w.dist != null);
    if (wps.length) l.push("Reittipisteet: " + wps.map(w => w.name + " " + fmtDist(w.dist) + ", suunta " + Math.round(w.bearing) + "° " + w.cardinal + (c.heading != null ? " (" + turnText(w.turn) + ")" : "")).join("; ") + ".");
    if (c.target) { const t = (c.waypoints || []).find(w => w.id === c.target); if (t) l.push("Aktiivinen kohde: " + t.name + "."); }
    return l.join("\n");
  }

  const native = {
    available: () => !!plugin(),
    async status() {
      const p = plugin(); if (!p) return null;
      try { return await p.status(); } catch (e) { return null; } // plugin missing from this build
    },
    pick: () => plugin().pickModel(),
    load: gpu => plugin().load({ gpu: !!gpu }),
    unload: () => plugin().unload(),
    remove: () => plugin().removeModel(),
    onProgress(fn) { const p = plugin(); return p && p.addListener ? p.addListener("copyProgress", fn) : null; },
    attach(name) {
      backend = {
        name: name || "Gemma 3n (paikallinen)",
        ask: async (input, ctx) => {
          const prompt = (stateText(ctx) ? "Sovelluksen tila:\n" + stateText(ctx) + "\n\n" : "") +
            (input.audio ? "Käyttäjä puhui kysymyksen (äänitiedosto). Vastaa siihen." + (input.text ? " Lisäksi hän kirjoitti: " + input.text : "")
              : "Kysymys: " + (input.text || "Kuvaile kuvaa navigoinnin kannalta."));
          const r = await plugin().ask({ text: prompt, system: SYSTEM, image: input.image ? String(input.image).replace(/^data:[^,]*,/, "") : undefined, audio: input.audio || undefined });
          return String(r.text || "").trim() || "(tyhjä vastaus)";
        }
      };
    },
    detach() { backend = null; }
  };

  /* ---------------------------------------------------------------- audio: 16 kHz mono 16-bit WAV (base64) */
  function resampleTo16k(samples, rate) {
    if (rate === 16000) return samples;
    const ratio = rate / 16000, n = Math.floor(samples.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {   // box filter average avoids aliasing when downsampling
      const a = Math.floor(i * ratio), b = Math.min(samples.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
      let s = 0; for (let j = a; j < b; j++) s += samples[j];
      out[i] = s / (b - a);
    }
    return out;
  }
  function wavBytes(samples16k) {
    const n = samples16k.length, buf = new ArrayBuffer(44 + n * 2), v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, "RIFF"); v.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt "); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, "data"); v.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, samples16k[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Uint8Array(buf);
  }
  function toBase64(bytes) {
    let s = ""; const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return (typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64"));
  }
  const wavBase64 = (samples, rate) => toBase64(wavBytes(resampleTo16k(samples, rate)));

  /** Records from the microphone until stop() is called (max 30 s). Resolves to base64 WAV. */
  function createRecorder() {
    let ctx, stream, node, src, chunks = [], rate = 48000, done, timer;
    return {
      async start() {
        if (!(root.navigator && navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) throw new Error("Mikrofoni ei ole käytettävissä");
        stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
        const AC = root.AudioContext || root.webkitAudioContext; ctx = new AC(); rate = ctx.sampleRate;
        src = ctx.createMediaStreamSource(stream); node = ctx.createScriptProcessor(4096, 1, 1);
        node.onaudioprocess = e => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
        src.connect(node); node.connect(ctx.destination);
        done = new Promise(res => { this._finish = res; });
        timer = setTimeout(() => this.stop(), 30000);
      },
      async stop() {
        clearTimeout(timer);
        try { node.disconnect(); src.disconnect(); } catch (e) { /* ignore */ }
        try { stream.getTracks().forEach(t => t.stop()); } catch (e) { /* ignore */ }
        try { await ctx.close(); } catch (e) { /* ignore */ }
        let len = 0; chunks.forEach(c => { len += c.length; });
        const all = new Float32Array(len); let o = 0; chunks.forEach(c => { all.set(c, o); o += c.length; });
        if (this._finish) this._finish();
        if (len < rate * 0.4) throw new Error("Ääni oli liian lyhyt");
        return wavBase64(all, rate);
      }
    };
  }

  root.PomaAI = {
    ask,
    useBackend(b) { backend = b || null; },
    info() { return backend ? { mode: "model", name: backend.name || "malli" } : { mode: "rules", name: "Sääntöpohjainen apuri" }; },
    native,
    createRecorder,
    // exposed for tests
    _rules: rules, _wav: wavBase64, _state: stateText, _resample: resampleTo16k
  };
})(typeof window !== "undefined" ? window : globalThis);
