use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

// A normal HTTP document supplies the Referer that tauri:// pages cannot send.
// This listener serves only player HTML; it never reads files or exposes IPC.
pub(crate) struct EmbedServer {
    pub(crate) base: String,
    address: SocketAddr,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl EmbedServer {
    pub(crate) fn start() -> io::Result<Self> {
        let listener = TcpListener::bind(("127.0.0.1", 0))?;
        let address = listener.local_addr()?;
        let token_directory = tempfile::Builder::new()
            .prefix("youtube-")
            .rand_bytes(32)
            .tempdir()?;
        let token = token_directory
            .path()
            .file_name()
            .ok_or_else(|| io::Error::other("Cannot generate YouTube embed token"))?
            .to_string_lossy()
            .into_owned();
        token_directory.close()?;
        let base = format!("http://{address}/{token}");
        let stop = Arc::new(AtomicBool::new(false));
        let thread_stop = Arc::clone(&stop);
        let worker = thread::Builder::new()
            .name("youtube-embeds".into())
            .spawn(move || {
                for connection in listener.incoming() {
                    if thread_stop.load(Ordering::Acquire) {
                        break;
                    }
                    match connection {
                        Ok(mut stream) => {
                            if let Err(error) = serve(&mut stream, address, &token) {
                                eprintln!("Cannot serve YouTube player: {error}");
                            }
                        }
                        Err(error) => {
                            eprintln!("Cannot accept YouTube player connection: {error}");
                            break;
                        }
                    }
                }
            })?;
        Ok(Self {
            base,
            address,
            stop,
            thread: Some(worker),
        })
    }
}

impl Drop for EmbedServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        // Wake accept so a shutdown does not leave the listener alive.
        if let Err(error) = TcpStream::connect_timeout(&self.address, Duration::from_secs(1)) {
            eprintln!("Cannot wake YouTube player listener during shutdown: {error}");
        }
        if let Some(worker) = self.thread.take() {
            if worker.join().is_err() {
                eprintln!("YouTube player listener panicked during shutdown");
            }
        }
    }
}

fn serve(stream: &mut TcpStream, address: SocketAddr, token: &str) -> io::Result<()> {
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut buffer = [0; 8192];
    let mut length = 0;
    while length < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Player request timed out",
            ));
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
        _ => return respond(stream, "400 Bad Request", "Invalid request"),
    };
    let mut lines = request.split("\r\n");
    let first_line: Vec<_> = lines
        .next()
        .unwrap_or_default()
        .split_whitespace()
        .collect();
    if first_line.len() != 3 || first_line[2] != "HTTP/1.1" {
        return respond(stream, "400 Bad Request", "Invalid request");
    }
    if first_line[0] != "GET" {
        return respond(stream, "405 Method Not Allowed", "Only GET is supported");
    }
    let host = lines
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| name.eq_ignore_ascii_case("host").then(|| value.trim()));
    if host != Some(address.to_string().as_str()) {
        return respond(stream, "403 Forbidden", "Invalid host");
    }
    let Some(path) = first_line[1].strip_prefix(&format!("/{token}/")) else {
        return respond(stream, "404 Not Found", "Player not found");
    };
    let (id, query) = path.split_once('?').unwrap_or((path, ""));
    if id.len() != 11
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"_-".contains(&byte))
    {
        return respond(stream, "404 Not Found", "Invalid video ID");
    }
    let start = if query.is_empty() {
        0
    } else {
        match query.strip_prefix("start=").and_then(|value| {
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| value.parse::<u32>().ok())
                .flatten()
        }) {
            Some(start) => start,
            None => return respond(stream, "400 Bad Request", "Invalid start time"),
        }
    };
    let body = format!(
        r#"<!doctype html><html><head><meta name="referrer" content="strict-origin-when-cross-origin"><title>YouTube video player</title><style>html,body,iframe{{width:100%;height:100%;margin:0;border:0;overflow:hidden}}</style></head><body><iframe title="YouTube video player" src="https://www.youtube.com/embed/{id}?start={start}" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen></iframe></body></html>"#
    );
    respond(stream, "200 OK", &body)
}

