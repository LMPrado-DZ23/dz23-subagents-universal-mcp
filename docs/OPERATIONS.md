# Operação

## CLI

Execute na pasta de instalação (`node src/index.js <comando>`) ou pelo binário `dz23-subagents`.
Todos os comandos aceitam `--json`. Códigos de saída: `0` ok, `1` problemas encontrados,
`2` uso incorreto, `78` configuração inválida. Nenhum comando imprime valores de segredo.
Com `--json`, erros também saem em stdout como `{"error": {"code", "message"}}`.

Sem argumentos (ou apenas `--stdio`/`--http`) o binário inicia o servidor; qualquer outro argumento
é um comando, então um erro de digitação falha com código 2 em vez de abrir o servidor stdio. O
servidor recusa iniciar (código 78) quando `config validate` aponta erro, por exemplo booleano
inválido ou `DZ23_ROUTING_POLICY` desconhecida.

| Comando | O que faz | Rede / custo |
| --- | --- | --- |
| `doctor` | Node, configuração, escrita no estado, rotação, alvos (falha sem alvo elegível), política de custo, credenciais genéricas ignoradas, HTTP (falha sem autenticação), orçamento, integridade da memória (falha com registros corrompidos) | nenhuma |
| `config validate` | Resumo efetivo (inclui `free_models`, `allow_generic_credentials`, `shared_cooldowns`, `delegate_deadline_ms`, `stdio_max_inflight`) e problemas de configuração | nenhuma |
| `providers` | Inventário com tier e status de catálogo/verificação persistido | nenhuma |
| `health --yes` | Uma geração por alvo elegível; sem `--yes` recusa com código 2 | **pode cobrar** |
| `missions list [--project <id>]` | Missões, status, sequência e objetivo resumido | nenhuma |
| `missions show <project> <mission>` | Estado, uso e eventos recentes | nenhuma |
| `memory repair [--project <id>]` | Inspeção e plano (dry run) | nenhuma |
| `memory repair --apply --yes` | Aplica apenas reparos seguros | nenhuma |
| `token hash` | SHA-256 de um token lido do stdin (mínimo 32 caracteres), para `DZ23_MCP_TOKENS_FILE` | nenhuma |

```bash
printf %s "$TOKEN" | node src/index.js token hash
```

Checagens de `doctor` ligadas a roteamento (saída de texto; `--json` traz `{name, status, detail}`):

```text
PASS  targets: custom:qwen3-coder local eligible; ollama:gpt-oss:120b mixed skipped(mixed_not_allowed)
WARN  cost_policy: skipped by cost policy: ollama:gpt-oss:120b (mixed_not_allowed); add a model to DZ23_FREE_MODELS only if it is really free for your account, or set DZ23_ALLOW_PAID=true to allow billed targets
WARN  generic_credentials: ignored generic credential(s): github (env:GITHUB_TOKEN); set the specific variable (GITHUB_MODELS_TOKEN), name the provider in DZ23_ROTATION or set DZ23_ALLOW_GENERIC_CREDENTIALS=true
```

- `targets` lista cada entrada de `DZ23_ROTATION` (ou, sem rotação, o modelo padrão de cada provider
  habilitado) como `provider:modelo tier eligible|skipped(motivo)`; falha quando nenhuma é elegível.
  Motivos: `missing_credential`, `local_endpoint_not_configured`, `missing_base_url`, `missing_model`,
  `paid_not_allowed`, `mixed_not_allowed`.
- `cost_policy` avisa quando algum alvo foi pulado por `paid_not_allowed` ou `mixed_not_allowed`.
- `generic_credentials` avisa quando `GITHUB_TOKEN`, `HF_TOKEN` ou `CLOUDFLARE_AUTH_TOKEN` existem mas
  foram ignorados; mostra só nomes de variáveis.
- `http` falha quando `DZ23_ALLOW_HTTP=true` sem token nem tokens com escopo e sem
  `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true`; com essa opção, avisa. `config validate` reporta o
  mesmo caso como erro em `DZ23_MCP_TOKEN`.
- Avisos não mudam o código de saída.

## Logs

