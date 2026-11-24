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
import javax.swing.JComponent
import javax.swing.SwingConstants
import javax.swing.Timer

/**
 * Fenêtre d'outils « Cairn » : lance la vue universelle de Cairn (web/serve.js, Node.js) pour le projet ouvert,
 * sur 127.0.0.1 uniquement, et l'affiche dans le navigateur intégré de l'IDE. Le serveur s'arrête avec la fenêtre.
 * Emplacement de Cairn : variable CAIRN_HOME, sinon ~/.claude/plugins/local/cairn.
 */
class CairnToolWindowFactory : ToolWindowFactory, DumbAware {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val contenu = ContentFactory.getInstance().createContent(vue(project, toolWindow.disposable), "", false)
        toolWindow.contentManager.addContent(contenu)
    }

    private fun vue(project: Project, parent: Disposable): JComponent {
        val racine = System.getenv("CAIRN_HOME") ?: "${System.getProperty("user.home")}/.claude/plugins/local/cairn"
        val serveur = File(racine, "web/serve.js")
        val dossier = project.basePath ?: return message("Ouvrez un projet pour voir sa roadmap.")
        if (!serveur.isFile) return message("Cairn introuvable : ${serveur.path}")
        val node = PathEnvironmentVariableUtil.findInPath("node")
            ?: listOf("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node").map(::File).firstOrNull { it.canExecute() }
            ?: return message("Node.js introuvable : installez-le pour afficher la roadmap.")

        // Un port par projet, pour que plusieurs projets ouverts aient chacun leur roadmap.
        val port = 4823 + Math.floorMod(dossier.hashCode(), 500)
        val adresse = "http://127.0.0.1:$port"
        val processus = ProcessBuilder(node.path, serveur.path, dossier, "--port", port.toString())
            .redirectErrorStream(true)
            .redirectOutput(ProcessBuilder.Redirect.DISCARD)
            .start()
        Disposer.register(parent, Disposable { processus.destroy() })

        if (!JBCefApp.isSupported()) {
            Timer(800) { BrowserUtil.browse(adresse) }.apply { isRepeats = false; start() }
            return message("Navigateur intégré indisponible : la roadmap s'ouvre dans votre navigateur ($adresse).")
        }
        val navigateur = JBCefBrowser.createBuilder().build()
        Disposer.register(parent, navigateur)
        Timer(800) { navigateur.loadURL(adresse) }.apply { isRepeats = false; start() } // le temps que le serveur démarre
        return navigateur.component
    }

    private fun message(texte: String): JComponent = JBLabel(texte, SwingConstants.CENTER)
}