fn respond(stream: &mut TcpStream, status: &str, body: &str) -> io::Result<()> {
    let response = format!(
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nReferrer-Policy: strict-origin-when-cross-origin\r\nContent-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; frame-src https://www.youtube.com; base-uri 'none'; form-action 'none'\r\n\r\n{body}",
        body.len()
    );
    stream.write_all(response.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(server: &EmbedServer, method: &str, path: &str, host: &str) -> String {
        let mut stream = TcpStream::connect(server.address).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        write!(stream, "{method} {path} HTTP/1.1\r\nHost: {host}\r\n\r\n").unwrap();
        let mut response = String::new();
        stream.read_to_string(&mut response).unwrap();
        response
    }

    fn path(server: &EmbedServer, video: &str) -> String {
        let url = tauri::Url::parse(&server.base).unwrap();
        format!("{}/{video}", url.path())
    }

    #[test]
    fn serves_only_player_html_with_a_normal_http_referrer() {
        let server = EmbedServer::start().unwrap();
        assert!(server.address.ip().is_loopback());
        let response = request(
            &server,
            "GET",
            &path(&server, "QkdkLdMBuL0?start=90"),
            &server.address.to_string(),
        );
        assert!(response.starts_with("HTTP/1.1 200 OK"));
        assert!(response.contains("src=\"https://www.youtube.com/embed/QkdkLdMBuL0?start=90\""));
        assert!(response.contains("Referrer-Policy: strict-origin-when-cross-origin"));
        assert!(response.contains("Cache-Control: no-store"));
        assert!(!response.contains("__TAURI"));
        assert_eq!(
            response,
            request(
                &server,
                "GET",
                &path(&server, "QkdkLdMBuL0?start=90"),
                &server.address.to_string()
            )
        );
    }

    #[test]
    fn rejects_other_hosts_methods_paths_and_injected_parameters() {
        let server = EmbedServer::start().unwrap();
        let host = server.address.to_string();
        let valid = path(&server, "QkdkLdMBuL0");
        for (method, path, host, status) in [
            ("GET", valid.clone(), "evil.example".to_string(), "403"),
            ("POST", valid, host.clone(), "405"),
            (
                "GET",
                "/wrong-token/QkdkLdMBuL0".to_string(),
                host.clone(),
                "404",
            ),
            ("GET", path(&server, "../README.md"), host.clone(), "404"),
            ("GET", path(&server, ""), host.clone(), "404"),
            ("GET", path(&server, "<script>"), host.clone(), "404"),
            (
                "GET",
                path(&server, "QkdkLdMBuL0?start="),
                host.clone(),
                "400",
            ),
            (
                "GET",
                path(&server, "QkdkLdMBuL0?start=-1"),
                host.clone(),
                "400",
            ),
            (
                "GET",
                path(&server, "QkdkLdMBuL0?start=4294967296"),
                host.clone(),
                "400",
            ),
            (
                "GET",
                path(&server, "QkdkLdMBuL0?start=1&src=https://evil.example"),
                host.clone(),
                "400",
            ),
        ] {
            let response = request(&server, method, &path, &host);
            assert!(
                response.starts_with(&format!("HTTP/1.1 {status}")),
                "{response}"
            );
        }
    }

    #[test]
    fn serves_concurrent_players_and_releases_the_port_on_shutdown() {
        let server = Arc::new(EmbedServer::start().unwrap());
        let other = EmbedServer::start().unwrap();
        assert_ne!(server.base, other.base);
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let server = Arc::clone(&server);
                thread::spawn(move || {
                    request(
                        &server,
                        "GET",
                        &path(&server, "QkdkLdMBuL0"),
                        &server.address.to_string(),
                    )
                })
            })
            .collect();
        for worker in workers {
            assert!(worker.join().unwrap().starts_with("HTTP/1.1 200 OK"));
        }
        let address = server.address;
        drop(server);
        assert!(TcpStream::connect(address).is_err());
    }
}