JSON Lines em stderr (stdout fica reservado ao protocolo stdio). Nível por `DZ23_LOG_LEVEL`
(`error`, `warn`, `info`, `debug`; padrão `info`). Campos comuns: `ts`, `level`, `event`,
`request_id`, `project_id`, `mission_id`, `provider`, `model`, `duration_ms`, `status`, `kind`.

Eventos principais: `server_started`, `tool_call_completed`, `provider_call_completed`,
`provider_call_failed`, `provider_failover`, `budget_denied`, `health_check_target`,
`model_verification`, `swarm_started`, `swarm_completed`, `rate_limited`, `http_unauthorized`,
`rpc_internal_error`, `config_issue`, `memory_lock_recovered`, `journal_recovered`,
`shutdown_started`, `shutdown_completed`.

A redação remove chaves sensíveis (`authorization`, `api_key`, `token`, `prompt`, `content`,
`messages`, `headers`, `body` e similares), mascara padrões conhecidos de credencial e os valores
literais das chaves/tokens configurados. Prompts, respostas e corpos de erro não são registrados.
Ainda assim, trate logs como dados operacionais privados.

## Métricas

`GET /metrics` (HTTP, escopo `admin:inventory`) devolve um snapshot JSON do processo:
contadores (`tool_calls_total`, `delegations_total`, `provider_failures_total`,
`provider_retries_total`, `failovers_total`, `rate_limit_rejections_total`,
`http_rejections_total`, `context_truncations_total`, `tokens_total`,
`estimated_cost_usd_total`, `unknown_cost_calls_total`, `usage_records_total`,
`budget_denials_total`), resumos de latência (`provider_latency_ms`, `http_request_duration_ms`),
latência EWMA por alvo e gauges (`active_calls`, `queue_depth`, `provider_cooldowns`,
`http_inflight`). Não há formato Prometheus nem agregação entre processos.

## Rate limiting HTTP

Buckets em memória por processo, recarregados continuamente na janela
`DZ23_RATE_LIMIT_WINDOW_MS` (60 s):

- identidade: `DZ23_RATE_LIMIT_POINTS` (120) — cada requisição consome 1 ponto;
- identidade + ferramenta: `DZ23_RATE_LIMIT_TOOL_POINTS` (60);
- concorrência de ferramentas não leves por identidade: `DZ23_RATE_LIMIT_CONCURRENT` (4);
- pesos (`DZ23_RATE_LIMIT_WEIGHTS`): `light:1`, `discovery:3`, `moderate:5` (delegate),
  `billable:10` (health_check, verify_model), `expensive:15` (consensus), `very_expensive:30` (swarm_run);
- só tentativas com token inválido consomem pontos do endereço remoto (peso `moderate`); esgotado o
  bucket, novas tentativas inválidas recebem 429. Um token válido nunca é bloqueado pelas falhas de
  outro cliente no mesmo endereço. Com `--http`, `DZ23_MCP_TOKEN` precisa ter 32+ caracteres
  (senão o servidor HTTP não inicia; em stdio é só um aviso), o que torna inviável adivinhar o token.
- conexões que não entregam os headers da primeira requisição em `DZ23_HTTP_HEADERS_TIMEOUT_MS` (10 s)
  são fechadas, e respostas a requisições não autenticadas encerram a conexão. Não há
  limite de conexões por endereço: fora de loopback, aplique esse limite no proxy reverso.

Excesso retorna 429 com `Retry-After` antes de qualquer chamada a provider. A identidade é
`token:<id>` com token ou `ip:<endereço>` sem token (loopback). Um peso maior que a capacidade
nunca é admitido; `config validate` acusa esse erro.

Quando o número de chaves chega ao limite, buckets totalmente recarregados são descartados primeiro;
buckets esgotados são mantidos, para que inundar chaves novas não zere o próprio limite.

O Host é conferido pelo header `Host`, nunca pela URL absoluta da requisição. Requisições de
navegador marcadas como cross-site (`Sec-Fetch-Site`) sem `Origin` permitida recebem 403.
Ferramentas faturáveis só existem por `POST` (`/api/health` exige `{"confirm_billable": true}`),
então um link ou imagem em outra página não dispara cobrança.

