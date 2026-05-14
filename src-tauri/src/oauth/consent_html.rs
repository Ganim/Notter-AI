// src-tauri/src/oauth/consent_html.rs
use super::AccountSummary;

pub fn render(
    client_name: &str,
    accounts: &[AccountSummary],
    client_id: &str,
    redirect_uri: &str,
    code_challenge: &str,
    state: &str,
    scope: &str,
) -> String {
    let account_rows: String = accounts.iter().map(|a| format!(
        r#"<label class="row"><input type="radio" name="account_id" value="{}" required /> <span>{}</span> <span class="email">{}</span></label>"#,
        html_escape(&a.account_id),
        html_escape(&a.display_name),
        html_escape(&a.email),
    )).collect();

    format!(r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Authorize {client_name}</title>
<style>
  body{{font:14px/1.4 system-ui;margin:40px;max-width:520px}}
  h1{{font-size:18px}}
  .row{{display:block;padding:8px;border:1px solid #ddd;border-radius:6px;margin:6px 0;cursor:pointer}}
  .row input{{margin-right:8px}}
  .email{{color:#666;margin-left:8px}}
  .scope{{background:#f3f3f3;padding:8px;border-radius:4px;font-family:ui-monospace;margin:12px 0}}
  button{{padding:8px 14px;border-radius:6px;border:0;background:#0a64ff;color:#fff;font-weight:600;cursor:pointer}}
  button.cancel{{background:#eee;color:#222;margin-left:8px}}
</style></head>
<body>
<h1>Authorize <em>{client_name}</em> to access your Notter account</h1>
<form method="post" action="/authorize">
  <input type="hidden" name="client_id" value="{client_id}">
  <input type="hidden" name="redirect_uri" value="{redirect_uri}">
  <input type="hidden" name="code_challenge" value="{code_challenge}">
  <input type="hidden" name="code_challenge_method" value="S256">
  <input type="hidden" name="state" value="{state}">
  <input type="hidden" name="scope" value="{scope}">
  <p>Choose the account to authorize:</p>
  {account_rows}
  <p>Scope:</p>
  <div class="scope">{scope}</div>
  <button type="submit">Authorize</button>
  <button class="cancel" type="submit" name="deny" value="1">Cancel</button>
</form>
</body></html>
"#,
        client_name = html_escape(client_name),
        client_id = html_escape(client_id),
        redirect_uri = html_escape(redirect_uri),
        code_challenge = html_escape(code_challenge),
        state = html_escape(state),
        scope = html_escape(scope),
        account_rows = account_rows,
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
     .replace('"', "&quot;").replace('\'', "&#39;")
}
