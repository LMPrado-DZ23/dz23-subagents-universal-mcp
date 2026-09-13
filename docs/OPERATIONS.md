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
| `doctor` | Node, configuração, escrita no estado, rotação (falha sem alvos elegíveis), HTTP, orçamento, integridade da memória (falha com registros corrompidos) | nenhuma |
| `config validate` | Resumo efetivo e problemas de configuração | nenhuma |
| `providers` | Inventário com status de catálogo/verificação persistido | nenhuma |
| `health --yes` | Uma geração por alvo elegível; sem `--yes` recusa com código 2 | **pode cobrar** |
| `missions list [--project <id>]` | Missões, status, sequência e objetivo resumido | nenhuma |
| `missions show <project> <mission>` | Estado, uso e eventos recentes | nenhuma |
| `memory repair [--project <id>]` | Inspeção e plano (dry run) | nenhuma |
| `memory repair --apply --yes` | Aplica apenas reparos seguros | nenhuma |
| `token hash` | SHA-256 de um token lido do stdin (mínimo 32 caracteres), para `DZ23_MCP_TOKENS_FILE` | nenhuma |

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
`DZ23_SHUTDOWN_GRACE_MS` (10 s) e então encerram. Em stdio, aguarda a mensagem em processamento.

Mensagens stdio são processadas uma por vez, na ordem de chegada: uma chamada longa (por exemplo
`swarm_run`) atrasa as seguintes. Use HTTP quando precisar de chamadas simultâneas.

## Atualizando de 2.2.x para 3.0.0

1. Faça backup de `.env` e do diretório de estado.
2. Leia as mudanças incompatíveis em `CHANGELOG.md`.
3. Rode `node src/index.js doctor` e `node src/index.js config validate`.
4. A memória 2.2.x é migrada na leitura e gravada como schema 2 na próxima escrita;
   versões anteriores do servidor não reconhecem o schema 2.
5. Provedores locais (`custom`, `lmstudio`, `vllm`) só ficam ativos com `<PREFIXO>_BASE_URL`,
   `<PREFIXO>_MODEL` ou chave definidos, ou quando `DZ23_ROTATION` os cita (nesse caso usam o endereço
   padrão); antes os endereços padrão bastavam.
6. Clientes REST: `health_check` passou a `POST /api/health` com `confirm_billable`, e detalhes de
   erro ficam em `error.details`.

## Referência de variáveis

Inteiros fora da faixa são ajustados ao limite com aviso; valores não numéricos e booleanos diferentes
de `true`/`false` são erro. Esta tabela cobre as variáveis sem outra documentação. Orçamento, rate
limit e limites de memória estão nas seções acima; estado, HTTP, autenticação e escopos em
`docs/INSTALL_ANY_HARNESS.md` e `docs/SECURITY_AND_SECRETS.md`; limites de ferramentas e fila em
`docs/TOOLS.md`. Todas aparecem com valor de exemplo em `.env.example`.

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

## Docker

`docker compose up --build -d` com `.env` privado contendo o token (ou secret montado com
`DZ23_MCP_TOKEN_FILE`, nunca os dois). O container roda como usuário não-root com código somente
leitura, sistema de arquivos read-only, volume `/state`, limites de memória/CPU/processos e
healthcheck autenticado e hostname fixo, para que um container recriado reconheça os próprios locks
(com apenas tokens com escopo, aponte `DZ23_HEALTHCHECK_TOKEN_FILE` para um
deles; `/healthz` não exige escopo). A porta é publicada só em `127.0.0.1`. Não use `docker compose down -v`
em atualizações: isso apaga a memória. Docker não foi executado no ambiente desta entrega.
