// 大白笔记的 Quick Look 预览扩展（appex）
//
// 挂在 Blanc.app/Contents/PlugIns/ 下，由 macOS 的 Quick Look
// （Finder 里选中文件按空格）加载。系统没有「默认 Quick Look 应用」的设置项，
// 它按 QLSupportedContentTypes 挑能处理该类型的扩展 —— Obsidian / Typora
// 都是这么做的（见 /Applications/Obsidian.app/Contents/PlugIns）。
//
// 预览本身是「读 md → 渲染 HTML → WKWebView 显示」：
// 不依赖主应用的 Vite 产物，也不需要 server.mjs —— Quick Look 扩展跑在
// 系统自己的宿主进程里，连不上 localhost:8787。Markdown 解析用 Foundation
// 自带的 AttributedString(markdown:)，省掉一个 markdown 依赖。
//
// 注意：appex 的 Info.plist 里 NSExtensionPrincipalClass 写的是
// "PreviewViewController"，所以类名必须用 @objc 固定住 —— Swift 类默认的
// ObjC 运行时名字是带下划线前缀的，对不上就加载不起来。

import AppKit
import QuickLookUI
import WebKit

@objc(PreviewViewController)
final class PreviewViewController: NSViewController, QLPreviewingController {
    private let web = WKWebView(frame: .zero)
    private var prepared = false

    override func loadView() {
        let box = NSView(frame: NSRect(x: 0, y: 0, width: 720, height: 860))
        web.autoresizingMask = [.width, .height]
        box.addSubview(web)
        view = box
        // Quick Look 按 preferredContentSize 给面板定尺寸
        preferredContentSize = NSSize(width: 720, height: 860)
    }

    /// 系统只调一次、主线程。读完就回调，别在这��做重活。
    func preparePreviewOfFile(at url: URL, completionHandler: @escaping (Error?) -> Void) {
        guard !prepared else { completionHandler(nil); return }
        prepared = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return completionHandler(nil) }
            self.web.loadHTMLString(PreviewRenderer.html(for: url),
                                    baseURL: url.deletingLastPathComponent())
            completionHandler(nil)
        }
    }

    // MARK: - 渲染

    private enum PreviewRenderer {
        /// 配色跟着主应用走：--ink / --muted / --line / --bg 那一套暖中性灰
        private static let css = """
        :root { color-scheme: light dark; }
        @media (prefers-color-scheme: dark) { :root {
          --ink:#e8e6e1; --muted:#9b9a97; --line:#333230; --bg:#1b1a19; --card:#262524; --code-bg:#302e2c;
        } }
        * { box-sizing: border-box; }
        html, body { margin:0; padding:0; background: var(--bg,#fbfbfa); }
        body {
          font: 15px/1.75 -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
          color: var(--ink,#37352f);
          padding: 40px 44px 64px;
          -webkit-font-smoothing: antialiased;
        }
        .wrap { max-width: 720px; margin: 0 auto; }
        .fname { font-size: 12px; color: var(--muted,#9b9a97); margin-bottom: 22px;
                 padding-bottom: 14px; border-bottom: 1px solid var(--line,#ecebe6); }
        h1,h2,h3,h4,h5,h6 { line-height:1.3; margin: 1.6em 0 .6em; font-weight: 700; }
        h1 { font-size: 30px; } h2 { font-size: 23px; } h3 { font-size: 19px; }
        h1:first-of-type, h2:first-of-type { margin-top: 0; }
        p { margin: 0 0 1em; }
        a { color: #3a7bd5; text-decoration: none; }
        code { font: 13px/1.6 ui-monospace, "SF Mono", Menlo, monospace;
               background: var(--code-bg,#f3f2ef); border-radius: 4px; padding: 2px 5px; }
        pre { background: var(--code-bg,#f3f2ef); border-radius: 8px; padding: 14px 16px;
              overflow-x: auto; margin: 0 0 1em; }
        pre code { background:none; padding:0; font-size: 12.5px; }
        blockquote { margin: 0 0 1em; padding: 2px 0 2px 16px;
                     border-left: 3px solid var(--line,#ecebe6); color: var(--muted,#6b6a65); }
        ul, ol { margin: 0 0 1em; padding-left: 1.4em; }
        li { margin: .25em 0; }
        hr { border:0; border-top:1px solid var(--line,#ecebe6); margin: 2em 0; }
        img { max-width: 100%; border-radius: 6px; }
        table { border-collapse: collapse; margin: 0 0 1em; }
        td, th { border: 1px solid var(--line,#ecebe6); padding: 6px 10px; }
        /* 转换失败时的兜底：原样当纯文本显示，别给一片空白 */
        .raw { white-space: pre-wrap; font: 13px/1.7 ui-monospace, Menlo, monospace;
               color: var(--muted,#6b6a65); }
        """

        static func html(for url: URL) -> String {
            let name = url.lastPathComponent
            let body: String
            if let text = try? String(contentsOf: url, encoding: .utf8) {
                body = convert(text) ?? "<div class=\"raw\">\(escape(text))</div>"
            } else {
                body = "<div class=\"raw\">读不到文件内容（可能不是 UTF-8）</div>"
            }
            return """
            <!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
            <style>\(css)</style></head>
            <body><div class="wrap">
            <div class="fname">\(escape(name))</div>
            \(body)
            </div></body></html>
            """
        }

        /// Foundation 自带 markdown 解析（interpretedSyntax: .full 会把
        /// 标题/列表/引用映射成段落样式），再导出成 HTML。
        /// 返回 nil 表示转换失败，交给调用方兜底。
        private static func convert(_ md: String) -> String? {
            guard let attr = try? AttributedString(
                markdown: md,
                options: AttributedString.MarkdownParsingOptions(interpretedSyntax: .full)
            ) else { return nil }
            let ns = NSAttributedString(attr)
            guard let data = try? ns.data(
                from: NSRange(location: 0, length: ns.length),
                documentAttributes: [.documentType: NSAttributedString.DocumentType.html]
            ), let html = String(data: data, encoding: .utf8) else { return nil }
            // NSAttributedString 导出的是完整 html 文档，只取 <body> 里的内容，
            // 外面套我们自己的模板（否则它那些 inline style 会把配色盖掉）
            guard let open = html.range(of: "<body"),
                  let close = html.range(of: "</body>", range: open.upperBound..<html.endIndex)
            else { return html }
            return String(html[open.upperBound..<close.lowerBound])
        }

        private static func escape(_ s: String) -> String {
            s.replacingOccurrences(of: "&", with: "&amp;")
             .replacingOccurrences(of: "<", with: "&lt;")
             .replacingOccurrences(of: ">", with: "&gt;")
        }
    }
}