// Blanc 桌面壳库入口
// Tauri 2 约定：main.rs 只做启动，setup/context 放 lib.rs。
//
// 文件关联：bundle.fileAssociations 让系统把 .md 认到本应用名下
// （见 tauri.conf.json 的 bundle.fileAssociations）。
// 系统把「双击 / 拖进来 / open -a」的文件交给我们后：
//   · macOS/iOS → RunEvent::Opened（AppKit 的 application:openFile:）
//   · Windows/Linux → 命令行参数
// 拿到路径存进 OPENED，前端启动时用 opened_file 命令取走；
// 应用已在运行时则额外 emit 一个事件，让前端把当前文档切过去。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        /* ⚠️ single-instance **必须第一个注册**。
           作用：第二次 `open -a Blanc` 不再起新进程，而是把 argv 交给已在跑的实例。
           没有它的话第二个进程会再去 bind 8787 —— 后端全局只有一个，
           端口被占后新进程界面能开但**所有 API 全挂**（读文件、树、order 全废），
           是那种「看起来启动了、点什么都没反应」的坑。
           macOS 上双击 .md 走的是 Apple Event（RunEvent::Opened），不经 argv；
           argv 这条只覆盖终端里 `blanc foo.md` 启动的情况。 */
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            use tauri::Manager;
            // 终端里带文件启动：交给主窗口判断（见 deliver_opened_path）
            for a in argv.iter().skip(1) {
                if is_openable(a) {
                    deliver_opened_path(app, a);
                }
            }
            // 没有任何文件参数（就是再点一次图标）→ 把主窗口叫到前面，别什么都不做
            let main = app.get_webview_window("main");
            if let Some(w) = main {
                let _ = w.unminimize();
                let _ = w.show();
                let _ = w.set_focus();
            }
        }))
        // 系统目录选择器。前端「添加知识库」在 Tauri 里走这个插件，
        // 浏览器里走手输绝对路径（见 api.js 的 pickDir）。
        .plugin(tauri_plugin_dialog::init())
        /* 记住窗口大小和位置（用户 2026-10-16 提的「不想每次进来重新改窗口大小」）。
         * 主窗口和「一篇一窗口」的那些都管 —— 用户在第 3 篇里调好的尺寸，
         * 下次开第 3 篇不该再调一遍。
         *
         * 用官方插件而不是自己存：它会处理**显示器被拔掉**的情况 ——
         * 窗口上次停在第二块屏上，这次只剩一块，恢复出来的坐标就在屏幕外，
         * 用户看到的是「应用打开了但哪儿都找不到」。自己写要额外判断
         * 可见性并夹回主屏，逻辑不多但容易漏。
         *
         * 状态文件在系统的 app data 目录（不是 ~/.blanc 那个配置目录）——
         * 它属于「这台机器上这个应用的窗口习惯」，不属于用户的笔记。
         *
         * 必须**在窗口创建之前**注册：插件靠钩住窗口创建那一刻来接管尺寸，
         * 注册晚了就已经按 tauri.conf.json 的 1180×760 建好了。
         * 它只对**之后**建的窗口生效，所以 open_doc_window 不用改。 */
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            opened_file,
            set_theme_mode,
            read_file,
            read_file_meta,
            write_file,
            reveal_in_file_manager,
            set_default_markdown_app,
            open_doc_window_cmd,
            app_info,
            show_main_window
        ])
        /* 窗口关掉时把登记摘掉。不摘的话这篇文档在 WIN_FOR_DOC 里永远「已开着」，
           之后点它只会去 set_focus 一个已经不存在的 label —— 表现是
           「点了没反应」，且不会报任何错。 */
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                forget_doc_window(window.label());
            }
        })
        .setup(|app| {
            use tauri::Manager;
            // 命令行路径（Windows/Linux 双击走这里；macOS 也兜一层，
            // 比如从终端 `blanc foo.md` 启动的）
            if let Some(p) = std::env::args().nth(1) {
                if is_openable(&p) {
                    deliver_opened_path(app.handle(), &p);
                }
            }
            let _ = app.manage(Backend(Mutex::new(start_backend(app.handle()))));
            /* 主窗口是以 visible:false 建的（见 tauri.conf.json），由前端首帧绘制后
               调 show_main_window 露出来 —— 否则暗色主题启动会先闪一下静态的浅色底。
               这里再兜一层：3 秒还没人叫它出来（JS 崩了 / rAF 没来），也放出来，
               不能让用户对着 Dock 上跳动的图标却看不到窗口。 */
            {
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_millis(3000));
                    if let Some(w) = h.get_webview_window("main") {
                        if !w.is_visible().unwrap_or(true) {
                            let _ = w.show();
                        }
                    }
                });
            }
            // 主窗口：同样按用户选的那一档铺底色（配置文件里那个是静态的，只有一档）
            for (_, w) in app.webview_windows() {
                let c = theme_background_color(app.handle(), &w);
                let _ = w.set_background_color(Some(c));
                apply_window_appearance(app.handle(), &w);
                settle_traffic_lights(&w);
            }
            clamp_windows_to_visible(app.handle());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build blanc")
        .run(|app, event| {
            #[cfg(any(target_os = "macos", target_os = "ios", target_os = "android"))]
            if let tauri::RunEvent::Opened { urls } = &event {
                if let Some(url) = urls.first() {
                    if let Ok(p) = url.to_file_path() {
                        let p = p.to_string_lossy().to_string();
                        /* 冷启动 vs 运行中要做的不一样（2026-10-16 修「开两个窗口」）：
                         *
                         * tauri.conf.json 里的 main 窗口**每次启动必定打开**。
                         * 冷启动双击 .md 时若无条件开窗，用户会拿到「一个空壳 main
                         * + 一个文件窗」两个窗口 —— 这就是那个 bug。分界信号是
                         * OPENED_TAKEN：没取过 = 前端还没挂载 = 冷启动，主窗口
                         * 自己会调 opened_file() 取走，不用另开窗口。 */
                        deliver_opened_path(app, &p);
                    }
                }
            }
            // 退出时收掉自己拉起来的后端，别留一个孤儿 node 占着 8787
            if matches!(event, tauri::RunEvent::Exit) {
                stop_backend(app);
            }
            #[cfg(not(any(target_os = "macos", target_os = "ios", target_os = "android")))]
            let _ = (&app, &event);
        });
}

