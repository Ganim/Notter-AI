// src-tauri/src/mcp/mod.rs
//
// Persistent MCP HTTP server (Phase 1 / M3 of the pivot). Boots as a Tokio
// task alongside Tauri main thread, binds 127.0.0.1:<dynamic>, exposes 6
// JSON-RPC 2.0 tools over MCP Streamable HTTP transport (single POST /mcp
// endpoint). Per-account Bearer auth; Supabase REST via reqwest using the
// front-end's rotating access token (front-end is sole refresh owner).
//
// See docs/superpowers/specs/2026-05-09-notter-pivot-phase1-design.md §6.
pub mod auth;
pub mod endpoint;
pub mod error;
pub mod server;
pub mod supabase;
pub mod tools;
pub mod types;

pub use error::McpError;
pub use server::{start_mcp_server, McpState, McpStateInner};
pub use types::{JsonRpcRequest, JsonRpcResponse};
