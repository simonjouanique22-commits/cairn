package local.cairn

import com.intellij.execution.configurations.PathEnvironmentVariableUtil
import com.intellij.ide.BrowserUtil
import com.intellij.openapi.Disposable
import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.ui.components.JBLabel
import com.intellij.ui.content.ContentFactory
import com.intellij.ui.jcef.JBCefApp
import com.intellij.ui.jcef.JBCefBrowser
import java.io.File
import java.util.Locale
import javax.swing.JComponent
import javax.swing.SwingConstants
import javax.swing.Timer

/**
 * "Cairn" tool window: starts Cairn's universal view (web/serve.js, Node.js) for the open project, on 127.0.0.1 only,
 * and shows it in the IDE's embedded browser. The server stops with the window.
 * Where Cairn lives: CAIRN_HOME variable, else ~/.claude/plugins/local/cairn.
 */
class CairnToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val content = ContentFactory.getInstance().createContent(view(project, toolWindow.disposable), "", false)
        toolWindow.contentManager.addContent(content)
    }

    private fun view(project: Project, parent: Disposable): JComponent {
        val root = System.getenv("CAIRN_HOME") ?: "${System.getProperty("user.home")}/.claude/plugins/local/cairn"
        val server = File(root, "web/serve.js")
        val folder = project.basePath ?: return message("Open a project to see its roadmap.")
        if (!server.isFile) return message("Cairn not found: ${server.path}")
        val node = PathEnvironmentVariableUtil.findInPath("node")
            ?: listOf("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node").map(::File).firstOrNull { it.canExecute() }
            ?: return message("Node.js not found: install it to show the roadmap.")

        // One port per project, so that several open projects each get their own roadmap.
        val port = 4823 + Math.floorMod(folder.hashCode(), 500)
        val address = "http://127.0.0.1:$port"
        val lang = if (Locale.getDefault().language == "fr") "fr" else "en"
        val process = ProcessBuilder(node.path, server.path, folder, "--port", port.toString(), "--lang", lang)
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start()
        Disposer.register(parent, Disposable { process.destroy() })

        if (!JBCefApp.isSupported()) {
            Timer(800) { BrowserUtil.browse(address) }.apply { isRepeats = false; start() }
            return message("Embedded browser unavailable: the roadmap opens in your browser ($address).")
        }
        val browser = JBCefBrowser.createBuilder().build()
        Disposer.register(parent, browser)
        Timer(800) { browser.loadURL(address) }.apply { isRepeats = false; start() } // give the server time to start
        return browser.component
    }

    private fun message(text: String): JComponent = JBLabel(text, SwingConstants.CENTER)
}
