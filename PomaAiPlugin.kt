package fi.poma.pathfinder

import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.StatFs
import android.provider.OpenableColumns
import android.util.Base64
import androidx.activity.result.ActivityResult
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.SamplerConfig
import java.io.File
import java.util.concurrent.Executors

/**
 * On-device language model (Gemma 3n via LiteRT-LM). Optional add-on: it is only compiled when
 * prepare-android.js finds this file in the repository root.
 *
 * The model file (.litertlm, several GB) is NOT part of the APK. The user picks it with the system
 * file picker once; it is copied into the app's private storage.
 */
@CapacitorPlugin(name = "PomaAI")
class PomaAiPlugin : Plugin() {

    // One thread owns the engine: loading, asking and closing never overlap.
    private val executor = Executors.newSingleThreadExecutor()
    private var engine: Engine? = null
    private var hasVision = false
    private var hasAudio = false

    private fun modelFile(): File = File(context.filesDir, "model.litertlm")

    private fun err(e: Throwable): String {
        val m = e.message
        return e.javaClass.simpleName + (if (m.isNullOrBlank()) "" else ": $m")
    }

    @PluginMethod
    fun status(call: PluginCall) {
        val f = modelFile()
        val am = context.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val r = JSObject()
        r.put("engine", true)
        r.put("sdk", Build.VERSION.SDK_INT)
        r.put("modelExists", f.exists())
        r.put("modelMb", if (f.exists()) f.length() / 1048576L else 0L)
        r.put("loaded", engine != null)
        r.put("vision", hasVision)
        r.put("audio", hasAudio)
        r.put("totalRamMb", mi.totalMem / 1048576L)
        r.put("freeDiskMb", StatFs(context.filesDir.path).availableBytes / 1048576L)
        call.resolve(r)
    }