/// server.mjs 监听的端口（和 src/api.js 的 API_BASE 对齐）
const BACKEND_PORT: u16 = 8787;

/// 我们自己拉起来的 server.mjs 子进程，退出时 kill 掉。
/// 只存「是自己拉的那一个」—— 用户自己开着的开发后端不该被我们杀掉。
#[derive(Default)]
struct Backend(Mutex<Option<std::process::Child>>);

fn port_open(port: u16) -> bool {
    std::net::TcpStream::connect_timeout(
        &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
        std::time::Duration::from_millis(200),
    )
    .is_ok()
}

/// 拉起打包进 Resources 的 server.mjs，返回子进程句柄。
///
/// 端口已经被占用时**不拉也不杀**：开发时你可能正开着 `npm run node`，
/// 这时候后端是好的，抢占只会得到 EADDRINUSE 并让真正在跑的那个进程背锅。
fn start_backend(app: &tauri::AppHandle) -> Option<std::process::Child> {
    use tauri::Manager;
    let dir = app.path().resource_dir().ok()?;
    let entry = dir.join("server.mjs");
    if !entry.exists() {
        eprintln!("[backend] Resources 里没有 server.mjs（{}），无法拉起后端", entry.display());
        return None;
    }
    if port_open(BACKEND_PORT) {
        eprintln!("[backend] {} 已有服务在跑，沿用它", BACKEND_PORT);
        return None;
    }
    let node = match find_node() {
        Some(n) => n,
        None => {
            eprintln!("[backend] 找不到 node。打包版要拉起 server.mjs 依赖 Node.js，\
                       请安装 Node.js 或把 node 放进 PATH。");
            return None;
        }
    };
    let child = match std::process::Command::new(&node)
        .arg(&entry)
        .current_dir(&dir)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[backend] 启动 {} 失败（{}）：{}", node.display(), entry.display(), e);
            return None;
        }
    };
    // 窗口会立刻加载前端，前端一上来就请求 /api/roots。
    /* ⚠️ 这段**不能同步等**（2026-10-21）：它在 setup 里，跑在主线程上，
       以前是 30 × 100ms 的轮询 —— 冷盘 / node 慢的时候最坏 3s，
       窗口首帧就跟着一起等。现在只负责打印就绪日志，放到后台线程；
       端口没就绪时前端那几个请求会被拒，`api.getRoots` 里有重试兜着
       （见 src/api.js 的 fetchWithRetry 注释）。 */
    let port = BACKEND_PORT;
    std::thread::spawn(move || {
        for _ in 0..30 {
            if port_open(port) {
                eprintln!("[backend] server.mjs 已就绪 :{port}");
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        eprintln!("[backend] server.mjs 拉起了但 3s 内没监听 {port}，前端可能会报错");
    });
    Some(child)
}

/// 找可执行的 node。
///
/// 不能只 `Command::new("node")` 然后祈祷 PATH 里有：从 Finder 双击启动的 app
/// 继承的是 launchd 的 PATH（实测这台机器上只有 /usr/bin:/bin:/usr/sbin:/sbin），
/// mise / nvm / fnm 装的 node 都不在里面 —— 表现就是「无法连接后端服务」。
/// 所以先按 PATH 找，找不到再扫几个常见安装位置。
fn find_node() -> Option<std::path::PathBuf> {
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(':').filter(|d| !d.is_empty()) {
            let p = std::path::Path::new(dir).join("node");
            if p.is_file() {
                return Some(p);
            }
        }
    }
    let home = std::env::var("HOME").ok().map(std::path::PathBuf::from);
    let mut candidates: Vec<std::path::PathBuf> =
        vec!["/opt/homebrew/bin/node".into(), "/usr/local/bin/node".into(), "/usr/bin/node".into()];
    if let Some(h) = &home {
        for pat in [
            ".local/share/mise/installs/node", // mise
            ".nvm/versions/node",             // nvm
            ".fnm/node-versions",             // fnm
            ".volta/bin",                     // volta
            ".bun/bin",                       // bun 自带 node 兼容名的情况少见，放最后
        ] {
            let base = h.join(pat);
            // 这些目录下面可能是 node-<version> / installation-of-node 之类的多层结构，
            // 逐层往下找一层 bin/node 就够，不用递归。
            if let Ok(rd) = std::fs::read_dir(&base) {
                for entry in rd.flatten() {
                    let p = entry.path().join("bin/node");
                    if p.is_file() {
                        candidates.push(p);
                    }
                }
            }
        }
    }
    candidates.into_iter().find(|p| p.is_file())
}

