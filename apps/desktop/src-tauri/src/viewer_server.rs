use crate::{bounded_io, AppState, Workspace};
use local_excalidraw_filesystem::{Result, WorkspaceError, WorkspaceFs};
use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::net::{IpAddr, SocketAddr, TcpListener, TcpStream, UdpSocket};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

const PREFERRED_PORT: u16 = 43871;
const MAX_CLIENTS: usize = 12;

pub(crate) struct ViewerService {
    servers: Mutex<HashMap<String, ViewerServer>>,
}

impl Default for ViewerService {
    fn default() -> Self {
        Self {
            servers: Mutex::new(HashMap::new()),
        }
    }
}

impl ViewerService {
    pub(crate) fn start(
        &self,
        label: &str,
        app: tauri::AppHandle,
        workspace: AppState,
    ) -> Result<String> {
        if let Some(url) = self.url(label)? {
            return Ok(url);
        }
        let host = local_network_host().map_err(viewer_start_error)?;
        self.start_on(label, &host, PREFERRED_PORT, workspace, Some(app))
    }

    fn start_on(
        &self,
        label: &str,
        host: &str,
        port: u16,
        workspace: AppState,
        app: Option<tauri::AppHandle>,
    ) -> Result<String> {
        let mut servers = self.servers.lock().map_err(|_| viewer_lock_error())?;
        if let Some(server) = servers.get(label) {
            return Ok(server.url.clone());
        }
        let root = selected_root(&workspace, label)?;
        let started = ViewerServer::start(host, port, workspace, label.to_string(), root, app)
            .map_err(viewer_start_error)?;
        let url = started.url.clone();
        servers.insert(label.to_string(), started);
        Ok(url)
    }

    pub(crate) fn url(&self, label: &str) -> Result<Option<String>> {
        Ok(self
            .servers
            .lock()
            .map_err(|_| viewer_lock_error())?
            .get(label)
            .map(|server| server.url.clone()))
    }

    pub(crate) fn stop(&self, label: &str) -> Result<()> {
        self.servers
            .lock()
            .map_err(|_| viewer_lock_error())?
            .remove(label);
        Ok(())
    }

    pub(crate) fn remove_window(&self, state: &AppState, label: &str) -> Result<()> {
        let mut servers = self.servers.lock().map_err(|_| viewer_lock_error())?;
        let mut guard = state.0.lock().map_err(|_| viewer_lock_error())?;
        servers.remove(label);
        guard.active.remove(label);
        guard.pending.remove(label);
        Ok(())
    }

    pub(crate) fn select_workspace(
        &self,
        state: &AppState,
        label: &str,
        workspace: Workspace,
    ) -> Result<()> {
        let mut servers = self.servers.lock().map_err(|_| viewer_lock_error())?;
        let mut guard = state
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("state", "Workspace state lock was poisoned"))?;
        if guard
            .active
            .iter()
            .any(|(other, selected)| other != label && selected.fs.root == workspace.fs.root)
            || guard
                .pending
                .iter()
                .any(|(other, root)| other != label && *root == workspace.fs.root)
        {
            return Err(WorkspaceError::new(
                "state",
                "This folder is already open in another window",
            ));
        }
        if guard
            .active
            .get(label)
            .is_some_and(|selected| selected.fs.root != workspace.fs.root)
        {
            return Err(WorkspaceError::new(
                "state",
                "Open this folder in a new window",
            ));
        }
        servers.remove(label);
        guard.pending.remove(label);
        guard.active.insert(label.to_string(), workspace);
        Ok(())
    }
}

fn viewer_lock_error() -> WorkspaceError {
    WorkspaceError::new("viewer", "Viewer state lock was poisoned")
}

fn viewer_start_error(error: io::Error) -> WorkspaceError {
    WorkspaceError::new(
        "viewer",
        format!("Cannot start the read-only viewer: {error}"),
    )
}

fn selected_root(workspace: &AppState, label: &str) -> Result<PathBuf> {
    let guard = workspace.0.lock().map_err(|_| viewer_lock_error())?;
    guard
        .active
        .get(label)
        .map(|selected| selected.fs.root.clone())
        .ok_or_else(|| {
            WorkspaceError::new("state", "Select a workspace before starting the viewer")
        })
}

struct ViewerServer {
    url: String,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Mutex<Option<JoinHandle<()>>>,
}