## Orçamento

| Variável | Efeito |
| --- | --- |
| `DZ23_COST_POLICY` | `allow_unknown_cost` ou `deny_unknown_cost`. Padrão: `deny_unknown_cost` quando algum limite de custo está definido, senão `allow_unknown_cost` |
| `DZ23_PRICES_FILE` / `DZ23_PRICES` | Tabela `provider:model` ou `provider:*` com preço por milhão de tokens |
| `DZ23_MAX_CALL_COST_USD` | Custo estimado máximo por chamada; o alvo é pulado |
| `DZ23_MAX_MISSION_COST_USD`, `DZ23_MAX_PROJECT_COST_USD`, `DZ23_MAX_DAILY_COST_USD` | Custo acumulado conhecido |
| `DZ23_MAX_MISSION_TOKENS`, `DZ23_MAX_MISSION_CALLS` | Tokens e chamadas (incluindo retries) por missão |
| `DZ23_MAX_INPUT_TOKENS` | Entrada estimada máxima por chamada |

Antes de cada tentativa a entrada é estimada (~4 caracteres por token) e somada ao máximo de
saída. Se um limite acumulado já foi atingido, nenhuma chamada ocorre. Negativas específicas do
alvo (`unknown_cost`, `call_cost_limit`, `*_cost_limit`) fazem failover para outro alvo.
`health_check` e `verify_model` contam no limite diário e por chamada.

Cada chamada gera um registro com `input_tokens`, `output_tokens`, `total_tokens`,
`token_source` (`provider`, `estimated`, `none`), `estimated_cost_usd` e `cost_source`
(`provider_usage`, `configured_price`, `unknown`). Preços nunca são inventados: sem tabela, o custo
é `null`. Com limites de custo o padrão já é `deny_unknown_cost`, pois chamadas de custo desconhecido
não entram na soma; optar explicitamente por `allow_unknown_cost` faz `doctor` avisar. `config/examples/prices.example.json` traz apenas servidores locais com custo zero;
preços de nuvem devem vir das páginas oficiais dos fornecedores e ser revisados periodicamente.

## Memory locks

Um `lock_timeout` informa idade e motivo. `pid` e `hostname` do dono aparecem apenas em
`memory repair`, para o operador, e nunca para clientes da ferramenta. O servidor remove sozinho
apenas locks velhos cujo dono comprovadamente terminou neste host (processo inexistente ou lock
criado antes do último boot, ou com o PID deste processo mas outro horário de início, como o PID 1
de um container reiniciado) ou, sem metadados de dono, com mais que o dobro de
`DZ23_LOCK_STALE_MS`. Para os demais:

1. Confirme que nenhum processo do DZ23 Subagents está escrevendo nesse diretório de estado
   (inclusive em outras máquinas que montem o mesmo volume).
2. Rode `node src/index.js memory repair --json` e leia o motivo reportado.
3. Faça backup do diretório de estado.
4. Só então remova manualmente o diretório `.lock` indicado. Nunca apague `state.json`,
   `journal.jsonl` ou checkpoints para "destravar".

`memory repair --apply --yes` também restaura `state.json` corrompido a partir do checkpoint
válido mais recente (o arquivo corrompido é renomeado para `state.json.corrupt-<data>`) e fecha
linhas incompletas do journal. `project.json` corrompido e arquivos `*.tmp` exigem ação manual.
Registros gravados por uma versão mais nova (schema maior) nunca são restaurados de checkpoint:
atualize o servidor.

Limites de tamanho: `DZ23_MAX_CHECKPOINT_LIST_ITEMS` (500 itens por lista) e
`DZ23_MAX_STATE_BYTES` (4 MiB por missão).

## Shutdown

`SIGINT`/`SIGTERM` param de aceitar requisições, aguardam as em andamento por
`DZ23_SHUTDOWN_GRACE_MS` (10 s) e então encerram. Em stdio, aguarda as mensagens em processamento.