fn stop_backend(app: &tauri::AppHandle) {
    use tauri::Manager;
    if let Some(b) = app.try_state::<Backend>() {
        if let Ok(mut g) = b.0.lock() {
            if let Some(mut child) = g.take() {
                let _ = child.kill();
                let _ = child.wait();
                eprintln!("[backend] 已关闭 server.mjs");
            }
        }
    }
}

use std::sync::Mutex;

/// 前端监听的「又打开了一个文件」事件名。载荷是那个文件的绝对路径。
/// 冷启动那条走 OPENED 静态变量（前端没挂载，发了也没人听）；
/// 运行中打开（Finder 双击、拖进来、终端带路径）都发这个事件，
/// 由主窗口判断是切知识库还是开库外文件窗口（见 deliver_opened_path）。
pub const OPEN_FILE_EVENT: &str = "blanc:open-file";

/* ===== 窗口登记表：一篇文档 → 一个窗口 =====
 *
 * 两处都要「打开某篇」：
 *   ① 前端点「在新窗口打开」（库内 rel / 外部绝对路径都有）
 *   ② Finder 双击 .md（RunEvent::Opened，绝对路径）
 * 以前 ② 是 `app.emit(OPEN_FILE_EVENT)` —— **广播**，于是双击一个文件，
 * 每一个窗口都会切过去（N 个窗口就是 N 份都变成同一篇）。
 * 现在两边统一走 open_doc_window()，行为一致，且：
 *   · 同一篇已经有窗口 → 把那个窗口**叫到前面**（产品规则：一篇一个窗口）
 *   · 没有 → 新建，label 由 Rust 统一发号
 * 发号在 Rust 而不是前端，是必须的：各窗口各有一个 `window.__blancWinSeq`，
 * 各自 ++ 会撞 label，撞了 Tauri 报「window already exists」而窗口开不出来。 */
static WIN_FOR_DOC: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

fn lookup_doc_window(key: &str) -> Option<String> {
    WIN_FOR_DOC
        .lock()
        .ok()?
        .iter()
        .find(|(k, _)| k == key)
        .map(|(_, l)| l.clone())
}

fn bind_doc_window(key: &str, label: &str) {
    if let Ok(mut g) = WIN_FOR_DOC.lock() {
        if !g.iter().any(|(k, _)| k == key) {
            g.push((key.to_string(), label.to_string()));
        }
    }
}

/// 窗口关掉了就把登记摘掉，否则这篇文档永远「已开着」，
/// 之后点它只会去 set_focus 一个不存在的 label。
fn forget_doc_window(label: &str) {
    if let Ok(mut g) = WIN_FOR_DOC.lock() {
        g.retain(|(_, l)| l != label);
    }
}

fn next_doc_label(app: &tauri::AppHandle) -> String {
    use tauri::Manager;                      // get_webview_window 来自这个 trait
    for n in 1..u32::MAX {
        let l = format!("doc-{n}");
        if !app.get_webview_window(&l).is_some() {
            return l;
        }
    }
    "doc-overflow".to_string()
}

/// 窗口标题用文件名（去掉扩展名），拿不到就叫 Blanc
fn title_for_path(p: &str) -> String {
    std::path::Path::new(p)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Blanc".into())
}

/// 窗口状态插件恢复完尺寸后，把**跑到可视区外**的窗口夹回屏幕内。
///
/// 插件管的是「记住上次在哪」，但记下来的位置不一定还看得见：
/// 外接显示器拔了、分辨率改了、用户在系统设置里挪过显示器 —— 这时恢复出来的
/// 坐标就在屏幕外，窗口开着但用户找不到（「应用怎么没有窗口」）。
/// 这里只挪**完全看不见**的窗口：露一角的就不动，那属于用户自己摆的布局。
fn clamp_windows_to_visible(app: &tauri::AppHandle) {
    use tauri::Manager;
    let Some(monitor) = app.primary_monitor().ok().flatten() else { return };
    let screen = monitor.size();
    let screen_pos = monitor.position();
    for (label, win) in app.webview_windows() {
        let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { continue };
        let visible = pos.x < screen_pos.x + screen.width as i32
            && pos.x + size.width as i32 > screen_pos.x
            && pos.y < screen_pos.y + screen.height as i32
            && pos.y + size.height as i32 > screen_pos.y;
        if visible {
            continue;
        }
        // 夹到主屏中央：宽高不动（用户记住的尺寸比位置重要），只把位置摆回来
        let x = screen_pos.x + ((screen.width as i32 - size.width as i32) / 2).max(0);
        let y = screen_pos.y + ((screen.height as i32 - size.height as i32) / 2).max(0);
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        let _label = label;
    }
}

