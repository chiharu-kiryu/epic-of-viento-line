package io.viento.studio

import android.app.Activity
import android.content.Intent
import android.provider.DocumentsContract
import androidx.activity.result.ActivityResult
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File
import java.io.InputStream
import java.io.OutputStream
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

@InvokeArg
class ArchiveTransferArgs {
    lateinit var path: String
    var name: String = "Viento.viento.zip"
}

/** User-selected content URIs stay native; no broad storage permission is used. */
@TauriPlugin
class ArchiveTransferPlugin(private val activity: Activity) : Plugin(activity) {
    private val busy = AtomicBoolean(false)
    private val maxImportBytes = 1024L * 1024 * 1024
    private class TransferFailure(val code: String) : Exception(code)

    private fun archive(invoke: Invoke): File {
        val file = File(invoke.parseArgs(ArchiveTransferArgs::class.java).path).canonicalFile
        val root = File(activity.cacheDir, "viento-transfer").canonicalFile
        require(file.name == "archive.zip" && file.parentFile?.parentFile == root && file.parentFile?.isDirectory == true)
        return file
    }

    private fun finish(invoke: Invoke, error: String? = null, cancelled: Boolean = false) {
        busy.set(false)
        val result = JSObject().put("cancelled", cancelled)
        if (error != null) result.put("error", error)
        invoke.resolve(result)
    }

    private fun choose(invoke: Invoke, exporting: Boolean) {
        if (!busy.compareAndSet(false, true)) {
            invoke.resolve(JSObject().put("error", "busy"))
            return
        }
        try {
            val file = archive(invoke)
            require(if (exporting) file.isFile else !file.exists())
            val intent = Intent(if (exporting) Intent.ACTION_CREATE_DOCUMENT else Intent.ACTION_OPEN_DOCUMENT)
            intent.addCategory(Intent.CATEGORY_OPENABLE)
            // Providers do not consistently label .viento.zip as application/zip.
            // The Rust verifier, not the MIME hint, establishes archive validity.
            intent.type = if (exporting) "application/zip" else "*/*"
            if (exporting) intent.putExtra(Intent.EXTRA_TITLE, invoke.parseArgs(ArchiveTransferArgs::class.java).name)
            startActivityForResult(invoke, intent, if (exporting) "exportResult" else "importResult")
        } catch (_: Exception) { finish(invoke, "picker") }
    }

    @Command fun importArchive(invoke: Invoke) = choose(invoke, false)
    @Command fun exportArchive(invoke: Invoke) = choose(invoke, true)

    private fun copy(input: InputStream, output: OutputStream, importing: Boolean, target: File): Long {
        val buffer = ByteArray(64 * 1024)
        var total = 0L
        var checkedAt = -32L * 1024 * 1024
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            total += count
            if (importing && total > maxImportBytes) throw TransferFailure("tooLarge")
            if (importing && total - checkedAt >= 32L * 1024 * 1024) {
                if (target.usableSpace < 32L * 1024 * 1024) throw TransferFailure("noSpace")
                checkedAt = total
            }
            output.write(buffer, 0, count)
        }
        output.flush()
        return total
    }

    private fun transfer(invoke: Invoke, result: ActivityResult, exporting: Boolean) {
        if (result.resultCode == Activity.RESULT_CANCELED) { finish(invoke, cancelled = true); return }
        val uri = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || uri == null || uri.scheme != "content") {
            finish(invoke, "picker"); return
        }
        thread(name = "viento-archive-transfer", isDaemon = true) {
            try {
                val file = archive(invoke)
                if (exporting) {
                    val expected = file.length()
                    file.inputStream().use { input ->
                        (activity.contentResolver.openOutputStream(uri, "w") ?: throw TransferFailure("write")).use { output ->
                            check(copy(input, output, false, file) == expected)
                        }
                    }
                } else {
                    check(file.createNewFile())
                    (activity.contentResolver.openInputStream(uri) ?: throw TransferFailure("read")).use { input ->
                        file.outputStream().use { output ->
                            copy(input, output, true, file)
                            output.fd.sync()
                        }
                    }
                }
                finish(invoke)
            } catch (failure: Exception) {
                // ACTION_CREATE_DOCUMENT always creates a new document. Never
                // delete the user's selected import, even when validation fails.
                if (exporting) try { DocumentsContract.deleteDocument(activity.contentResolver, uri) } catch (_: Exception) { }
                finish(invoke, (failure as? TransferFailure)?.code ?: if (exporting) "write" else "read")
            }
        }
    }

    @ActivityCallback fun importResult(invoke: Invoke, result: ActivityResult) = transfer(invoke, result, false)
    @ActivityCallback fun exportResult(invoke: Invoke, result: ActivityResult) = transfer(invoke, result, true)
}
