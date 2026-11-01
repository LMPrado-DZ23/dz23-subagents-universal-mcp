# Começar em 60 segundos

Três caminhos. Escolha o que combina com você.

## 1. Direto do repositório (sem instalar nada)

```bash
git clone https://github.com/LMPrado-DZ23/dz23-subagents-universal-mcp
cd dz23-subagents-universal-mcp
cp .env.example .env
# edite o .env com pelo menos uma chave ou um provedor genérico
node src/index.js doctor
```

`doctor` diz o que está configurado, o que está sem chave e qual rotação está ativa.

## 2. Publicado no npm (quando a release estiver no ar)

```bash
npx @dz23/subagents-universal-mcp doctor
npx @dz23/subagents-universal-mcp --stdio
```

## 3. Docker

```bash
docker compose up -d
curl -s localhost:8787/health
```

## O `.env` mínimo

Qualquer uma destas três formas liga o roteador:

```env
# (a) provedor do catálogo, com chave
OPENROUTER_API_KEY=sk-or-...
DZ23_ROTATION=openrouter:openrouter/auto

# (b) qualquer API, sem editar código
DZ23_PROVIDERS=minhaapi
DZ23_MINHAAPI_BASE_URL=https://api.exemplo.com/v1
DZ23_MINHAAPI_API_KEY=sk-...
DZ23_MINHAAPI_MODEL=modelo-padrao
DZ23_ROTATION=minhaapi:modelo-padrao

# (c) servidor local (Ollama, vLLM, LM Studio), sem chave
DZ23_PROVIDERS=local
DZ23_LOCAL_BASE_URL=http://127.0.0.1:11434/v1
DZ23_LOCAL_TIER=local
DZ23_LOCAL_MODEL=qwen3-coder
DZ23_ROTATION=local:qwen3-coder
```

## Ligar no harness

**Claude Desktop / Claude Code** (`claude_desktop_config.json` ou `.mcp.json`):

```json
{
  "mcpServers": {
    "dz23-subagents": {
      "command": "node",
      "args": ["C:\\caminho\\dz23-subagents-universal-mcp\\src\\index.js", "--stdio"],
      "env": { "DZ23_ROTATION": "minhaapi:modelo-padrao" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.dz23-subagents]
command = "node"
args = ["C:\\caminho\\dz23-subagents-universal-mcp\\src\\index.js", "--stdio"]
```

**DeepSeek Harness** — row `mcp-client` no patch do perfil apontando para o mesmo comando.

## Primeira chamada útil

```text
1. providers            → o que está ligado
2. discover_models      → modelos reais de cada provedor
3. verify_model         → confirma que o alvo responde (confirm_billable: true)
4. mission_start        → abre a missão com estado persistido
```

## Se algo não subir

| Sintoma | Causa provável |
|---|---|
| `Generic provider "x" needs DZ23_X_BASE_URL` | faltou a URL no `.env` |
| `Unknown provider: y` | `y` não está no catálogo nem em `DZ23_PROVIDERS` |
| `must use HTTPS` | HTTP só vale para loopback/rede privada (`TIER=local` ou `DZ23_PRIVATE_HOSTS`) |
| `doctor` mostra 0 provedores | nenhuma chave preenchida — provedor sem chave não liga |