/* 新窗口的底色跟着**用户选的主题档**走（2026-10-16 修「打开文件时白屏一阵」）。
 *
 * 为什么 Rust 侧还要定一次：tauri.conf.json 里的 backgroundColor 是**静态**的，
 * 只有一个值。「窗口已经画出来、webview 还没接管」那段间隙露的正是窗口底色，
 * 夜里用户看到的就是一下白。运行时重铺一次，深色用户压根不闪。
 *
 * ⚠️ **不能只问系统**（2026-10-16 用户报「调成日间了，打开还是黑的」）：
 * 最初这里用 `win.theme()`，那读的是**系统外观**，不是 App 里选的那一档。
 * 系统夜间 + 强制日间的用户，开机会先闪一下黑再变白 —— 比不修还糟。
 * 所以主题档要由前端告诉 Rust（见 set_theme_mode 命令）。
 *
 * 怎么传是个约束：前端**说出来的时候窗口已经画出来了**，闪已经发生，再改
 * 底色没用。所以必须让 Rust 在**建窗口之前**就能读到 —— 落一个小文件到
 * app data 目录，Rust 直接读。前端改主题时同步写它。
 *
 * 只有 app data 目录合适：不是 ~/.blanc（那是笔记库的配置），
 * 也不是 localStorage（Rust 读不到 webview 的数据存储）。
 */
fn theme_pref_path(app: &tauri::AppHandle) -> Option<std::path::PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|d| d.join("theme-mode"))
}

/// 读落盘的主题档原文。没有这个文件（第一次启动、或前端还没写过）就是 None。
fn read_theme_pref(app: &tauri::AppHandle) -> Option<String> {
    let p = theme_pref_path(app)?;
    std::fs::read_to_string(&p).ok().map(|s| s.trim().to_string())
}

/// 读用户选的主题档。没有这个文件（第一次启动、或前端还没写过）就退回问系统。
fn resolve_dark(app: &tauri::AppHandle, win: &tauri::WebviewWindow) -> bool {
    match read_theme_pref(app).as_deref() {
        Some("dark") => return true,
        Some("light") => return false,
        _ => {}                           // auto / 没落盘：问系统
    }
    matches!(win.theme(), Ok(tauri::Theme::Dark))
}

fn theme_background_color(app: &tauri::AppHandle, win: &tauri::WebviewWindow) -> tauri::utils::config::Color {
    let dark = resolve_dark(app, win);
    // 和 styles.css 的 --bg 对齐：亮 #ffffff / 暗 #191918
    let (r, g, b) = if dark { (0x19u8, 0x19u8, 0x18u8) } else { (0xffu8, 0xffu8, 0xffu8) };
    tauri::utils::config::Color(r, g, b, 0xff)
}

/* 窗口**外观**也要跟着主题档走（2026-10-17 修「窗口外面一圈黑边」）。
 *
 * 为什么底色改了还不够：底色只决定「webview 接管前露的是什么」。
 * 窗口本身的**描边和原生标题栏**是 AppKit 按 NSAppearance 画的 ——
 * macOS 上 set_theme 是 app 级的（设 NSApp.appearance），不设就一直跟**系统**
 * 外观走。用户 2026-10-17 报：系统夜间 + App 强制日间，浅色界面上窗口外圈
 * 出现一圈黑色发丝线。实测贴窗处阴影 alpha 246/255（近乎纯黑），而 Edge
 * 正常窗口是 225 —— 差的就是这个外观。
 *
 * auto 档**不覆盖**（set_theme(None)），交还给系统：这一档的意义就是跟着
 * 系统走，抢占它反而是 bug。用户从强制档切回 auto 时也要能还回去。
 */
fn apply_window_appearance(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    let t = match read_theme_pref(app).as_deref() {
        Some("dark") => Some(tauri::Theme::Dark),
        Some("light") => Some(tauri::Theme::Light),
        _ => None,                         // auto / 没落盘：跟系统
    };
    let _ = win.set_theme(t);
}

/* 红绿灯定位，自己做（2026-10-18）。
 *
 * 为什么不用 Tauri 的 trafficLightPosition：tao 的实现把它挂在 drawRect 上，
 * 按「**量出来的**当前灯高 + y」反复重写标题栏容器的高度。量出来的值不是
 * 常量，窗口一缩放（最大化）AppKit 重排把灯拉高过一次，之后每次重绘都在
 * 更高的基础上再加 y —— 正反馈发散，灯最后被拉成竖长椭圆（tao 0.37.1 仍如此）。
 *
 * 这里和 tao 的**唯一区别**：容器高度取**常量** TL_CONT_H，不取量出来的值。
 * 于是重复调用是幂等的 —— 调一万次结果都一样，不可能发散。按钮只挪 origin，
 * 不改自己的尺寸。
 *
 * 坐标全是 AppKit 的（左下原点）：
 *   · 容器顶对齐窗口顶 → origin.y = 窗口高 − TL_CONT_H
 *   · 按钮 origin.y = TL_CONT_H − TL_TOP − 灯高，TL_TOP 是「灯顶距窗口顶」
 * 这几个数是对着打包后的真窗口量出来的，和 styles.css 的 --tl-* 是同一套口径。
 */
#[cfg(target_os = "macos")]
const TL_X: f64 = 18.0;        // 左缘
/* 灯顶距窗口顶。⚠️ 按钮框是 **14pt** 见底不是 12（实测 AppKit：btn_h=14），
   所以灯心 = TL_TOP + 7；要落在 --topbar-h/2 = 24 上，这里就得是 17。
   早先按 12 算成 18，灯心落到 25，差 1px。 */
