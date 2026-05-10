// src-tauri/src/mcp/types.rs
// JSON-RPC 2.0 envelope + tool argument/result types. Filled in Phase F + G.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Deserialize)]
pub struct JsonRpcRequest {
    #[allow(dead_code)]
    pub jsonrpc: String,
    pub id: Option<Value>, // null | number | string per JSON-RPC 2.0
    pub method: String,
    #[serde(default)]
    pub params: Value, // can be object, array, or null
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcResponse {
    pub jsonrpc: &'static str, // "2.0"
    pub id: Value,
    #[serde(flatten)]
    pub payload: JsonRpcPayload,
}

#[derive(Debug, Clone, Serialize)]
#[serde(untagged)]
pub enum JsonRpcPayload {
    Result { result: Value },
    Error { error: JsonRpcErrorObject },
}

#[derive(Debug, Clone, Serialize)]
pub struct JsonRpcErrorObject {
    pub code: i32,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

impl JsonRpcResponse {
    pub fn ok(id: Option<Value>, result: Value) -> Self {
        Self {
            jsonrpc: "2.0",
            id: id.unwrap_or(Value::Null),
            payload: JsonRpcPayload::Result { result },
        }
    }
    pub fn err(id: Option<Value>, code: i32, message: String) -> Self {
        Self {
            jsonrpc: "2.0",
            id: id.unwrap_or(Value::Null),
            payload: JsonRpcPayload::Error {
                error: JsonRpcErrorObject {
                    code,
                    message,
                    data: None,
                },
            },
        }
    }
}
