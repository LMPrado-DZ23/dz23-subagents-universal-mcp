# Instalação e compatibilidade

## Local (caminho recomendado)

Node.js 22+ e acesso ao filesystem do computador do harness. Na pasta extraída:

- Linux/macOS: `bash scripts/install-local.sh`
- Windows: `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` (o parâmetro vale
  só para esse processo; a política padrão do Windows costuma bloquear scripts baixados)

O instalador cria `.env` apenas se ausente, roda `npm run check` e `npm test` e chama
`node scripts/install-harness.mjs all`, que grava em `config/generated/`, com os caminhos reais do
Node e de `src/index.js`:

| Arquivo | Uso |
| --- | --- |
| `claude_code_add_command.txt` | Comando `claude mcp add` do Claude Code (escopo de usuário) |
| `codex_config.snippet.toml` | Tabela `[mcp_servers.dz23-subagents]` do Codex, com timeouts |
| `claude_desktop_config.snippet.json` | Entrada `mcpServers` (Claude Desktop e clientes com o mesmo formato) |

O gerador nunca modifica a configuração de um harness, não instala plugins e não reinicia hosts.
Depois de editar o `.env`, rode `node src/index.js config validate` e `node src/index.js doctor`;
nenhum dos dois chama providers. Para atualizar uma instalação existente, siga o roteiro em
[docs/OPERATIONS.md](OPERATIONS.md#atualizando-de-22x300-para-400).

## Claude Code

Registre no escopo de usuário, para que todos os projetos usem a mesma instância e memória:

```bash
claude mcp add -s user dz23-subagents -- "/caminho/node" "/caminho/dz23-subagents/src/index.js" --stdio
claude mcp get dz23-subagents
```

O comando pronto está em `config/generated/claude_code_add_command.txt`. Ao atualizar ou trocar de
pasta, rode antes `claude mcp get dz23-subagents` e anote o Environment: `claude mcp remove` apaga essas
variáveis. Depois `claude mcp remove -s user dz23-subagents` e o novo `add`, com `-e CHAVE=VALOR` para cada
variável que deve continuar no harness (ou mova-as para o `.env` da instalação). Não mantenha duas
entradas apontando para versões diferentes. `claude mcp get` deve mostrar o Node e o `src/index.js`
da pasta nova.

`swarm_run` e `consensus` podem levar minutos. No Claude Code, o timeout de ferramentas MCP vem da
variável `MCP_TOOL_TIMEOUT` (milissegundos, por exemplo `900000`) no ambiente em que o Claude Code é
iniciado; mantenha-o acima de `DZ23_DELEGATE_DEADLINE_MS`. No PowerShell, quando `claude` é um shim
`.ps1` do npm, o `--` do comando pode precisar de aspas (`'--'`) ou de `--%`; isso não foi verificado
em todas as instalações.

## Codex

Edite `~/.codex/config.toml` (`%USERPROFILE%\.codex\config.toml` no Windows). **Substitua** a tabela
`[mcp_servers.dz23-subagents]` existente pelo conteúdo de `config/generated/codex_config.snippet.toml`;
nunca acrescente uma segunda tabela com o mesmo nome (tabela duplicada é TOML inválido).

```toml
[mcp_servers.dz23-subagents]
command = "/caminho/node"
args = ["/caminho/dz23-subagents/src/index.js", "--stdio"]
startup_timeout_sec = 30
tool_timeout_sec = 900
```

`swarm_run` e `consensus` podem levar minutos; com um timeout de ferramenta curto o cliente desiste
enquanto o servidor continua a chamada. Mantenha `DZ23_DELEGATE_DEADLINE_MS` (padrão 600 000 ms)
abaixo de `tool_timeout_sec`.

## Outros clientes MCP (stdio)

Use o executável Node com os argumentos `["<pasta>/src/index.js", "--stdio"]`
(`config/examples/generic-mcp.json`). O nome das chaves (`command`, `args`, transporte, timeout)
varia por cliente: confirme o formato no host instalado e configure um timeout de ferramenta de pelo
menos 15 minutos quando houver essa opção. Se o cliente já tiver uma entrada `dz23-subagents`,
substitua-a. Hermes: [HERMES_SELF_INSTALL_PROMPT.txt](../HERMES_SELF_INSTALL_PROMPT.txt). O nome de
um cliente na documentação não comprova teste naquela aplicação.

## Protocolo

O servidor implementa ferramentas (tools) nas revisões MCP **2025-11-25** e **2025-06-18**.
Clientes que pedem outra revisão datada recebem 2025-11-25 como contraproposta e decidem se
continuam. Em stdio até `DZ23_STDIO_MAX_INFLIGHT` (8) requisições rodam em paralelo, e
`notifications/cancelled` com `params.requestId` interrompe a chamada correspondente (nenhuma
resposta é enviada para ela). Não há resources, prompts, sampling, elicitation, tasks, batching ou
notificações enviadas pelo servidor.

## Memória compartilhada

No mesmo computador, configure o mesmo `DZ23_STATE_DIR` para os processos; no padrão
usa-se `~/.dz23-subagents` (`~\` também é expandido no Windows). Para máquinas diferentes, prefira
uma única instância remota. Compartilhamento de arquivos exige locks coerentes; sincronização
eventual bidirecional (copiar JSONs em ambas as direções) não é um mecanismo de coordenação.
Todos os processos que usam o mesmo diretório devem rodar a mesma versão do servidor.

Com `DZ23_SHARED_COOLDOWNS=true` (padrão), cooldowns transitórios de provider (rate limit, quota,
indisponibilidade, timeout) ficam em `<estado>/providers/status.json`: Claude Code, Codex e Hermes pulam
um alvo que outro processo acabou de ver falhar. Falhas de autenticação ou de modelo continuam
restritas ao processo que as viu.

O segundo harness chama `mission_status` com os mesmos `project_id`/`mission_id` e compara
branch/commit/arquivos por conta própria. O MCP não instala ou inicia automaticamente um harness
alternativo.

## HTTP para uma equipe confiável

`DZ23_ALLOW_HTTP=true npm run start:http` inicia em loopback por padrão e **exige autenticação**.

- **Autenticação**: `DZ23_MCP_TOKEN_FILE` ou `DZ23_MCP_TOKEN` (nunca os dois), com 32+ caracteres,
  ou tokens com escopo. Sem nenhum deles `--http` não inicia (código 78), mesmo em loopback. Só para
  teste local, `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true` libera loopback sem token (`doctor`
  avisa); fora de loopback o token continua obrigatório. Gere tokens com um gerador criptográfico e
  mantenha-os fora de README, issues, comandos compartilhados e logs.
- **Escopos por cliente**: `DZ23_AUTH_MODE=scoped` e `DZ23_MCP_TOKENS_FILE` com digests SHA-256
  (veja `config/examples/scoped-tokens.example.json` e docs/SECURITY_AND_SECRETS.md).
- **TLS** no reverse proxy. Declare em `DZ23_ALLOWED_HOSTS` só os hostnames usados. Se um cliente
  enviar `Origin`, declare a origem exata em `DZ23_ALLOWED_ORIGINS`; não há wildcard.
- **Limites**: rate limit por identidade/ferramenta com 429 e `Retry-After`, corpo máximo,
  timeout de leitura, requisições em andamento (503) e shutdown gracioso (docs/OPERATIONS.md).

`/mcp` aceita POST JSON. Envie `MCP-Protocol-Version` depois do `initialize`; valores não
suportados recebem 400. Notificações recebem 202 sem corpo. GET/DELETE recebem 405: não há SSE,
sessões retomáveis ou OAuth. Se o cliente desconectar, a chamada em andamento é abortada.
REST: `GET /api/discover` devolve apenas o cache; `GET /api/discover?refresh=true` recebe 405 — para
consultar os catálogos use `POST /api/discover` com `{"provider": "...", "refresh": true}`
(`provider` opcional). Tokens dão acesso à instância; não compartilhe entre empresas não confiáveis.
HTTP remoto é uma prévia de integração, não uma certificação de conformidade MCP.

## Docker

Preencha o `.env` privado (ou monte `DZ23_MCP_TOKEN_FILE`) antes de `docker compose up --build -d`.
A porta publicada é `127.0.0.1:8787`; dentro do container o bind é `0.0.0.0` e exige token.
O volume guarda a memória; nunca execute `down -v` como etapa de atualização. Docker não foi
executado no ambiente desta entrega.

## Clientes hospedados

ChatGPT web e outros serviços podem exigir integração remota, autenticação e
configurações específicas da conta. Um servidor stdio não se instala dentro de
um modelo hospedado. Não habilite acesso público sem revisar os requisitos oficiais
atuais do cliente e uma camada de autenticação adequada.

## Smoke seguro

Use `doctor`, `initialize`, `tools/list`, `provider_inventory`, `list_models`, `project_init` e
`mission_status` primeiro: não invocam geração. `discover_models` faz requisições de catálogo.
`health_check`, `verify_model` e `health --yes` geram texto e podem consumir créditos. Instalação sem
provider acessível pode passar o smoke MCP, mas não a delegação real.

Fontes oficiais de integração (consultadas em 2026-09-13):
- MCP transportes: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP changelog 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- Codex MCP: https://developers.openai.com/codex/mcp/