#[cfg(target_os = "macos")]
const TL_TOP: f64 = 17.0;
#[cfg(target_os = "macos")]
const TL_PITCH: f64 = 20.0;    // 中心间距
#[cfg(target_os = "macos")]
const TL_CONT_H: f64 = 40.0;   // 标题栏容器高度 —— **常量**，幂等的关键

#[cfg(target_os = "macos")]
fn apply_traffic_light_inset(win: &tauri::WebviewWindow) {
    use objc2_app_kit::{NSWindow, NSWindowButton};
    use objc2_foundation::{NSPoint, NSSize};
    let Ok(ptr) = win.ns_window() else { return };
    let window: &NSWindow = unsafe { &*(ptr as *const NSWindow) };
    let (Some(close), Some(mini), Some(zoom)) = (
        window.standardWindowButton(NSWindowButton::CloseButton),
        window.standardWindowButton(NSWindowButton::MiniaturizeButton),
        window.standardWindowButton(NSWindowButton::ZoomButton),
    ) else { return };
    // 容器是按钮的 superview 的 superview（tao 也是这么取的）
    let Some(container) = unsafe { close.superview() }.and_then(|c| unsafe { c.superview() }) else { return };
    let wh = window.frame().size.height;
    let bh = close.frame().size.height;
    let mut f = container.frame();
    f.size = NSSize::new(f.size.width, TL_CONT_H);
    f.origin = NSPoint::new(0.0, wh - TL_CONT_H);
    container.setFrame(f);
    for (i, b) in [close.clone(), mini.clone(), zoom.clone()].into_iter().enumerate() {
        b.setFrameOrigin(NSPoint::new(TL_X + (i as f64) * TL_PITCH,
                                      TL_CONT_H - TL_TOP - bh));
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_traffic_light_inset(_win: &tauri::WebviewWindow) {}

/* AppKit 会在某些时机（出全屏、改标题…）把按钮位置**悄悄重置**回默认值，
   且不触发任何通知（tao 为此专门加了 reapply_traffic_light_inset）。
   我们这里补几刀：启动后的头两秒里连打几次，之后只在建窗时调一次。
   幂等，所以多打几次没有代价。 */
fn settle_traffic_lights(win: &tauri::WebviewWindow) {
    apply_traffic_light_inset(win);
    for _ in 0..6 {
        std::thread::sleep(std::time::Duration::from_millis(250));
        apply_traffic_light_inset(win);
    }
}

/// 前端改主题时调它，把档位落盘，供**下一个窗口**建之前读取；
/// 已经开着的窗口当场换外观（见下面那句注释）。
#[tauri::command]
fn set_theme_mode(app: tauri::AppHandle, mode: String) {
    use tauri::Manager;
    let Some(p) = theme_pref_path(&app) else { return };
    if let Some(dir) = p.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let _ = std::fs::write(&p, mode.trim());
    /* 落盘是给**下一个**窗口建之前读的；已经开着的窗口要当场换外观，
     * 否则用户点一下主题切换，界面变了、窗口描边还是旧的。 */
    for (_, w) in app.webview_windows() {
        apply_window_appearance(&app, &w);
    }
}

/// 打开「某篇文档」的窗口：已有就置前，没有就新建。
/// 返回窗口 label。
fn open_doc_window(app: &tauri::AppHandle, key: &str, qs: &str, title: &str) -> String {
    use tauri::Manager;
    if let Some(label) = lookup_doc_window(key) {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.unminimize();
            let _ = w.show();
            let _ = w.set_focus();
            return label;
        }
        forget_doc_window(&label);          // 登记还在、窗口没了（被关过）
    }
    let label = next_doc_label(app);
    let url = format!("index.html?{qs}");
    match tauri::WebviewWindowBuilder::new(app, &label, tauri::WebviewUrl::App(url.into()))
        .title(title)
        // ⚠️ 以下六项必须和 tauri.conf.json 的 main 窗口、以及 api.js 的
        //    WIN_OPTS 三方一致。运行时建的窗口**不继承 conf**，漏写就退回默认 ——
        //    尤其 disable_drag_drop_handler()：不写的话 Tauri 在原生层接管拖放，
        //    HTML5 的 dragstart/dragover/drop 不派发，**块拖动失效**（2026-10-14 踩过）。
        //    `npm run check` 里的 check-window-opts.mjs 会对这三份逐项校对。
        .inner_size(1180.0, 760.0)
        .min_inner_size(840.0, 560.0)
        .resizable(true)
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 26.0))
        /* ⚠️ 这里**故意不设** traffic_light_position（2026-10-18）。
         * tao 实现它是这么干的（macos/view.rs inset_traffic_lights）：
           let h = close_rect.size.height + y;
           title_bar_rect.size.height = h;
         * 而 `close_rect.size.height` 是**量出来的当前高度**，并且这段代码挂在
           `drawRect:` 上 —— 也就是**每次重绘**都跑一遍。
         * 窗口一缩放（用户报：最大化时），AppKit 重排把灯拉高过一次，
           之后每次重绘都在那个更高的基础上再加 y，正反馈发散，
           灯被拉成竖长椭圆（tao 0.37.1 仍如此）。
         * 代价：灯回到 AppKit 的默认位置（比顶栏中心略高一点）。
         * 这笔交易划算得多 —— 对齐好看 vs 灯变形，没有可犹豫的。 */
        .disable_drag_drop_handler()
        .build()
    {
        Ok(w) => {
            // 建好立刻按用户选的那一档铺底色：这段间隙露的就是它，不铺就是一下闪
            let c = theme_background_color(app, &w);
            let _ = w.set_background_color(Some(c));
            apply_window_appearance(app, &w);
            settle_traffic_lights(&w);
            bind_doc_window(key, &label);
            label
        }
        Err(_) => label,                  // 建失败就返回 label，不往上抛
    }
}