Em stdio até `DZ23_STDIO_MAX_INFLIGHT` (8) requisições rodam ao mesmo tempo; acima disso aguardam na
ordem de chegada. `ping` e notificações nunca esperam atrás de um `swarm_run` longo.
`notifications/cancelled` com `params.requestId` aborta a chamada correspondente, sem resposta. Em HTTP,
a desconexão do cliente aborta a chamada. `delegate`, `consensus` e `swarm_run` têm prazo total
`DZ23_DELEGATE_DEADLINE_MS` (erros `cancelled` e `deadline_exceeded`, docs/TOOLS.md).

## Atualizando de 2.2.x/3.0.0 para 4.0.0

Vale para 2.2.x e 3.0.0: os passos e a revisão de variáveis são os mesmos. Os comandos são para
Windows (PowerShell). Cenário comum: duas instalações, uma registrada no Claude Code e outra no Codex.
Elas podem ter `.env`, variáveis no próprio harness e diretórios de estado **diferentes**; descubra isso
antes de mudar qualquer coisa. Servidores de versões diferentes não devem rodar ao mesmo tempo sobre o
mesmo diretório de estado: atualize as duas antes de reabrir qualquer harness.

0. **Levante a configuração atual** (só leitura):

   ```powershell
   claude mcp get dz23-subagents   # anote Command, Args e Environment
   Select-String -Path "$env:USERPROFILE\.codex\config.toml" -Pattern 'dz23-subagents' -Context 0,8
   Select-String -Path "C:\caminho\instalacao-antiga\.env" -Pattern '^DZ23_(STATE_DIR|ROTATION|ROUTING_POLICY|ALLOW_PAID|FREE_MODELS)='
   ```

   Para cada instalação, o valor efetivo de uma variável é, nesta ordem: o ambiente do harness
   (Environment do `claude mcp get`, `env` na tabela do Codex) > o `.env` da instalação > o padrão. O
   diretório de estado padrão é `~\.dz23-subagents`; uma instalação pode usar outro (por exemplo
   `~\.codex\state\dz23-subagents`). Missões de um diretório não aparecem no outro.

1. **Pare tudo.** Feche Claude Code, Codex, Hermes e outros clientes. Encerre só os processos do DZ23
   Subagents (outros servidores MCP também rodam `src\index.js`):

   ```powershell
   Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
     Where-Object { $_.CommandLine -like '*DZ23-Subagents*' -or $_.CommandLine -like '*dz23-subagents-universal-mcp*' } |
     Select-Object ProcessId, CommandLine
   Stop-Process -Id <PID>
   ```

2. **Backup completo**: todos os diretórios de estado encontrados no passo 0, os `.env`, a configuração
   do Codex e a do Claude Code.

   ```powershell
   $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
   $bk = "$env:USERPROFILE\dz23-upgrade-backup-$stamp"
   New-Item -ItemType Directory $bk | Out-Null
   Copy-Item -Recurse "$env:USERPROFILE\.dz23-subagents" "$bk\state-default"
   Copy-Item -Recurse "$env:USERPROFILE\.codex\state\dz23-subagents" "$bk\state-codex"   # só se existir
   Copy-Item "C:\caminho\instalacao-claude\.env" "$bk\claude.env"
   Copy-Item "C:\caminho\instalacao-codex\.env" "$bk\codex.env"
   Copy-Item "$env:USERPROFILE\.codex\config.toml" "$bk\config.toml"
   Copy-Item "$env:USERPROFILE\.claude.json" "$bk\claude.json"
   claude mcp get dz23-subagents > "$bk\claude-mcp-get.txt"
   ```

   O backup contém chaves e configurações privadas: mantenha-o só neste computador.

3. **Extraia a 4.0.0 em uma pasta nova** (nunca sobre a antiga) e copie um `.env` antigo para ela.
   O `.env.example` da 4.0.0 lista todos os provedores cadastrados (chave vazia) e todas as variáveis
   suportadas; use-o para conferir nomes.

   ```powershell
   Copy-Item "C:\caminho\instalacao-antiga\.env" "C:\caminho\dz23-subagents-4.0.0\.env"
   ```

   Uma única pasta 4.0.0 pode atender os dois harnesses.

