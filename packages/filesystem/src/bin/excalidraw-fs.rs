use local_excalidraw_filesystem::{Result, WorkspaceError, WorkspaceFs};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{self, Read, Write};
use std::path::Path;

#[derive(Deserialize)]
#[serde(tag = "operation", rename_all = "snake_case", deny_unknown_fields)]
enum Request {
    List {
        path: Option<String>,
    },
    Read {
        path: String,
    },
    Save {
        path: String,
        content: String,
        expected_hash: Option<String>,
    },
}

fn execute() -> Result<Value> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.len() != 2 || args[0] != "--workspace" {
        return Err(WorkspaceError::new(
            "usage",
            "Use excalidraw-fs --workspace <directory>",
        ));
    }
    let fs = WorkspaceFs::open(Path::new(&args[1]))?;
    let mut input = String::new();
    io::stdin()
        .take(64 * 1024 * 1024 + 1)
        .read_to_string(&mut input)
        .map_err(|e| WorkspaceError::new("io", format!("Cannot read request: {e}")))?;
    if input.len() > 64 * 1024 * 1024 {
        return Err(WorkspaceError::new("size", "Request exceeds 64 MiB"));
    }
    let request: Request = serde_json::from_str(&input)
        .map_err(|e| WorkspaceError::new("invalid", format!("Invalid filesystem request: {e}")))?;
    match request {
        Request::List { path } => Ok(json!(fs.tree_at(path.as_deref())?)),
        Request::Read { path } => Ok(json!(fs.read(&path)?)),
        Request::Save {
            path,
            content,
            expected_hash,
        } => Ok(json!(fs.save(&path, &content, expected_hash.as_deref())?)),
    }
}

fn main() {
    let response = match execute() {
        Ok(value) => json!({ "ok": true, "value": value }),
        Err(error) => json!({ "ok": false, "error": error }),
    };
    if let Err(error) = writeln!(io::stdout().lock(), "{response}") {
        eprintln!("Cannot return filesystem result; re-read before retrying: {error}");
        std::process::exit(1);
    }
}