/// 前端「在新窗口打开」走这里，而不是自己 new WebviewWindow —— 
/// 这样「一篇一窗口」的规则只有一份实现，Finder 双击和手动开是同一条路。
#[tauri::command]
fn open_doc_window_cmd(app: tauri::AppHandle, rel: Option<String>, path: Option<String>) -> Result<String, String> {
    let (key, qs, title) = match (&rel, &path) {
        (Some(r), _) => {
            let name = r.rsplit('/').next().unwrap_or(r).to_string();
            (format!("rel:{r}"), format!("doc={}", urlencode(r)), name)
        }
        (None, Some(p)) => (
            format!("path:{p}"),
            format!("ext={}", urlencode(p)),
            title_for_path(p),
        ),
        (None, None) => return Err("rel 和 path 至少给一个".into()),
    };
    Ok(open_doc_window(&app, &key, &qs, &title))
}

/// 极简 URL 编码：只处理 query 里真正会出现的字符（路径分隔符、空格、中文…）。
/// 不用拉 percent-encoding 依赖 —— 这几个手写分支覆盖了 macOS 路径的全部情况。
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 最近一次由系统交给我们的文件路径
static OPENED: Mutex<Option<String>> = Mutex::new(None);

/* 登记进 macOS 的「最近打开」—— 用户右键 Dock 图标就能看到开过的文件。
 *
 * Blanc 不是 NSDocument 应用（没有 NSDocumentController 的文档模型），系统不会
 * 自动记。用的是 NSDocumentController 的这条公开接口，SDK 里写得很清楚：
 * "You can use this even in non-NSDocument-based applications."
 * 它加的是 Dock 右键菜单里那一份，和访达「最近使用」互相独立。
 *
 * AppKit 只能在主线程调：RunEvent::Opened 和 setup 本来就在主线程上，
 * 但判一下再走，不确定时派发回主线程而不是直接调崩。
 */
#[cfg(target_os = "macos")]
fn note_recent_document(app: &tauri::AppHandle, path: &str) {
    use objc2::rc::Retained;
    use objc2::MainThreadMarker;
    use objc2_app_kit::NSDocumentController;
    use objc2_foundation::{NSString, NSURL};
    let p = path.to_string();
    let do_it = move || {
        let Some(mtm) = MainThreadMarker::new() else { return };
        let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(&p), false);
        let dc: Retained<NSDocumentController> = NSDocumentController::sharedDocumentController(mtm);
        dc.noteNewRecentDocumentURL(&url);
    };
    if MainThreadMarker::new().is_some() {
        do_it();
    } else {
        let _ = app.run_on_main_thread(do_it);
    }
}

#[cfg(not(target_os = "macos"))]
fn note_recent_document(_app: &tauri::AppHandle, _path: &str) {}

/* 前端有没有取过 OPENED（= 主窗口的前端挂载过没有）。
   冷启动双击 .md 时用来决定「让主窗口自己接管」还是「另开一个窗口」——
   见 run() 里 RunEvent::Opened 那段。 */
static OPENED_TAKEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

fn set_opened(p: Option<String>) {
    if let Ok(mut g) = OPENED.lock() {
        *g = p;
    }
}

/* 系统刚给我们一个文件路径时走这里。
 *
 * 为什么判断「它在不在某个知识库里」交给前端而不在 Rust 做：
 * 知识库列表归 server.mjs 管（~/.blanc/config.json），Rust 再读一遍就成了
 * 第二份真相 —— 配置一改两处就会漂。而前端本来就持有 roots
 * （App.jsx 的 refreshRoots），让它判断只有一份事实，也不会不一致。
 *
 * 冷启动 vs 运行中的分界还是 OPENED_TAKEN：
 *   · 没取过 → 前端还没挂载，存进 OPENED，主窗口起来自己取走
 *   · 取过   → 主窗口在跑，emit 过去；它决定是切库开这篇，还是开外部文件窗口
 *
 * 2026-10-17 之前运行中是**直接** open_doc_window 的，代价是：知识库里的
 * 文件也会被当成库外文件另开一个没有侧栏的窗口，用户报「没法定位到对应的
 * 笔记库」。
 */
fn deliver_opened_path(app: &tauri::AppHandle, p: &str) {
    note_recent_document(app, p);
    use std::sync::atomic::Ordering;
    if OPENED_TAKEN.load(Ordering::Relaxed) {
        use tauri::Emitter;
        /* 定向发给主窗口，不是广播：独立窗口收到这条事件会把它当成
           「系统让我开一篇」，把 URL 里那篇换成别人（见 opened_file 上的注释，
           是同一个 bug 的另一条入口）。 */
        let _ = app.emit_to("main", OPEN_FILE_EVENT, p);
    } else {
        set_opened(Some(p.to_string()));
    }
}

