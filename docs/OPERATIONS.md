# Operação

## CLI

Execute na pasta de instalação (`node src/index.js <comando>`) ou pelo binário `dz23-subagents`.
Todos os comandos aceitam `--json`. Códigos de saída: `0` ok, `1` problemas encontrados,
`2` uso incorreto, `78` configuração inválida. Nenhum comando imprime valores de segredo.

| Comando | O que faz | Rede / custo |
| --- | --- | --- |
| `doctor` | Node, configuração, escrita no estado, rotação, HTTP, orçamento, integridade da memória | nenhuma |
| `config validate` | Resumo efetivo e problemas de configuração | nenhuma |
| `providers` | Inventário com status de catálogo/verificação persistido | nenhuma |
| `health --yes` | Uma geração por alvo elegível; sem `--yes` recusa com código 2 | **pode cobrar** |
| `missions list [--project <id>]` | Missões, status, sequência e objetivo resumido | nenhuma |
| `missions show <project> <mission>` | Estado, uso e eventos recentes | nenhuma |
| `memory repair [--project <id>]` | Inspeção e plano (dry run) | nenhuma |
| `memory repair --apply --yes` | Aplica apenas reparos seguros | nenhuma |
| `token hash` | SHA-256 de um token lido do stdin, para `DZ23_MCP_TOKENS_FILE` | nenhuma |

```bash
printf %s "$TOKEN" | node src/index.js token hash
```

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
- falhas de autenticação consomem pontos do endereço remoto e passam a receber 429.

Excesso retorna 429 com `Retry-After` antes de qualquer chamada a provider. A identidade é
`token:<id>` com token ou `ip:<endereço>` sem token (loopback). Um peso maior que a capacidade
nunca é admitido; `config validate` acusa esse erro.

## Orçamento

| Variável | Efeito |
| --- | --- |
| `DZ23_COST_POLICY` | `allow_unknown_cost` (padrão) ou `deny_unknown_cost` |
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
é `null`. Com limites de custo, prefira `deny_unknown_cost`, pois chamadas de custo desconhecido não
entram na soma. `config/examples/prices.example.json` traz apenas servidores locais com custo zero;
preços de nuvem devem vir das páginas oficiais dos fornecedores e ser revisados periodicamente.

## Memory locks

Um `lock_timeout` informa idade, motivo e dono (`pid`, `hostname`). O servidor remove sozinho
apenas locks velhos cujo dono comprovadamente terminou neste host. Para os demais:

1. Confirme que nenhum processo do DZ23 Subagents está escrevendo nesse diretório de estado
   (inclusive em outras máquinas que montem o mesmo volume).
2. Rode `node src/index.js memory repair --json` e leia o motivo reportado.
3. Faça backup do diretório de estado.
4. Só então remova manualmente o diretório `.lock` indicado. Nunca apague `state.json`,
   `journal.jsonl` ou checkpoints para "destravar".

`memory repair --apply --yes` também restaura `state.json` corrompido a partir do checkpoint
válido mais recente (o arquivo corrompido é renomeado para `state.json.corrupt-<data>`) e fecha
linhas incompletas do journal. `project.json` corrompido e arquivos `*.tmp` exigem ação manual.

## Shutdown

`SIGINT`/`SIGTERM` param de aceitar requisições, aguardam as em andamento por
`DZ23_SHUTDOWN_GRACE_MS` (10 s) e então encerram. Em stdio, aguarda a mensagem em processamento.

## Atualizando de 2.2.x

1. Faça backup de `.env` e do diretório de estado.
2. Leia as mudanças incompatíveis em `CHANGELOG.md`.
3. Rode `node src/index.js doctor` e `node src/index.js config validate`.
4. A memória 2.2.x é migrada na leitura e gravada como schema 2 na próxima escrita;
   versões anteriores do servidor não reconhecem o schema 2.

## Docker

`docker compose up --build -d` com `.env` privado contendo o token (ou secret montado com
`DZ23_MCP_TOKEN_FILE`, nunca os dois). O container roda como usuário não-root com código somente
leitura, sistema de arquivos read-only, volume `/state`, limites de memória/CPU/processos e
healthcheck autenticado. A porta é publicada só em `127.0.0.1`. Não use `docker compose down -v`
em atualizações: isso apaga a memória. Docker não foi executado no ambiente desta entrega.
