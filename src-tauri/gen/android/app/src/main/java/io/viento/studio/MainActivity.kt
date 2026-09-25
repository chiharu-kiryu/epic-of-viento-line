package io.viento.studio

import android.os.Bundle
import android.graphics.Color
import android.view.View
import androidx.activity.enableEdgeToEdge
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.rgb(11, 21, 35))
    WindowCompat.getInsetsController(window, window.decorView).apply {
      isAppearanceLightStatusBars = false
      isAppearanceLightNavigationBars = false
    }
    // Resize the native container too: older WebViews do not expose keyboard
    // or system-bar insets to CSS, leaving focused fields under the keyboard.
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, windowInsets ->
      val types = WindowInsetsCompat.Type.systemBars() or
        WindowInsetsCompat.Type.displayCutout() or WindowInsetsCompat.Type.ime()
      val insets = windowInsets.getInsets(types)
      view.setPadding(insets.left, insets.top, insets.right, insets.bottom)
      // Forward zeroed insets so newer WebViews do not apply the same space
      // twice, and still receive the update when the keyboard disappears.
      WindowInsetsCompat.Builder(windowInsets).setInsets(types, Insets.NONE).build()
    }
    ViewCompat.requestApplyInsets(content)
  }
}