/// 是不是「像路径的」命令行参数。
/// macOS 双击时 argv 可能有奇怪的第 0 参数，Windows 上还可能混进
/// `--some-flag`；这里只认绝对路径 + 常见扩展名，避免把它们当文件。
fn is_openable(s: &str) -> bool {
    let p = std::path::Path::new(s);
    if !p.is_absolute() {
        return false;
    }
    match p.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
        Some(e) => matches!(e.as_str(), "md" | "markdown" | "mdown" | "mkd" | "mdx"),
        None => false,
    }
}

/// 启动时交给前端的那条路径（取走但不消费：前端可能因为 HMR 重挂载再问一次）
///
/// ⚠️ 只回答**主窗口**（2026-10-21）。`OPENED` 是进程级的一个静态量，
/// 取走也不清空 —— 独立窗口（?doc= / ?ext=）若也能问到，拿到的永远是
/// 「上一次系统打开的那条路径」，醒过来就把 URL 里正确的那篇覆盖掉。
/// 前端那边也有一道同样的闸门（见 App.jsx 的 isDocWindowRef），两道都在，
/// 因为这条契约两边任何一侧被改坏都会退回到那个 bug。
#[tauri::command]
fn opened_file(window: tauri::WebviewWindow) -> Option<String> {
    if window.label() != "main" {
        return None;
    }
    use std::sync::atomic::Ordering;
    OPENED_TAKEN.store(true, Ordering::Relaxed);
    OPENED.lock().ok().and_then(|g| g.clone())
}

/// 读一个绝对路径的文本文件。
/// 走 Rust 而不是 server.mjs：server.mjs 是 HTTP 服务且用 safeJoin 锁在
/// 知识库根目录内，给它开「任意绝对路径读写」等于开一个远程写任意文件的口子。
/// 「关于」面板要显示的应用名和版本号。
///
/// 为什么不写死在前端：版本号已经有三份事实来源（tauri.conf.json、
/// Cargo.toml、package.json），再手抄一份进 JS 就成了第四份 —— 迟早漂。
/// `package_info()` 直接读打包时那份，是「用户装到的那个版本」的唯一可信答案。
/// 返回元组而不是 map：和这个文件里其它只回标量的命令一个形状，别为一个面板破例。
/// 前端首帧画完（两次 rAF）调用：把以 visible:false 建出来的主窗口露出来，
/// 避免「先看到一窗白底再看到内容」。兜底逻辑在 setup 里的 3 秒定时器。
#[tauri::command]
fn show_main_window(window: tauri::WebviewWindow) {
    let _ = window.show();
    let _ = window.set_focus();
}

#[tauri::command]
fn app_info(app: tauri::AppHandle) -> Result<(String, String), String> {
    let p = app.package_info();
    Ok((p.name.clone(), p.version.to_string()))
}

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    read_text(&path)
}

/// `read_to_string` 的唯一入口，错误信息在这里统一成人话。
///
/// 为什么单独拎出来：`read_to_string` 对**非 UTF-8** 的文件抛的是
/// `stream did not contain valid UTF-8` —— 那是 Rust 标准库的字面输出，
/// 端到端冒到用户眼前就是「打开失败：读取失败：stream did not contain valid UTF-8」
/// （用户 2026-10-18 截图里那条）。双击一个二进制文件（比如被写坏的 .md）
/// 就该看到「这不像文本文件」，而不是一句英文的库错误。别的读法（权限、
/// 不存在、目录）也一并翻成人话，顺带把路径带上 —— 文件名是最有用的线索。
fn read_text(path: &str) -> Result<String, String> {
    use std::io::ErrorKind;
    std::fs::read_to_string(path).map_err(|e| {
        let name = std::path::Path::new(path)
            .file_name().map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string());
        match e.kind() {
            ErrorKind::InvalidData => format!("{name} 不是文本文件（不是有效的 UTF-8，可能损坏了）"),
            ErrorKind::PermissionDenied => format!("没有权限读取 {name}"),
            ErrorKind::NotFound => format!("文件不存在了：{name}"),
            _ => format!("读取 {name} 失败：{e}"),
        }
    })
}

/// 读文件 + 它的 mtime（毫秒）。返回元组而不是自定义结构，
/// 是为了不和前端已有的 `{content}` 形状打架 —— 调用方用 `.0` 取内容、
/// `.1` 拿基准时间。写盘时把它当 base_mtime 送回来做乐观锁。
#[tauri::command]
fn read_file_meta(path: String) -> Result<(String, u64, u64), String> {
    let content = read_text(&path)?;
    let meta = std::fs::metadata(&path).ok();
    let to_ms = |t: std::time::SystemTime| {
        t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    };
    let mtime = meta.as_ref().and_then(|m| m.modified().ok()).map(to_ms).unwrap_or(0);
    /* 创建时间一起返回（2026-10-16 加）。
     * 库内文件的属性面板拿的是 /api/tree 里 scan() 的 fs.stat，所以那两条一直有；
     * 库外文件走的是这个命令，原来只回 mtime，前端拿不到「创建时间」，
     * 面板上那两行就是空的 —— 用户报「外部文件没有属性」。
     *
     * created() 只有部分平台给：macOS/Windows 有 birthtime，Linux 上
     * 多数文件系统不提供、会返回 Err。拿不到就回 0，前端据此隐藏那一行，
     * 不用「1970 年 1 月 1 日」那种明显不对的值糊弄。 */
    let ctime = meta.as_ref().and_then(|m| m.created().ok()).map(to_ms).unwrap_or(0);
    Ok((content, mtime, ctime))
}

