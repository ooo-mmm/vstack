use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;

use crate::state::snapshot::DashboardSnapshot;

use super::rpc::{DaemonStatus, RpcRequest, RpcResponse};

#[derive(Debug, Error)]
pub enum ClientError {
    #[error("failed to connect daemon socket {path}: {source}", path = path.display())]
    Connect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("daemon socket io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("daemon JSON parse failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("daemon returned error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("daemon response missing result")]
    MissingResult,
    #[error("daemon socket already subscribed")]
    AlreadySubscribed,
    #[error("daemon subscription closed")]
    SubscriptionClosed,
    #[error("daemon subscription frame missing snapshot params")]
    MissingSnapshotParams,
}

pub struct DaemonClient {
    stream: Option<UnixStream>,
}

impl DaemonClient {
    pub async fn connect(socket: &Path) -> Result<Self, ClientError> {
        let stream = UnixStream::connect(socket)
            .await
            .map_err(|source| ClientError::Connect {
                path: socket.to_path_buf(),
                source,
            })?;
        Ok(Self {
            stream: Some(stream),
        })
    }

    pub async fn subscribe_snapshots(
        &mut self,
    ) -> Result<mpsc::UnboundedReceiver<Result<DashboardSnapshot, ClientError>>, ClientError> {
        let mut stream = self.stream.take().ok_or(ClientError::AlreadySubscribed)?;
        write_request(&mut stream, "subscribe_snapshots", None).await?;
        let (read_half, _) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let (tx, rx) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            let mut line = String::new();
            loop {
                line.clear();
                let result = match reader.read_line(&mut line).await {
                    Ok(0) => Err(ClientError::SubscriptionClosed),
                    Err(error) => Err(ClientError::Io(error)),
                    Ok(_) => decode_subscription_line(&line),
                };
                match result {
                    Ok(Some(snapshot)) => {
                        if tx.send(Ok(snapshot)).is_err() {
                            break;
                        }
                    }
                    Ok(None) => {}
                    Err(error) => {
                        let _ = tx.send(Err(error));
                        break;
                    }
                }
            }
        });
        Ok(rx)
    }

    pub async fn get_snapshot(&mut self) -> Result<DashboardSnapshot, ClientError> {
        request_response(self.stream_mut()?, "get_snapshot", None).await
    }

    pub async fn get_status(&mut self) -> Result<DaemonStatus, ClientError> {
        request_response(self.stream_mut()?, "get_status", None).await
    }

    pub async fn shutdown(&mut self) -> Result<(), ClientError> {
        let _: Value = request_response(self.stream_mut()?, "shutdown", None).await?;
        Ok(())
    }

    fn stream_mut(&mut self) -> Result<&mut UnixStream, ClientError> {
        self.stream.as_mut().ok_or(ClientError::AlreadySubscribed)
    }
}

fn decode_subscription_line(line: &str) -> Result<Option<DashboardSnapshot>, ClientError> {
    let value = serde_json::from_str::<Value>(line)?;
    if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
        return Err(ClientError::Rpc {
            code: error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default(),
            message: error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("daemon returned subscription error")
                .to_owned(),
        });
    }
    if value.get("method").and_then(Value::as_str) != Some("snapshot") {
        return Ok(None);
    }
    let params = value
        .get("params")
        .cloned()
        .ok_or(ClientError::MissingSnapshotParams)?;
    serde_json::from_value(params)
        .map(Some)
        .map_err(ClientError::Json)
}

async fn request_response<T>(
    stream: &mut UnixStream,
    method: &str,
    params: Option<Value>,
) -> Result<T, ClientError>
where
    T: DeserializeOwned,
{
    write_request(stream, method, params).await?;
    let mut line = String::new();
    let mut reader = BufReader::new(stream);
    reader.read_line(&mut line).await?;
    let response = serde_json::from_str::<RpcResponse>(&line)?;
    if let Some(error) = response.error {
        return Err(ClientError::Rpc {
            code: error.code,
            message: error.message,
        });
    }
    let result = response.result.ok_or(ClientError::MissingResult)?;
    serde_json::from_value(result).map_err(ClientError::Json)
}

async fn write_request(
    stream: &mut UnixStream,
    method: &str,
    params: Option<Value>,
) -> Result<(), ClientError> {
    let request = RpcRequest {
        jsonrpc: "2.0".to_owned(),
        id: Some(json!(1)),
        method: method.to_owned(),
        params,
    };
    let mut line = serde_json::to_vec(&request)?;
    line.push(b'\n');
    stream.write_all(&line).await?;
    Ok(())
}