4. **Escolha um diretório de estado e revise variáveis** (no `.env` e no ambiente dos harnesses):
   - Defina `DZ23_STATE_DIR` explicitamente com o mesmo valor para os dois harnesses. Para trazer
     missões do outro diretório, copie as pastas `projects\<projeto>` que ainda não existem no destino,
     com os harnesses fechados; projetos com o mesmo nome não são mesclados.
   - `DZ23_ROUTING_POLICY=ordered` (2.2.x) vira `rotation-order`. A 4.0.0 ainda aceita `ordered` com
     aviso, mas outro valor desconhecido impede o servidor de iniciar (código 78).
   - Variáveis que estavam no Environment do Claude Code (por exemplo `DZ23_ROTATION`) **não** passam
     para a entrada nova sozinhas: leve-as para o `.env` ou reinclua com `-e` no passo 6. Sem isso, a
     rotação do `.env` passa a valer.
   - Alvos `mixed` (modelos cloud do `ollama`, `openrouter/auto`, `mistral`, `together`, `gemini`...)
     ficam bloqueados sem `DZ23_ALLOW_PAID=true`. Declare em `DZ23_FREE_MODELS=ollama:glm-5.3-flash,...`
     só modelos realmente gratuitos na sua conta. O sufixo `:free` só conta no OpenRouter. Modelos
     `:cloud`/`-cloud` servidos por um adapter local (por exemplo `custom:deepseek-v4-flash:cloud` via
     Ollama) rodam na nuvem e contam como `mixed`.
   - `low-cost` e `paid` (por exemplo `deepseek:deepseek-chat`) são pulados sem `DZ23_ALLOW_PAID=true`.
   - Credenciais genéricas só habilitam o provider quando `DZ23_ROTATION` o cita ou com
     `DZ23_ALLOW_GENERIC_CREDENTIALS=true`: `GITHUB_TOKEN` (use `GITHUB_MODELS_TOKEN`), `HF_TOKEN` (use
     `HUGGINGFACE_TOKEN`), `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_AUTH_TOKEN` (use
     `CLOUDFLARE_WORKERS_AI_TOKEN`).
   - Provedores de nuvem só aceitam sobrescrever endpoint e modelo com prefixo:
     `DZ23_<PROVIDER>_BASE_URL`/`_MODEL` (`OPENAI_BASE_URL`, `OLLAMA_BASE_URL`, `GROQ_MODEL`... são
     ignorados). Os adapters locais mantêm `CUSTOM_BASE_URL`, `LMSTUDIO_BASE_URL`, `VLLM_BASE_URL` e
     `*_MODEL`.
   - `http://` só vale para IP de loopback ou privado, `localhost`, `host.docker.internal` ou host listado
     em `DZ23_PRIVATE_HOSTS` (por exemplo `ollama` num compose); o restante exige `https://`.
   - Com `DZ23_ALLOW_HTTP=true`, configure `DZ23_MCP_TOKEN_FILE` (ou `DZ23_MCP_TOKEN`, 32+ caracteres),
     mesmo em loopback.

5. **Valide sem chamar providers, com o mesmo ambiente que o harness vai usar**, na pasta nova:

   ```powershell
   cd C:\caminho\dz23-subagents-4.0.0
   $env:DZ23_ROTATION = '<valor que ficará no harness>'   # só se a variável ficar no harness
   node src\index.js config validate
   node src\index.js doctor
   $env:DZ23_ROTATION = $null
   ```

   `doctor` deve mostrar `PASS  targets` com ao menos um alvo `eligible` e diz se a rotação veio de
   `DZ23_ROTATION`. Leia os avisos `cost_policy` e `generic_credentials`; `providers` mostra as colunas
   `ELIGIBLE` e `NOTE`.