/// 写盘，带乐观锁。
///
/// `base_mtime` 是前端**读到这份内容时**的文件 mtime；对不上说明这之后
/// 有别处改过（另一个窗口、或用户拿别的编辑器存了）。此时返回
/// `Err`（带固定前缀）而不是覆盖 —— 静默覆盖是这类应用最容易犯、
/// 也最招骂的错。
#[tauri::command]
fn write_file(path: String, content: String, base_mtime: Option<u64>) -> Result<u64, String> {
    if let Some(base) = base_mtime.filter(|v| *v > 0) {
        let cur = std::fs::metadata(&path)
            .and_then(|m| m.modified())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
            .unwrap_or(0);
        if cur != base {
            return Err(format!("CONFLICT\u{1}{cur}"));
        }
    }
    std::fs::write(&path, content).map_err(|e| format!("保存失败：{e}"))?;
    let mtime = std::fs::metadata(&path)
        .and_then(|m| m.modified())
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0))
        .unwrap_or(0);
    Ok(mtime)
}

/// 在 Finder / 资源管理器里定位这个文件
#[tauri::command]
fn reveal_in_file_manager(path: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("定位失败：{e}"))
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("定位失败：{e}"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let dir = std::path::Path::new(&path)
            .parent()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("定位失败：{e}"))
    }
}
/// 把本应用设成 .md 的默认编辑器。
///
/// 为什么需要它：`bundle.fileAssociations` 只让系统**认得**我们（会出现在
/// 「打开方式」里），macOS 不会因为这个就自动改默认 —— 改默认要走
/// LaunchServices 的 `LSSetDefaultRoleHandlerForContentType`，
/// 而且按 Apple 的规则用户要有一次知情的机会（部分系统版本会弹确认框）。
///
/// `public.plain-text` 是 .md 在 macOS 上的实际 UTI（没有内置的 markdown UTI，
/// 除非别的应用导出过 net.daringfireball.markdown），两个都声明一份更稳。
#[tauri::command]
fn set_default_markdown_app() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use core_foundation::base::TCFType;
        use core_foundation::string::CFString;


        #[link(name = "CoreServices", kind = "framework")]
        extern "C" {
            fn LSSetDefaultRoleHandlerForContentType(
                content_type: core_foundation::base::CFTypeRef,
                role: core_foundation::base::CFTypeRef,
                bundle_id: core_foundation::base::CFTypeRef,
            ) -> core_foundation::base::OSStatus;
        }

        const KLS_ROLES_EDITOR: &str = "Editor";
        /// 必须和 tauri.conf.json 的 `identifier` 一致，否则 LSSetDefaultRoleHandler
        /// 注册的是一个不存在的 bundle，「设为默认 .md 应用」点了没反应
        const BUNDLE_ID: &str = "org.blanc.notes";

        for uti in ["net.daringfireball.markdown", "public.plain-text"] {
            let ct = CFString::new(uti);
            let role = CFString::new(KLS_ROLES_EDITOR);
            let bid = CFString::new(BUNDLE_ID);
            let st: core_foundation::base::OSStatus = unsafe {
                LSSetDefaultRoleHandlerForContentType(
                    ct.as_concrete_TypeRef() as core_foundation::base::CFTypeRef,
                    role.as_concrete_TypeRef() as core_foundation::base::CFTypeRef,
                    bid.as_concrete_TypeRef() as core_foundation::base::CFTypeRef,
                )
            };
            if st != 0 {
                return Err(format!("系统拒绝了这次设置（status {st}）"));
            }
        }
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("只有 macOS 支持设置默认应用".into())
    }
}

#[cfg(test)]
mod tests {
    /// find_node 的两条行为。
    ///
    /// 合成一个用例顺序跑，而不是两个：cargo test 默认多线程，
    /// 而 set_var 改的是**进程级全局 env**，两个用例同时改会互相打架
    /// （踩过：另一个用例先恢复了真 PATH，导致这里读到 mise 的 node 而断言失败）。
    /// 拆成两个用例就得挂 --test-threads=1，哪天忘了又会炸。
    #[test]
    fn find_node() {
        let old = std::env::var("PATH").ok();

        // ① PATH 里没有 node：模拟「从 Finder 双击启动」——app 继承的是
        // launchd 的 PATH（这台机器上只有 /usr/bin:/bin:/usr/sbin:/sbin），
        // mise 装的 node 不在里面。以前这里只能靠运气。
        std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin");
        let fallback = super::find_node();

        // ② PATH 里有 node：优先用它，不去乱扫
        let dir = std::env::temp_dir().join("blanc-fake-node-bin");
        std::fs::create_dir_all(&dir).unwrap();
        let fake = dir.join("node");
        std::fs::write(&fake, b"#!/bin/sh\n").unwrap();
        std::env::set_var("PATH", &dir);
        let prefer = super::find_node();

        if let Some(p) = old {
            std::env::set_var("PATH", p);
        }
        let _ = std::fs::remove_file(&fake);

        assert_eq!(prefer.as_deref(), Some(fake.as_path()), "PATH 里有 node 时应该优先用它");
        assert!(fallback.is_some(), "PATH 里没有 node 时，也该能从 mise/nvm/brew 等常见位置找到");
    }
}