    /** Opens the system file picker; the chosen .litertlm file is copied to private storage. */
    @PluginMethod
    fun pickModel(call: PluginCall) {
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT)
        intent.addCategory(Intent.CATEGORY_OPENABLE)
        intent.type = "*/*"
        startActivityForResult(call, intent, "pickModelResult")
    }

    @ActivityCallback
    private fun pickModelResult(call: PluginCall?, result: ActivityResult) {
        if (call == null) return
        val uri = result.data?.data
        if (uri == null) {
            call.reject("Tiedostoa ei valittu")
            return
        }
        executor.execute {
            val tmp = File(context.filesDir, "model.tmp")
            try {
                var name = "malli"
                var size = -1L
                context.contentResolver.query(uri, null, null, null, null)?.use { c ->
                    if (c.moveToFirst()) {
                        val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                        val si = c.getColumnIndex(OpenableColumns.SIZE)
                        if (ni >= 0) name = c.getString(ni) ?: name
                        if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                    }
                }
                if (!name.endsWith(".litertlm", ignoreCase = true)) {
                    call.reject("Tiedosto \"$name\" ei ole .litertlm-malli. Lataa tiedosto gemma-3n-E2B-it-int4.litertlm.")
                    return@execute
                }
                val free = StatFs(context.filesDir.path).availableBytes
                if (size > 0 && size + 300L * 1048576L > free) {
                    call.reject("Tallennustila ei riitä: mallin koko " + size / 1048576L + " Mt, vapaata " + free / 1048576L + " Mt")
                    return@execute
                }
                closeEngine()
                var copied = 0L
                var lastNotify = 0L
                context.contentResolver.openInputStream(uri)?.use { input ->
                    tmp.outputStream().use { out ->
                        val buf = ByteArray(1 shl 20)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            out.write(buf, 0, n)
                            copied += n
                            val now = System.currentTimeMillis()
                            if (now - lastNotify > 700) {
                                lastNotify = now
                                val p = JSObject()
                                p.put("mb", copied / 1048576L)
                                p.put("totalMb", if (size > 0) size / 1048576L else 0L)
                                notifyListeners("copyProgress", p)
                            }
                        }
                    }
                } ?: throw IllegalStateException("Tiedostoa ei voitu avata")
                if (copied < 100L * 1048576L) {
                    tmp.delete()
                    call.reject("Tiedosto on liian pieni (" + copied / 1048576L + " Mt), lataus on voinut jäädä kesken")
                    return@execute
                }
                val dst = modelFile()
                if (dst.exists()) dst.delete()
                if (!tmp.renameTo(dst)) throw IllegalStateException("Tiedoston siirto epäonnistui")
                val r = JSObject()
                r.put("name", name)
                r.put("mb", copied / 1048576L)
                call.resolve(r)
            } catch (t: Throwable) {
                tmp.delete()
                call.reject("Mallin kopiointi epäonnistui: " + err(t))
            }
        }
    }

    private fun closeEngine() {
        try {
            engine?.close()
        } catch (t: Throwable) {
            // ignore
        }
        engine = null
        hasVision = false
        hasAudio = false
    }

    /**
     * Loads the model into memory (takes several seconds). Tries image+audio first, then falls back to
     * audio only and finally to text only, so a phone without GPU support still gets a working model.
     */
    @PluginMethod
    fun load(call: PluginCall) {
        val gpu = call.getBoolean("gpu", false) == true
        executor.execute {
            val f = modelFile()
            if (!f.exists()) {
                call.reject("Mallitiedostoa ei ole. Valitse se ensin.")
                return@execute
            }
            closeEngine()
            val path = f.absolutePath
            val cache = context.cacheDir.path
            val main: () -> Backend = { if (gpu) Backend.GPU() else Backend.CPU() }
            val attempts = listOf("kuva+ääni", "ääni", "teksti")
            val errors = ArrayList<String>()
            for (mode in attempts) {
                try {
                    val cfg = when (mode) {
                        "kuva+ääni" -> EngineConfig(
                            modelPath = path,
                            backend = main(),
                            visionBackend = Backend.GPU(),
                            audioBackend = Backend.CPU(),
                            cacheDir = cache
                        )
                        "ääni" -> EngineConfig(
                            modelPath = path,
                            backend = main(),
                            audioBackend = Backend.CPU(),
                            cacheDir = cache
                        )
                        else -> EngineConfig(modelPath = path, backend = main(), cacheDir = cache)
                    }
                    val e = Engine(cfg)
                    e.initialize()
                    engine = e
                    hasVision = mode == "kuva+ääni"
                    hasAudio = mode != "teksti"
                    val r = JSObject()
                    r.put("mode", mode)
                    r.put("vision", hasVision)
                    r.put("audio", hasAudio)
                    r.put("warnings", errors.joinToString(" | "))
                    call.resolve(r)
                    return@execute
                } catch (t: Throwable) {
                    errors.add(mode + ": " + err(t))
                }
            }
            call.reject("Mallin lataus epäonnistui. " + errors.joinToString(" | "))
        }
    }

    @PluginMethod
    fun unload(call: PluginCall) {
        executor.execute {
            closeEngine()
            call.resolve()
        }
    }

    @PluginMethod
    fun removeModel(call: PluginCall) {
        executor.execute {
            closeEngine()
            val f = modelFile()
            if (f.exists()) f.delete()
            call.resolve()
        }
    }

    /**
     * Asks the model. text = prompt (the JS side adds the app state), image = JPEG as base64,
     * audio = 16 kHz mono 16-bit WAV as base64. Every question starts a fresh conversation.
     */
    @PluginMethod
    fun ask(call: PluginCall) {
        val prompt = call.getString("text") ?: ""
        val system = call.getString("system") ?: ""
        val imageB64 = call.getString("image")
        val audioB64 = call.getString("audio")
        executor.execute {
            val e = engine
            if (e == null) {
                call.reject("Mallia ei ole ladattu muistiin")
                return@execute
            }
            val imgFile = File(context.cacheDir, "poma_ai_image.jpg")
            try {
                val image: String? = if (!imageB64.isNullOrEmpty()) {
                    if (!hasVision) {
                        call.reject("Tämä puhelin ei pysty käsittelemään kuvia mallilla (kuvakäsittely ei käynnistynyt)")
                        return@execute
                    }
                    imgFile.writeBytes(Base64.decode(imageB64, Base64.DEFAULT))
                    imgFile.absolutePath
                } else null
                val audio: ByteArray? = if (!audioB64.isNullOrEmpty()) {
                    if (!hasAudio) {
                        call.reject("Tämä puhelin ei pysty käsittelemään puhetta mallilla")
                        return@execute
                    }
                    Base64.decode(audioB64, Base64.DEFAULT)
                } else null
                val cfg = ConversationConfig(
                    systemInstruction = Contents.of(system),
                    samplerConfig = SamplerConfig(topK = 40, topP = 0.95, temperature = 0.4)
                )
                val started = System.currentTimeMillis()
                val text = e.createConversation(cfg).use { conv ->
                    val reply = if (image != null && audio != null) {
                        conv.sendMessage(Contents.of(Content.ImageFile(image), Content.AudioBytes(audio), Content.Text(prompt)))
                    } else if (image != null) {
                        conv.sendMessage(Contents.of(Content.ImageFile(image), Content.Text(prompt)))
                    } else if (audio != null) {
                        conv.sendMessage(Contents.of(Content.AudioBytes(audio), Content.Text(prompt)))
                    } else {
                        conv.sendMessage(prompt)
                    }
                    reply.toString()
                }
                val r = JSObject()
                r.put("text", text)
                r.put("ms", System.currentTimeMillis() - started)
                call.resolve(r)
            } catch (t: Throwable) {
                call.reject("Mallin ajo epäonnistui: " + err(t))
            } finally {
                imgFile.delete()
            }
        }
    }

    override fun handleOnDestroy() {
        closeEngine()
        super.handleOnDestroy()
    }
}