impl ViewerServer {
    fn start(
        host: &str,
        preferred_port: u16,
        workspace: AppState,
        label: String,
        allowed_root: PathBuf,
        app: Option<tauri::AppHandle>,
    ) -> io::Result<Self> {
        let listener = match TcpListener::bind((host, preferred_port)) {
            Ok(listener) => listener,
            Err(error) if error.kind() == io::ErrorKind::AddrInUse => TcpListener::bind((host, 0))?,
            Err(error) => return Err(error),
        };
        let address = listener.local_addr()?;
        let token_directory = tempfile::Builder::new()
            .prefix("view-")
            .rand_bytes(32)
            .tempdir()?;
        let token = token_directory
            .path()
            .file_name()
            .ok_or_else(|| io::Error::other("Cannot generate viewer access path"))?
            .to_string_lossy()
            .into_owned();
        token_directory.close()?;
        let url = format!("http://{}:{}/view/{token}/", address.ip(), address.port());
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let thread = thread::Builder::new()
            .name("drawing-viewer".into())
            .spawn(move || {
                let active = Arc::new(AtomicUsize::new(0));
                for connection in listener.incoming() {
                    if thread_stop.load(Ordering::Acquire) {
                        break;
                    }
                    match connection {
                        Ok(mut stream) => {
                            if active
                                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                                    (count < MAX_CLIENTS).then_some(count + 1)
                                })
                                .is_err()
                            {
                                let _ = respond(
                                    &mut stream,
                                    "503 Service Unavailable",
                                    "text/plain",
                                    b"Viewer is busy",
                                );
                                continue;
                            }
                            let workspace = workspace.clone();
                            let label = label.clone();
                            let allowed_root = allowed_root.clone();
                            let app = app.clone();
                            let token = token.clone();
                            let request_stop = Arc::clone(&thread_stop);
                            let request_active = Arc::clone(&active);
                            if let Err(error) = thread::Builder::new()
                                .name("drawing-viewer-client".into())
                                .spawn(move || {
                                    let _count = ClientCount(request_active);
                                    if let Err(error) = serve(
                                        &mut stream,
                                        &token,
                                        &workspace,
                                        &label,
                                        &allowed_root,
                                        &request_stop,
                                        app.as_ref(),
                                    ) {
                                        eprintln!("Cannot serve read-only drawing: {error}");
                                    }
                                })
                            {
                                active.fetch_sub(1, Ordering::AcqRel);
                                eprintln!("Cannot start viewer request: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("Cannot accept viewer connection: {error}");
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            url,
            address,
            stop,
            thread: Mutex::new(Some(thread)),
        })
    }
}

impl Drop for ViewerServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let _ = TcpStream::connect_timeout(&self.address, Duration::from_secs(1));
        if let Ok(mut thread) = self.thread.lock() {
            if let Some(thread) = thread.take() {
                if thread.join().is_err() {
                    eprintln!("Viewer listener panicked during shutdown");
                }
            }
        }
    }
}

struct ClientCount(Arc<AtomicUsize>);

impl Drop for ClientCount {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::AcqRel);
    }
}

fn local_network_host() -> io::Result<String> {
    let socket = UdpSocket::bind("0.0.0.0:0")?;
    socket.connect("192.0.2.1:9")?;
    let ip = socket.local_addr()?.ip();
    if private_lan_ip(ip) {
        return Ok(ip.to_string());
    }
    Err(io::Error::other(
        "No private local-network address is available",
    ))
}

fn private_lan_ip(ip: IpAddr) -> bool {
    matches!(ip, IpAddr::V4(address) if address.is_private() || address.is_link_local())
}

