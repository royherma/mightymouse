package com.mightymouse.android

import android.Manifest
import android.annotation.SuppressLint
import android.content.pm.PackageManager
import android.net.Uri
import android.net.http.SslError
import android.os.Build
import android.os.Bundle
import android.view.HapticFeedbackConstants
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.webkit.ScriptHandler
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.journeyapps.barcodescanner.ScanContract
import com.journeyapps.barcodescanner.ScanOptions
import org.json.JSONObject

private const val PREFS = "mightymouse"
private const val LAST_REMOTE = "lastRemoteURL"
private const val CREDENTIAL_PREFIX = "cred."
private const val BRIDGE_NAME = "MMAndroid"

class MainActivity : ComponentActivity() {
    private lateinit var home: View
    private lateinit var deck: WebView
    private lateinit var message: TextView
    private lateinit var reconnect: Button
    private val prefs by lazy { getSharedPreferences(PREFS, MODE_PRIVATE) }
    private var pendingMedia: PermissionRequest? = null
    private var bootstrap: ScriptHandler? = null
    private var deckHost: String? = null

    private val scanner = registerForActivityResult(ScanContract()) { result ->
        result.contents?.let(::handleScan)
    }

    private val mediaPermissions = registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) {
        pendingMedia?.let(::answerMedia)
        pendingMedia = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        home = findViewById(R.id.home)
        deck = findViewById(R.id.deck)
        message = findViewById(R.id.message)
        reconnect = findViewById(R.id.reconnect)

        findViewById<Button>(R.id.scan).setOnClickListener { beginScan() }
        reconnect.setOnClickListener { lastRemote()?.let(::openDeck) }

        deck.settings.javaScriptEnabled = true
        deck.settings.domStorageEnabled = true
        deck.settings.mediaPlaybackRequiresUserGesture = false
        deck.addJavascriptInterface(Bridge(), BRIDGE_NAME)
        deck.webViewClient = DeckClient()
        deck.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: PermissionRequest) {
                runOnUiThread { requestMedia(request) }
            }
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (deck.visibility == View.VISIBLE) closeDeck() else finish()
            }
        })

        if (savedInstanceState == null) lastRemote()?.let(::openDeck) else showHome()
    }

    override fun onDestroy() {
        deck.destroy()
        super.onDestroy()
    }

    private fun beginScan() {
        message.visibility = View.GONE
        scanner.launch(
            ScanOptions()
                .setDesiredBarcodeFormats(ScanOptions.QR_CODE)
                .setPrompt(getString(R.string.scan_prompt))
                .setBeepEnabled(false)
                .setOrientationLocked(false)
        )
    }

    private fun handleScan(raw: String) {
        val url = Uri.parse(raw.trim())
        if (url.scheme != "https" || url.host.isNullOrEmpty()) {
            showHome(getString(R.string.foreign_qr))
            return
        }
        prefs.edit().putString(LAST_REMOTE, url.toString()).apply()
        openDeck(url)
    }

    private fun lastRemote(): Uri? = prefs.getString(LAST_REMOTE, null)?.let(Uri::parse)

    private fun openDeck(url: Uri) {
        deckHost = url.host
        val origin = "https://${url.host}" + if (url.port != -1) ":${url.port}" else ""
        bootstrap?.remove()
        bootstrap = null
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            bootstrap = WebViewCompat.addDocumentStartJavaScript(deck, bootstrapScript(), setOf(origin))
        }
        message.visibility = View.GONE
        home.visibility = View.GONE
        deck.visibility = View.VISIBLE
        deck.loadUrl(url.toString())
    }

    private fun closeDeck() {
        deck.stopLoading()
        deck.loadUrl("about:blank")
        showHome()
    }

    private fun showHome(note: String? = null) {
        deck.visibility = View.GONE
        home.visibility = View.VISIBLE
        reconnect.visibility = if (lastRemote() != null) View.VISIBLE else View.GONE
        message.text = note
        message.visibility = if (note == null) View.GONE else View.VISIBLE
    }

    private fun bootstrapScript(): String {
        val credentials = JSONObject()
        prefs.all.forEach { (key, value) ->
            if (key.startsWith(CREDENTIAL_PREFIX) && value is String) credentials.put(key.removePrefix(CREDENTIAL_PREFIX), value)
        }
        val payload = JSONObject()
            .put("credentials", credentials)
            .put("features", org.json.JSONArray(listOf("hideDeck", "exitNotFound")))
            .put("device", JSONObject().put("model", Build.MODEL).put("osVersion", Build.VERSION.RELEASE).put("appBuild", BuildConfigVersion))
        return "window.__MM_NATIVE_BOOTSTRAP__ = $payload;" +
            "window.webkit = {messageHandlers: {mightymouse: {postMessage: function (m) { $BRIDGE_NAME.post(JSON.stringify(m)); }}}};"
    }

    private fun requestMedia(request: PermissionRequest) {
        val host = request.origin.host.orEmpty()
        if (host != deckHost && !isPrivateHost(host)) {
            request.deny()
            return
        }
        val missing = neededPermissions(request).filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            answerMedia(request)
        } else {
            pendingMedia = request
            mediaPermissions.launch(missing.toTypedArray())
        }
    }

    private fun neededPermissions(request: PermissionRequest): List<String> = request.resources.mapNotNull {
        when (it) {
            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
            else -> null
        }
    }

    private fun answerMedia(request: PermissionRequest) {
        val granted = request.resources.filter { resource ->
            val permission = when (resource) {
                PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                else -> return@filter false
            }
            ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private inner class DeckClient : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val target = request.url
            return target.scheme != "about" && target.host != deckHost
        }

        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val host = Uri.parse(error.url).host.orEmpty()
            if (isPrivateHost(host)) handler.proceed() else handler.cancel()
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (request.isForMainFrame && request.url.host == deckHost) showHome(getString(R.string.load_failed))
        }
    }

    private inner class Bridge {
        @JavascriptInterface
        fun post(json: String) {
            val body = runCatching { JSONObject(json) }.getOrNull() ?: return
            when (body.optString("t")) {
                "storeCredential" ->
                    prefs.edit().putString(CREDENTIAL_PREFIX + body.optString("key"), body.optString("value")).apply()
                "removeCredential" ->
                    prefs.edit().remove(CREDENTIAL_PREFIX + body.optString("key")).apply()
                "scanQr" -> runOnUiThread { beginScan() }
                "hideDeck" -> runOnUiThread { closeDeck() }
                "exitToPairing" -> runOnUiThread {
                    val gone = body.optString("outcome") == "notFound"
                    if (gone) prefs.edit().remove(LAST_REMOTE).apply()
                    closeDeck()
                }
                "haptic" -> runOnUiThread {
                    deck.performHapticFeedback(
                        if (body.optString("style") == "light") HapticFeedbackConstants.CLOCK_TICK else HapticFeedbackConstants.CONTEXT_CLICK
                    )
                }
            }
        }
    }
}

private const val BuildConfigVersion = "1.0.0"

private fun isPrivateHost(host: String): Boolean {
    val name = host.lowercase()
    if (name == "localhost" || name.endsWith(".local")) return true
    val parts = name.split(".").mapNotNull { it.toIntOrNull() }
    if (parts.size != 4 || name.split(".").size != 4) return false
    return when {
        parts[0] == 10 || parts[0] == 127 -> true
        parts[0] == 192 && parts[1] == 168 -> true
        parts[0] == 172 && parts[1] in 16..31 -> true
        else -> false
    }
}