6. **Substitua as entradas dos dois harnesses** (nunca acrescente uma segunda). Gere os arquivos com
   `powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1` (roda check e testes) ou só
   `node scripts\install-harness.mjs all`:
   - Claude Code: `claude mcp remove -s user dz23-subagents`, depois o comando de
     `config\generated\claude_code_add_command.txt`, acrescentando `-e CHAVE=VALOR` para cada variável
     que você decidiu manter no harness (por exemplo `claude mcp add -s user -e DZ23_ROTATION=... dz23-subagents -- ...`).
     Confira com `claude mcp get dz23-subagents`.
   - Codex: em `%USERPROFILE%\.codex\config.toml`, troque a tabela `[mcp_servers.dz23-subagents]` pelo
     conteúdo de `config\generated\codex_config.snippet.toml` (inclui `startup_timeout_sec = 30` e
     `tool_timeout_sec = 900`). Se a tabela antiga tinha `env`, mantenha a linha com os valores revisados.

7. **Reinicie e faça uma checagem barata.** Abra um harness e chame `list_models` e `mission_status`
   com uma missão existente (nenhum dos dois gera texto). Repita no outro harness e só então delegue.

Para voltar à versão anterior, com os harnesses fechados:

```powershell
Copy-Item "$bk\config.toml" "$env:USERPROFILE\.codex\config.toml" -Force
claude mcp remove -s user dz23-subagents   # depois recrie a entrada antiga com os dados de $bk\claude-mcp-get.txt
Rename-Item "$env:USERPROFILE\.dz23-subagents" ".dz23-subagents-4.0.0-$stamp"
Copy-Item -Recurse "$bk\state-default" "$env:USERPROFILE\.dz23-subagents"
```

Faça o mesmo com os outros diretórios de estado copiados no passo 2 e restaure os `.env` antigos nas
pastas antigas.

Mudanças que já valiam na 3.0.0 (para quem vem da 2.2.x): a memória é migrada na leitura e gravada
como schema 2 na próxima escrita; providers locais (`custom`, `lmstudio`, `vllm`) só ficam ativos com
`BASE_URL`, `MODEL` ou chave definidos, ou quando `DZ23_ROTATION` os cita; `health_check` pela REST é
`POST /api/health` com `confirm_billable`, e detalhes de erro ficam em `error.details`. Leia
`CHANGELOG.md`.

## Referência de variáveis

Inteiros fora da faixa são ajustados ao limite com aviso; valores não numéricos e booleanos diferentes
de `true`/`false` são erro. Esta tabela cobre as variáveis sem outra documentação. Orçamento, rate
limit e limites de memória estão nas seções acima; estado, HTTP, autenticação e escopos em
`docs/INSTALL_ANY_HARNESS.md` e `docs/SECURITY_AND_SECRETS.md`; limites de ferramentas e fila em
`docs/TOOLS.md`; retries (`DZ23_MAX_RETRIES`, `DZ23_RETRY_BASE_DELAY_MS`, `DZ23_RETRY_AFTER_CAP_MS`) em
`docs/PROVIDER_ARCHITECTURE.md`; `DZ23_MEMORY_FSYNC` em `docs/ARCHITECTURE.md`. `.env.example` lista
todas as chaves dos provedores cadastrados e todas as variáveis suportadas, sem valores.

`memory repair --json` informa `apply_requested` (se `--apply` foi usado) e `applied` (se algum reparo
foi de fato feito).