fn serve(
    stream: &mut TcpStream,
    token: &str,
    workspace: &AppState,
    label: &str,
    allowed_root: &PathBuf,
    stop: &AtomicBool,
    app: Option<&tauri::AppHandle>,
) -> io::Result<()> {
    if stop.load(Ordering::Acquire) {
        return Ok(());
    }
    stream.set_write_timeout(Some(Duration::from_secs(5)))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut buffer = [0; 8192];
    let mut length = 0;
    while length < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return respond(
                stream,
                "408 Request Timeout",
                "text/plain",
                b"Request timed out",
            );
        }
        stream.set_read_timeout(Some(remaining))?;
        let count = stream.read(&mut buffer[length..])?;
        if count == 0 {
            return Ok(());
        }
        length += count;
        if buffer[..length]
            .windows(4)
            .any(|bytes| bytes == b"\r\n\r\n")
        {
            break;
        }
    }
    let request = match std::str::from_utf8(&buffer[..length]) {
        Ok(request) if request.contains("\r\n\r\n") => request,
        _ => return respond(stream, "400 Bad Request", "text/plain", b"Invalid request"),
    };
    let Some(line) = request.split("\r\n").next() else {
        return respond(stream, "400 Bad Request", "text/plain", b"Invalid request");
    };
    let parts: Vec<_> = line.split(' ').collect();
    if parts.len() != 3 || parts[2] != "HTTP/1.1" || !parts[1].starts_with('/') {
        return respond(stream, "400 Bad Request", "text/plain", b"Invalid request");
    }
    if parts[0] != "GET" {
        return respond(
            stream,
            "405 Method Not Allowed",
            "text/plain",
            b"Only GET is supported",
        );
    }
    let url = match tauri::Url::parse(&format!("http://localhost{}", parts[1])) {
        Ok(url) => url,
        Err(_) => return respond(stream, "400 Bad Request", "text/plain", b"Invalid URL"),
    };
    if url.path() == "/favicon.ico" {
        return respond(stream, "204 No Content", "text/plain", b"");
    }
    let base = format!("/view/{token}/");
    if url.path() == base {
        return asset_response(stream, app, "index.html");
    }
    if let Some(route) = url.path().strip_prefix(&base) {
        let path = url
            .query_pairs()
            .find_map(|(key, value)| (key == "path").then(|| value.into_owned()));
        return match (route, path) {
            ("api/list", path) => list_response(stream, workspace, label, allowed_root, stop, path),
            ("api/file", Some(path)) if path.ends_with(".excalidraw") => {
                file_response(stream, workspace, label, allowed_root, stop, path)
            }
            _ => respond(stream, "404 Not Found", "text/plain", b"Not found"),
        };
    }
    if (url.path().starts_with("/assets/") || url.path().starts_with("/excalidraw-assets/"))
        && !url.path().contains("..")
        && !url.path().contains('%')
    {
        return asset_response(stream, app, url.path().trim_start_matches('/'));
    }
    respond(stream, "404 Not Found", "text/plain", b"Not found")
}

fn selected_workspace<T: Send + 'static>(
    workspace: &AppState,
    label: &str,
    allowed_root: &PathBuf,
    kind: &str,
    path: &str,
    action: impl FnOnce(&WorkspaceFs) -> Result<T> + Send + 'static,
) -> Result<(PathBuf, T)> {
    let fs = {
        let guard = workspace
            .0
            .lock()
            .map_err(|_| WorkspaceError::new("viewer", "Workspace state lock was poisoned"))?;
        Arc::clone(
            &guard
                .active
                .get(label)
                .ok_or_else(|| {
                    WorkspaceError::new("state", "Select a workspace in the desktop app")
                })?
                .fs,
        )
    };
    let root = fs.root.clone();
    if root != *allowed_root {
        return Err(WorkspaceError::new("state", "Viewer workspace changed"));
    }
    let key = format!("{kind}\0{}\0{path}", root.display());
    let value =
        tauri::async_runtime::block_on(bounded_io(key, "unavailable", move || action(&fs)))?;
    Ok((root, value))
}

fn selected_response(
    stream: &mut TcpStream,
    workspace: &AppState,
    label: &str,
    root: &PathBuf,
    stop: &AtomicBool,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    let selected = {
        let guard = workspace
            .0
            .lock()
            .map_err(|_| io::Error::other("Workspace state lock poisoned"))?;
        guard
            .active
            .get(label)
            .is_some_and(|selected| selected.fs.root == *root)
    };
    if stop.load(Ordering::Acquire) || !selected {
        return respond(
            stream,
            "409 Conflict",
            "text/plain",
            b"Workspace changed; retry",
        );
    }
    respond(stream, "200 OK", content_type, body)
}

fn list_response(
    stream: &mut TcpStream,
    workspace: &AppState,
    label: &str,
    allowed_root: &PathBuf,
    stop: &AtomicBool,
    path: Option<String>,
) -> io::Result<()> {
    let target = path.unwrap_or_default();
    let key_path = target.clone();
    match selected_workspace(
        workspace,
        label,
        allowed_root,
        "viewer-list",
        &key_path,
        move |fs| fs.list_at((!target.is_empty()).then_some(target.as_str())),
    ) {
        Ok((root, entries)) => {
            let entries: Vec<_> = entries
                .into_iter()
                .filter(|entry| entry.kind == "folder" || entry.kind == "drawing")
                .collect();
            let body = serde_json::to_vec(&entries).map_err(io::Error::other)?;
            selected_response(
                stream,
                workspace,
                label,
                &root,
                stop,
                "application/json",
                &body,
            )
        }
        Err(error) => workspace_error(stream, error),
    }
}

