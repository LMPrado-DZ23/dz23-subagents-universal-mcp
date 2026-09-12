# Instalação e compatibilidade

## Local (caminho recomendado)

Node.js 22+ e acesso ao filesystem do computador do harness. Execute o instalador
Unix/PowerShell descrito no README. Ele testa o projeto e cria `.env` apenas se ausente.
Registre o servidor stdio com o executável Node e o caminho absoluto para
`src/index.js`, seguido de `--stdio`.

`node scripts/install-harness.mjs all` gera snippets Claude/Codex com caminhos reais.
O gerador não instala plugins no serviço hospedado, não reinicia hosts e não modifica
entradas MCP existentes. Revise e mescle apenas a entrada deste servidor.

Hermes e outros clientes: confirme o formato no host instalado. Use os mesmos
`command`/`args`; o nome da chave de transporte/configuração varia. O nome de um
cliente na documentação não comprova teste naquela aplicação.

## Memória compartilhada

No mesmo computador, configure o mesmo `DZ23_STATE_DIR` para os processos; no padrão
usa-se `~/.dz23-subagents`. Para máquinas diferentes, prefira uma única instância
remota. Compartilhamento de arquivos exige locks coerentes; sincronização eventual
bidirecional (copiar JSONs em ambas as direções) não é um mecanismo de coordenação.

O segundo harness chama `mission_status` e compara branch/commit/arquivos por conta
própria. O MCP não instala ou inicia automaticamente um harness alternativo.

## HTTP para uma equipe confiável

`npm run start:http` inicia em loopback por padrão. Use `DZ23_MCP_TOKEN` privado mesmo
localmente quando houver processos não confiáveis. Para bind `0.0.0.0`, o servidor
exige token de pelo menos 32 caracteres. Gere com um gerador criptográfico e guarde
em `.env`/ambiente; não coloque o valor em README, issue, comando compartilhado ou log.

Termine TLS em um reverse proxy controlado. Declare em `DZ23_ALLOWED_HOSTS` apenas
os hostnames realmente usados. Se um cliente enviar `Origin`, declare a origem
exata em `DZ23_ALLOWED_ORIGINS`; não há wildcard nem CORS aberto.

`/mcp` aceita POST JSON. Notificações recebem 202 sem corpo. GET/DELETE recebem 405;
a versão não implementa SSE, sessões retomáveis, OAuth ou usuário/tenant por chamada.
Tokens dão acesso à instância inteira: não compartilhar entre empresas não confiáveis.
Use rate limiting e limite de conexões no proxy. HTTP remoto é uma prévia de integração,
não uma certificação completa de conformidade MCP.

## Docker

Preencha o `.env` privado, inclusive `DZ23_MCP_TOKEN`, antes de `docker compose up --build -d`.
A porta publicada no compose é `127.0.0.1:8787`; o bind dentro do container é `0.0.0.0`
e portanto também exige token. O volume guarda a memória; nunca execute `down -v`
como etapa de atualização. Docker não foi executado no ambiente desta entrega.

## Clientes hospedados

ChatGPT web e outros serviços podem exigir integração remota, autenticação e
configurações específicas da conta. Um ZIP/servidor stdio não se instala dentro de
um modelo hospedado. Não habilite acesso público sem revisar os requisitos oficiais
atuais do cliente e uma camada de autenticação adequada.

## Smoke seguro

Use `initialize`, `tools/list`, `provider_inventory`, `project_init` e `mission_status`
primeiro: não invocam geração cloud. `discover_models` faz requisições de catálogo.
`health_check` gera texto e pode consumir créditos. Instalação sem provider acessível
pode passar o smoke MCP, mas não a delegação real.

Fontes oficiais de integração (consultadas em 2026-09-12):
- MCP transportes: https://modelcontextprotocol.io/specification/2025-06-18/basic/transports
- Codex MCP: https://developers.openai.com/codex/mcp/
