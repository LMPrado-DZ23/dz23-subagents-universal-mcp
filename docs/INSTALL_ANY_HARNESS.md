# Instalação e compatibilidade

## Local (caminho recomendado)

Node.js 22+ e acesso ao filesystem do computador do harness. Execute o instalador
Unix/PowerShell descrito no README. Ele testa o projeto e cria `.env` apenas se ausente.
Registre o servidor stdio com o executável Node e o caminho absoluto para
`src/index.js`, seguido de `--stdio`.

`node scripts/install-harness.mjs all` gera snippets Claude/Codex com caminhos reais.
O gerador não instala plugins no serviço hospedado, não reinicia hosts e não modifica
entradas MCP existentes. Revise e mescle apenas a entrada deste servidor.

Depois de configurar, rode `node src/index.js doctor` e `node src/index.js config validate`.
Nenhum dos dois chama providers.

Hermes e outros clientes: confirme o formato no host instalado. Use os mesmos
`command`/`args`; o nome da chave de transporte/configuração varia. O nome de um
cliente na documentação não comprova teste naquela aplicação.

## Protocolo

O servidor implementa ferramentas (tools) nas revisões MCP **2025-11-25** e **2025-06-18**.
Clientes que pedem outra revisão datada recebem 2025-11-25 como contraproposta e decidem se
continuam. Não há resources, prompts, sampling, elicitation, tasks, batching ou notificações
do servidor.

## Memória compartilhada

No mesmo computador, configure o mesmo `DZ23_STATE_DIR` para os processos; no padrão
usa-se `~/.dz23-subagents`. Para máquinas diferentes, prefira uma única instância
remota. Compartilhamento de arquivos exige locks coerentes; sincronização eventual
bidirecional (copiar JSONs em ambas as direções) não é um mecanismo de coordenação.

O segundo harness chama `mission_status` e compara branch/commit/arquivos por conta
própria. O MCP não instala ou inicia automaticamente um harness alternativo.

## HTTP para uma equipe confiável

`DZ23_ALLOW_HTTP=true npm run start:http` inicia em loopback por padrão.

- **Autenticação**: `DZ23_MCP_TOKEN` ou `DZ23_MCP_TOKEN_FILE` (nunca os dois). Fora de loopback
  o token precisa ter 32+ caracteres. Gere com um gerador criptográfico e mantenha fora de README,
  issues, comandos compartilhados e logs.
- **Escopos por cliente**: `DZ23_AUTH_MODE=scoped` e `DZ23_MCP_TOKENS_FILE` com digests SHA-256
  (veja `config/examples/scoped-tokens.example.json` e docs/SECURITY_AND_SECRETS.md).
- **TLS** no reverse proxy. Declare em `DZ23_ALLOWED_HOSTS` só os hostnames usados. Se um cliente
  enviar `Origin`, declare a origem exata em `DZ23_ALLOWED_ORIGINS`; não há wildcard.
- **Limites**: rate limit por identidade/ferramenta com 429 e `Retry-After`, corpo máximo,
  timeout de leitura, requisições em andamento (503) e shutdown gracioso (docs/OPERATIONS.md).

`/mcp` aceita POST JSON. Envie `MCP-Protocol-Version` depois do `initialize`; valores não
suportados recebem 400. Notificações recebem 202 sem corpo. GET/DELETE recebem 405: não há SSE,
sessões retomáveis ou OAuth. Tokens dão acesso à instância; não compartilhe entre empresas não
confiáveis. HTTP remoto é uma prévia de integração, não uma certificação de conformidade MCP.

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

Use `doctor`, `initialize`, `tools/list`, `provider_inventory`, `project_init` e `mission_status`
primeiro: não invocam geração. `discover_models` faz requisições de catálogo. `health_check`,
`verify_model` e `health --yes` geram texto e podem consumir créditos. Instalação sem provider
acessível pode passar o smoke MCP, mas não a delegação real.

Fontes oficiais de integração (consultadas em 2026-09-13):
- MCP transportes: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- MCP changelog 2025-11-25: https://modelcontextprotocol.io/specification/2025-11-25/changelog
- Codex MCP: https://developers.openai.com/codex/mcp/