fn file_response(
    stream: &mut TcpStream,
    workspace: &AppState,
    label: &str,
    allowed_root: &PathBuf,
    stop: &AtomicBool,
    path: String,
) -> io::Result<()> {
    let key_path = path.clone();
    match selected_workspace(
        workspace,
        label,
        allowed_root,
        "viewer-read",
        &key_path,
        move |fs| fs.read(&path),
    ) {
        Ok((root, snapshot)) => selected_response(
            stream,
            workspace,
            label,
            &root,
            stop,
            "application/json",
            snapshot.content.as_bytes(),
        ),
        Err(error) => workspace_error(stream, error),
    }
}

fn workspace_error(stream: &mut TcpStream, error: WorkspaceError) -> io::Result<()> {
    let (status, message) = match error.code.as_str() {
        "state" => (
            "503 Service Unavailable",
            "Select a workspace in the desktop app",
        ),
        "missing" | "path" | "type" => ("404 Not Found", "Drawing not found"),
        _ => ("503 Service Unavailable", "File unavailable; retry shortly"),
    };
    respond(stream, status, "text/plain", message.as_bytes())
}

fn asset_response(
    stream: &mut TcpStream,
    app: Option<&tauri::AppHandle>,
    path: &str,
) -> io::Result<()> {
    let asset = app.and_then(|app| app.asset_resolver().get(path.to_string()));
    match asset {
        Some(asset) => respond(stream, "200 OK", asset.mime_type(), asset.bytes()),
        None => respond(stream, "404 Not Found", "text/plain", b"Not found"),
    }
}