| Variável | Padrão | Faixa | Efeito |
| --- | --- | --- | --- |
| `DZ23_HTTP_HOST` | `127.0.0.1` | — | Endereço do HTTP; fora de loopback exige token de 32+ caracteres ou tokens com escopo |
| `DZ23_HTTP_PORT` | `8787` | 0–65535 | Porta do HTTP |
| `DZ23_HTTP_MAX_BODY_BYTES` | `1048576` | 16 384–8 388 608 | Corpo máximo (413) |
| `DZ23_HTTP_BODY_TIMEOUT_MS` | `10000` | 500–120 000 | Tempo para receber o corpo (408) |
| `DZ23_HTTP_HEADERS_TIMEOUT_MS` | `10000` | 1000–60 000 | Tempo para os headers; também fecha conexões que não completam a primeira requisição |
| `DZ23_HTTP_MAX_INFLIGHT` | `32` | 1–1024 | Requisições simultâneas (503) |
| `DZ23_HTTP_MAX_CONNECTIONS` | `128` | 1–10 000 | Conexões TCP simultâneas |
| `DZ23_HTTP_SOCKET_TIMEOUT_MS` | `900000` | 10 000–3 600 000 | Inatividade máxima de uma conexão já em uso |
| `DZ23_RATE_LIMIT_ENABLED` | `true` | — | Liga o rate limit HTTP |
| `DZ23_MAX_CONCURRENCY` | `7` | 1–8 | Chamadas a providers em paralelo no processo; padrão de workers do `swarm_run` |
| `DZ23_MAX_WORKERS_PER_TARGET` | `4` | 1–7 | Chamadas simultâneas por `provider:model` |
| `DZ23_PROVIDER_TIMEOUT_MS` | `90000` | 1000–600 000 | Timeout de cada chamada de delegação |
| `DZ23_HEALTH_TIMEOUT_MS` | `15000` | 1000–120 000 | Timeout de `health_check` por alvo |
| `DZ23_MAX_OUTPUT_TOKENS` | `4096` | 64–4096 | Máximo de tokens de saída pedidos ao provider |
| `DZ23_MAX_RESPONSE_BYTES` | `2097152` | 65 536–4 194 304 | Resposta máxima aceita de um provider |
| `DZ23_MAX_CONTEXT_CHARS` | `60000` | 10 000–120 000 | Contexto de missão enviado aos workers |
| `DZ23_MAX_STORED_OUTPUT_CHARS` | `12000` | 1000–24 000 | Caracteres guardados por resposta de agente |
| `DZ23_MAX_AGENT_OUTPUTS` | `16` | 1–32 | Respostas de agentes mantidas por missão |
| `DZ23_MAX_JOURNAL_BYTES` | `1048576` | 65 536–4 194 304 | Tamanho do journal antes da rotação |
| `DZ23_MAX_CHECKPOINTS` | `8` | 1–16 | Checkpoints mantidos por missão |
| `DZ23_LOCK_TIMEOUT_MS` | `20000` | 1000–120 000 | Espera máxima por um lock de memória |
| `DZ23_MAX_STDIO_FRAME_BYTES` | `524288` | 65 536–2 097 152 | Mensagem stdio máxima |
| `DZ23_STDIO_MAX_INFLIGHT` | `8` | 1–64 | Requisições stdio processadas ao mesmo tempo; até 256 esperam na fila, acima disso `-32003 Server busy` |
| `DZ23_DELEGATE_DEADLINE_MS` | `600000` | 10 000–3 600 000 | Prazo total de `delegate`, `consensus` e `swarm_run` (`deadline_exceeded`) |
| `DZ23_SHARED_COOLDOWNS` | `true` | — | Persiste cooldowns transitórios (rate limit, quota, indisponibilidade, timeout) em `<estado>/providers/status.json`, compartilhados entre processos |
| `DZ23_FREE_MODELS` | vazio | — | Lista `provider:modelo` de alvos `mixed` que o operador declara gratuitos |
| `DZ23_PRIVATE_HOSTS` | vazio | — | Hostnames tratados como rede privada (além de IPs privados, `localhost` e `host.docker.internal`) |
| `DZ23_ALLOW_GENERIC_CREDENTIALS` | `false` | — | Aceita `GITHUB_TOKEN`, `HF_TOKEN`, `CLOUDFLARE_API_TOKEN` e `CLOUDFLARE_AUTH_TOKEN` sem citar o provider na rotação |
| `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP` | `false` | — | Permite `--http` em loopback sem token (apenas teste local) |

## Docker

`docker compose up --build -d` com `.env` privado contendo o token (ou secret montado com
`DZ23_MCP_TOKEN_FILE`, nunca os dois). O container roda como usuário não-root com código somente
leitura, sistema de arquivos read-only, volume `/state`, limites de memória/CPU/processos e
healthcheck autenticado e hostname fixo, para que um container recriado reconheça os próprios locks
(com apenas tokens com escopo, aponte `DZ23_HEALTHCHECK_TOKEN_FILE` para um
deles; `/healthz` não exige escopo). A porta é publicada só em `127.0.0.1`. Não use `docker compose down -v`
em atualizações: isso apaga a memória. Docker não foi executado no ambiente desta entrega.
