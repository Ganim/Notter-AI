# Release Process

Como publicar uma nova versão do Notter-AI com atualização automática.

## Setup inicial (já feito)

- Chaves de assinatura geradas em `~/.tauri/notter-ai.key` (privada) e `~/.tauri/notter-ai.key.pub` (pública)
- Chave pública embutida em `src-tauri/tauri.conf.json` no campo `plugins.updater.pubkey`
- Endpoint de atualização: `https://raw.githubusercontent.com/Ganim/Notter-AI/main/latest.json`

> **A chave privada (`~/.tauri/notter-ai.key`) NÃO pode ser perdida.** Se perder, ninguém mais consegue receber atualizações — todo mundo terá que reinstalar manualmente. Faça backup em local seguro.

## Publicando uma nova versão

### 1. Bumpar a versão

Atualize a versão **nos dois arquivos** para o mesmo valor (ex: `0.2.0`):

- `package.json` → campo `version`
- `src-tauri/tauri.conf.json` → campo `version`

### 2. Build assinado

Exporte o caminho da chave privada e rode o build:

```bash
export TAURI_SIGNING_PRIVATE_KEY="$HOME/.tauri/notter-ai.key"
export TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""
npm run tauri build
```

Isso vai gerar:

- `src-tauri/target/release/bundle/nsis/Notter-AI_<version>_x64-setup.exe` — instalador
- `src-tauri/target/release/bundle/nsis/Notter-AI_<version>_x64-setup.exe.sig` — arquivo de assinatura

### 3. Criar release no GitHub

```bash
gh release create v<version> \
  src-tauri/target/release/bundle/nsis/Notter-AI_<version>_x64-setup.exe \
  src-tauri/target/release/bundle/nsis/Notter-AI_<version>_x64-setup.exe.sig \
  --title "v<version>" \
  --notes "Release notes here"
```

### 4. Atualizar `latest.json`

Abra `latest.json` na raiz do repositório e atualize:

- `version`: nova versão
- `notes`: changelog resumido
- `pub_date`: data ISO 8601
- `platforms.windows-x86_64.signature`: conteúdo do arquivo `.sig` (cole o texto inteiro)
- `platforms.windows-x86_64.url`: URL do `.exe` no release do GitHub

Para ler o conteúdo do `.sig`:

```bash
cat src-tauri/target/release/bundle/nsis/Notter-AI_<version>_x64-setup.exe.sig
```

### 5. Commit do `latest.json`

```bash
git add latest.json
git commit -m "release: v<version>"
git push
```

Pronto. A partir desse momento, todos os usuários instalados verão a notificação ao clicar em "Verificar atualizações".

## Como o update funciona no app

1. Usuário clica em **Verificar atualizações** no menu
2. App busca `latest.json` no GitHub
3. Compara `version` com a versão local
4. Se houver versão maior → mostra dialog "Nova versão disponível"
5. Usuário clica **Instalar e reiniciar**
6. App baixa o `.exe`, valida a assinatura com a chave pública embutida
7. Instala silenciosamente e reinicia