fn respond(
    stream: &mut TcpStream,
    status: &str,
    content_type: &str,
    body: &[u8],
) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nX-Frame-Options: DENY\r\nReferrer-Policy: no-referrer\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; frame-src https://www.youtube.com; object-src 'none'; base-uri 'none'; form-action 'none'\r\n\r\n",
        body.len()
    )?;
    stream.write_all(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Workspace;
    use local_excalidraw_filesystem::WorkspaceWatcher;
    use std::fs;

    fn request(server: &ViewerServer, method: &str, path: &str) -> String {
        let mut stream = TcpStream::connect(("127.0.0.1", server.address.port())).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(20)))
            .unwrap();
        write!(
            stream,
            "{method} {path} HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
            server.address.port()
        )
        .unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn base(server: &ViewerServer) -> String {
        tauri::Url::parse(&server.url).unwrap().path().to_string()
    }

    fn select(workspace: &AppState, label: &str, root: &std::path::Path) {
        let fs = WorkspaceFs::open(root).unwrap();
        let watcher = WorkspaceWatcher::new(&fs.root, |_| {}).unwrap();
        workspace.0.lock().unwrap().active.insert(
            label.into(),
            Workspace {
                fs: Arc::new(fs),
                _watcher: watcher,
            },
        );
    }

    #[test]
    fn chooses_a_free_port_when_the_preferred_one_is_busy() {
        let occupied = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let preferred = occupied.local_addr().unwrap().port();
        let server = ViewerServer::start(
            "127.0.0.1",
            preferred,
            AppState::default(),
            "main".into(),
            PathBuf::new(),
            None,
        )
        .unwrap();
        assert_ne!(server.address.port(), preferred);
        assert!(server.url.starts_with("http://127.0.0.1:"));
        assert!(server.url.contains("/view/view-"));
        let response = request(&server, "GET", &format!("{}api/list", base(&server)));
        assert!(response.starts_with("HTTP/1.1 503 Service Unavailable"));
    }

    #[test]
    fn advertises_only_private_lan_addresses() {
        for address in ["10.0.0.7", "172.20.1.2", "192.168.1.3", "169.254.1.4"] {
            assert!(private_lan_ip(address.parse().unwrap()));
        }
        for address in ["127.0.0.1", "0.0.0.0", "8.8.8.8", "100.64.0.1", "::1"] {
            assert!(!private_lan_ip(address.parse().unwrap()));
        }
    }

    #[test]
    fn serves_only_drawings_in_the_current_workspace() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        fs::write(
            first.path().join("first.excalidraw"),
            r#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        fs::write(
            first.path().join("private.excalidrawlib"),
            "private library",
        )
        .unwrap();
        fs::create_dir(first.path().join("folder")).unwrap();
        fs::write(
            first.path().join("folder/nested.excalidraw"),
            r#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        fs::write(
            second.path().join("second.excalidraw"),
            r#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        let workspace = AppState::default();
        select(&workspace, "main", first.path());
        let server = ViewerServer::start(
            "127.0.0.1",
            0,
            workspace.clone(),
            "main".into(),
            first.path().canonicalize().unwrap(),
            None,
        )
        .unwrap();
        let base = base(&server);
        let listed = request(&server, "GET", &format!("{base}api/list"));
        assert!(listed.contains("first.excalidraw"));
        assert!(listed.contains("folder"));
        assert!(!listed.contains("private.excalidrawlib"));
        let nested = request(&server, "GET", &format!("{base}api/list?path=folder"));
        assert!(nested.contains("nested.excalidraw"));
        let drawing = request(
            &server,
            "GET",
            &format!("{base}api/file?path=first.excalidraw"),
        );
        assert!(drawing.starts_with("HTTP/1.1 200 OK"));
        assert!(drawing.contains("\"type\":\"excalidraw\""));
        for path in [
            format!("{base}api/file?path=../second.excalidraw"),
            format!("{base}api/file?path=private.excalidrawlib"),
            format!("{base}api/list?path=../"),
            format!("{base}api/file?path=.hidden.excalidraw"),
            "/view/wrong-token/api/list".to_string(),
        ] {
            assert!(
                request(&server, "GET", &path).starts_with("HTTP/1.1 404 Not Found"),
                "{path}"
            );
        }
        assert!(request(
            &server,
            "POST",
            &format!("{base}api/file?path=first.excalidraw")
        )
        .starts_with("HTTP/1.1 405 Method Not Allowed"));
        select(&workspace, "main", second.path());
        let listed = request(&server, "GET", &format!("{base}api/list"));
        assert!(listed.starts_with("HTTP/1.1 503 Service Unavailable"));
        assert!(!listed.contains("second.excalidraw"));
        assert!(!listed.contains("first.excalidraw"));
        assert!(request(
            &server,
            "GET",
            &format!("{base}api/file?path=first.excalidraw")
        )
        .starts_with("HTTP/1.1 503 Service Unavailable"));
    }

    #[test]
    fn viewers_are_isolated_by_window_and_stop_independently() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        fs::write(
            first.path().join("first.excalidraw"),
            r#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        fs::write(
            second.path().join("second.excalidraw"),
            r#"{"type":"excalidraw","elements":[]}"#,
        )
        .unwrap();
        let workspace = AppState::default();
        select(&workspace, "main", first.path());
        select(&workspace, "workspace-1", second.path());
        let service = ViewerService::default();
        assert!(service.url("main").unwrap().is_none());
        let first_url = service
            .start_on("main", "127.0.0.1", 0, workspace.clone(), None)
            .unwrap();
        assert_eq!(
            service
                .start_on("main", "127.0.0.1", 0, workspace.clone(), None)
                .unwrap(),
            first_url
        );
        let first_address = service.servers.lock().unwrap().get("main").unwrap().address;
        let second_url = service
            .start_on("workspace-1", "127.0.0.1", 0, workspace.clone(), None)
            .unwrap();
        assert_ne!(first_url, second_url);
        let second_address = service
            .servers
            .lock()
            .unwrap()
            .get("workspace-1")
            .unwrap()
            .address;
        {
            let servers = service.servers.lock().unwrap();
            let first_list = request(
                servers.get("main").unwrap(),
                "GET",
                &format!("{}api/list", tauri::Url::parse(&first_url).unwrap().path()),
            );
            let second_list = request(
                servers.get("workspace-1").unwrap(),
                "GET",
                &format!("{}api/list", tauri::Url::parse(&second_url).unwrap().path()),
            );
            assert!(first_list.contains("first.excalidraw"));
            assert!(!first_list.contains("second.excalidraw"));
            assert!(second_list.contains("second.excalidraw"));
            assert!(!second_list.contains("first.excalidraw"));
        }
        service.remove_window(&workspace, "main").unwrap();
        assert!(service.url("main").unwrap().is_none());
        assert!(selected_root(&workspace, "main").is_err());
        assert_eq!(
            service.url("workspace-1").unwrap(),
            Some(second_url.clone())
        );
        let still_open = {
            let servers = service.servers.lock().unwrap();
            request(
                servers.get("workspace-1").unwrap(),
                "GET",
                &format!("{}api/list", tauri::Url::parse(&second_url).unwrap().path()),
            )
        };
        assert!(still_open.contains("second.excalidraw"));
        assert!(TcpStream::connect_timeout(&first_address, Duration::from_millis(200)).is_err());
        service.stop("workspace-1").unwrap();
        assert!(TcpStream::connect_timeout(&second_address, Duration::from_millis(200)).is_err());
        assert!(service
            .start_on("main", "127.0.0.1", 0, AppState::default(), None)
            .is_err());
    }
}
