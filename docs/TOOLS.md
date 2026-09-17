# As onze ferramentas

Todas as ferramentas publicam `inputSchema` fechado (`additionalProperties: false`) e o
servidor aplica esse mesmo schema antes de executar qualquer coisa, em stdio, HTTP `/mcp`
e REST `/api/*`. Limites de texto são configuráveis e nunca ilimitados
(`DZ23_MAX_PROMPT_CHARS`, padrão 32 000; `DZ23_MAX_GOAL_CHARS`, padrão 8 000).

| Ferramenta | Entrada principal | Efeito | Escopo HTTP | Custo |
| --- | --- | --- | --- | --- |
| `list_models` | `{}` | Alvos elegíveis, capabilities do adapter e do catálogo, verificação | `provider:discover` | sem rede |
| `provider_inventory` | `{}` | Registro, origem da credencial e flags de estado; nunca valores | `admin:inventory` | sem rede |
| `discover_models` | `provider`, `refresh` | Consulta `/models` só de providers habilitados (cache de 5 min) e persiste o resultado; provider desabilitado devolve lista vazia | `provider:discover` | rede, sem inferência |
| `health_check` | `confirm_billable: true` | Uma geração mínima por alvo elegível | `health:execute` | **pode cobrar** |
| `verify_model` | `target`, `confirm_billable: true` | Uma geração mínima em `provider:model` | `health:execute` | **pode cobrar** |
| `project_init` | `project_id`, `workspace`, `repository`, `branch` | Cria/atualiza metadados | `memory:write` | local |
| `mission_status` | `project_id`, `mission_id`, `events_limit`, `include_outputs` | Estado, eventos recentes e integridade do journal | `memory:read` | local |
| `memory_checkpoint` | IDs e campos estruturados | Checkpoint de handoff; cria a missão se ausente | `memory:write` | local |
| `delegate` | `prompt`, IDs, `role`, `target` | Uma resposta textual com retry/failover | `delegate:execute` + `memory:write` | **pode cobrar** |
| `consensus` | `prompt`, `models` (2–5), roteamento, `synthesis` | Revisores em alvos distintos e síntese | `delegate:execute` + `memory:write` | **pode cobrar** |
| `swarm_run` | `goal`, `roles`, `max_agents`, roteamento, `response_mode` | Especialistas em paralelo e um revisor integrador | `delegate:execute` + `memory:write` | **pode cobrar** |

Em stdio não há escopos: a instância é um único domínio de confiança. `project_id`
organiza memória e nunca autentica ou autoriza.

`delegate`, `consensus` e `swarm_run` aceitam IDs opcionais: sem `project_id` usam o projeto
`default`; sem `mission_id` geram um UUID, devolvido no resultado. **Reutilize o `project_id` e o
`mission_id` usados em `project_init` e `memory_checkpoint`**: omiti-los grava no projeto `default`
e numa missão aleatória, que outro harness não encontra. IDs que diferem de um existente
apenas por maiúsculas/minúsculas são recusados (`invalid_request`) quando o diretório de estado fica
em sistema de arquivos que não diferencia maiúsculas (Windows, macOS), porque ali seriam a mesma
pasta. Em sistemas que diferenciam (Linux), esses IDs continuam sendo registros distintos.

## Argumentos e erros

- IDs: 1–120 letras, dígitos, `.`, `_` ou `-`, começando por letra ou dígito. Não podem terminar
  em `.` nem ser nomes de dispositivo reservados do Windows (`CON`, `PRN`, `AUX`, `NUL`,
  `COM0`–`COM9`, `LPT0`–`LPT9`), com ou sem extensão (por exemplo `nul.txt`); esses casos falham com
  `invalid_request`.
- Reutilize os mesmos `project_id` e `mission_id` em `project_init`, `memory_checkpoint`, `delegate`,
  `consensus`, `swarm_run` e `mission_status`. Nas ferramentas de trabalho, omitir os IDs grava no
  projeto `default` e numa missão aleatória que o checkpoint e o status não encontram.
- `discover_models.cache_only` (padrão `false`): devolve só catálogos em cache, sem contatar providers.
- `target`: `auto` ou `provider:model` (o modelo pode conter `:`). `verify_model` recusa `auto`.
- `role`: `worker`, `architect`, `backend`, `frontend`, `security`, `qa`, `devops`, `reviewer`.
  `swarm_run.roles` não aceita `worker`.
- `memory_checkpoint`: `next_action`, `status` (`active`, `partial`, `blocked`, `paused`, `done`,
  `completed`, `failed`, `cancelled`), `summary`, `goal`, listas (`acceptance_criteria`,
  `decisions`, `invariants`, tarefas, arquivos, `known_failures`, `artifacts`), `tests`
  (`passed`/`failed`/`pending`) e `merge` (`append`, padrão, ou `replace`). Status omitido
  mantém o atual. Cada lista guarda no máximo `DZ23_MAX_CHECKPOINT_LIST_ITEMS` itens (500, os mais
  recentes) e o estado inteiro no máximo `DZ23_MAX_STATE_BYTES` (4 MiB; acima disso
  `memory_limit_exceeded`). A resposta é um resumo (`sequence`, `status`, `next_action`, contagens
  por lista, mais `truncated_lists` quando itens antigos foram descartados); o estado completo vem
  de `mission_status`.
- `mission_status.state` é `null` quando a missão não existe. Sem `include_outputs: true` (padrão
  `false`), cada resposta de agente guardada vem resumida como
  `{role, provider, model, at, chars, preview}` (`preview` com até 400 caracteres), e `last_output`
  é encurtado da mesma forma. Use `include_outputs: true` só quando precisar do texto completo.
- `delegate` devolve a resposta do provider mesmo quando a gravação posterior na memória da missão
  falha; nesse caso o resultado traz `memory_warnings` com textos `<etapa>:<código>` (por exemplo
  `usage:lock_timeout`, `agent_result:memory_write_failed`, `event:...`, `handoff:...`) e a resposta
  pode não aparecer em `mission_status`. `swarm_run` e `consensus` juntam no nível superior todos os
  `memory_warnings` da chamada (os próprios, como `swarm_status:...` e `handoff:...`, e os de cada
  worker, revisor ou síntese).
- `swarm_run.response_mode`: `summary` (padrão) devolve cada worker como
  `{ok, role, provider, model, output_chars, excerpt, usage, failed_attempts, budget_denials?, code?, error?}`
  (`excerpt` com até 600 caracteres) mais a resposta completa do revisor integrador; `full` devolve as
  respostas completas dos workers, como antes.
- `swarm_run` e `consensus` interrompidos por cancelamento ou prazo **depois** que os workers
  terminaram devolvem o que já foi pago, com `stopped: "cancelled"` ou `"deadline_exceeded"`, e não
  iniciam o revisor integrador nem a síntese por modelo. `delegate` interrompido falha com o erro.
- `delegate`, `consensus` e `swarm_run` nunca alteram `status`, `next_action` ou `goal` de uma
  missão existente: esses campos pertencem ao harness. Eles gravam `last_tool_handoff`
  (ferramenta, alvo, horário, dica) e, no swarm, `swarm_run` durante a execução e `swarm_last_run`
  ao final.

Argumento inválido gera JSON-RPC `-32602` com `data.field` e `data.reason`, sem ecoar o valor.
Clientes que negociaram 2025-11-25 recebem o mesmo conteúdo como erro de execução
(`isError: true`, `code: invalid_arguments`), conforme SEP-1303 dessa revisão; ajuste com
`DZ23_TOOL_ARGUMENT_ERRORS=auto|jsonrpc|tool_result`.

Falhas esperadas de execução retornam `isError: true` e
`structuredContent.error = {code, message, request_id, details?}`:

| `code` | Quando | HTTP REST |
| --- | --- | --- |
| `invalid_arguments` | Argumentos fora do schema (clientes 2025-11-25 ou `DZ23_TOOL_ARGUMENT_ERRORS=tool_result`) | 400 |
| `invalid_request` | Provider recusou a requisição; não há failover. Também IDs inválidos | 400 |
| `context_too_large` | Todos os alvos elegíveis recusaram a entrada como grande demais; reduza o prompt ou use uma missão com menos contexto | 413 |
| `input_too_large` | Tokens estimados acima de `DZ23_MAX_INPUT_TOKENS` | 413 |
| `target_not_allowed` | Alvo recusado; `details.reason` diz o motivo (por exemplo `unknown_provider`, `not_in_rotation`, `model_not_allowed`) | 403 |
| `mission_not_found` | Missão inexistente para a operação | 404 |
| `diversity_unavailable` | `strict_diversity` sem alvos suficientes | 409 |
| `budget_exceeded` | Limite de orçamento ou política de custo | 402 |
| `all_providers_failed` | Todos os candidatos falharam (tentativas classificadas em `details`) | 502 |
| `no_providers` | Nenhum alvo elegível ou todos em cooldown | 503 |
| `lock_timeout`, `memory_write_failed` | Memória ocupada | 503 |
| `queue_full` | Fila de delegação cheia (`DZ23_MAX_QUEUE`) | 503 |
| `memory_limit_exceeded` | O checkpoint deixaria o estado acima de `DZ23_MAX_STATE_BYTES` | 413 |
| `memory_integrity` | JSON corrompido ou schema não suportado | 500 |
| `cancelled` | O cliente cancelou (`notifications/cancelled` em stdio, desconexão em HTTP); nenhuma resposta é enviada ao cliente que cancelou | 499 |
| `deadline_exceeded` | `delegate`, `consensus` ou `swarm_run` passou de `DZ23_DELEGATE_DEADLINE_MS` (padrão 10 min) | 504 |

Resultados de sucesso têm `content[0].text` com o JSON compacto (sem indentação) e
`structuredContent` sempre objeto (listas como `{items}`).

## Cancelamento e prazo

Em stdio, `notifications/cancelled` com `params.requestId` aborta a chamada em andamento com esse id,
incluindo as requisições aos providers, e o servidor não envia resposta para ela. Em HTTP, a
desconexão do cliente tem o mesmo efeito. `delegate`, `consensus` e `swarm_run` têm um prazo total
(`DZ23_DELEGATE_DEADLINE_MS`, 10 000–3 600 000 ms); ao estourar, a chamada termina com
`deadline_exceeded`. Configure o timeout de ferramenta do cliente acima desse prazo (no Codex,
`tool_timeout_sec = 900`; no Claude Code, `MCP_TOOL_TIMEOUT`).

- Uma requisição stdio cancelada enquanto espera vaga nunca é executada.
- Até 256 requisições esperam vaga; acima disso o servidor responde JSON-RPC `-32003 Server busy`
  (`data.reason: stdio_queue_full`).
- Uma requisição que repete o `id` de outra ainda em andamento recebe `-32600 Invalid Request`
  (`data.reason: duplicate in-flight id`).
- SIGINT/SIGTERM abortam as chamadas stdio em andamento; o fim do stdin (EOF) deixa as pendentes
  terminarem e responderem.
- Uma chamada cancelada ou com timeout depois de enviada ao provider é registrada no orçamento pela
  reserva (entrada estimada + máximo de saída; custo estimado quando há preço), com
  `token_source: "reserved_estimate"`: cancelar não burla limites.

Na REST (`/api/*`) e nos erros de transporte HTTP o corpo de erro é sempre
`{"error": {"code", "message", "request_id", "details"?}}`. `health_check` pela REST é
`POST /api/health` com `{"confirm_billable": true}`; `GET /api/health` responde 405. `GET /api/discover`
devolve apenas o cache e nunca contata providers, mesmo com cache vazio; `?refresh=true` responde 405 — use `POST /api/discover` com
`{"provider": "...", "refresh": true}` (`provider` opcional). Resultados em lista
na REST (por exemplo `POST /api/health`) vêm como array JSON, sem o envelope `{items}` do MCP.

## Roteamento (`consensus` e `swarm_run`)

| Campo | Padrão | Significado |
| --- | --- | --- |
| `routing_strategy` | `first` no swarm, `round_robin` no consensus | `first`, `round_robin`, `provider_diversity`, `model_diversity`, `cost_optimized`, `latency_optimized` |
| `min_distinct_providers` / `min_distinct_models` | — | Amplia o plano quando possível; senão emite aviso |
| `strict_diversity` | `false` | Falha antes de qualquer chamada se a diversidade pedida não puder ser planejada |
| `avoid_reviewer_target` (swarm) | `false` | Revisor integrador fora dos alvos usados pelos workers, quando houver |
| `synthesis` (consensus) | `heuristic` | `none`, `heuristic` (sem chamada extra) ou `model` (uma chamada a mais) |

O resultado inclui `routing` com `requested_strategy`, `effective_strategy`,
`planned_distinct_providers/models`, `distinct_providers/models` observados e `warnings`.
Diversidade nunca é prometida: failover pode convergir para o mesmo provider e isso é
reportado. `cost_optimized` usa apenas preços configurados; `latency_optimized` usa a média
exponencial das chamadas bem-sucedidas deste processo.

`consensus` nunca repete o mesmo alvo para simular independência. A síntese heurística lista
afirmações comuns, possíveis contradições e alegações de execução não verificadas, sempre com
aviso de que concordância entre modelos não é verdade objetiva. `possible_divergences` aponta
afirmações com muitas palavras em comum mas termos-chave diferentes (por exemplo "usar Postgres" e
"usar Redis"), números diferentes ("30 segundos" e "90 segundos"), comparações invertidas ("Postgres em
vez de Redis" e o contrário) e sufixos que mudam o sentido ("server" e "serverless"); quando existem,
`agreement` nunca é `high`. `agreement.method` é `lexical_overlap`: sobreposição de palavras, não
compreensão semântica.

O revisor integrador do `swarm_run` e a síntese `model` do `consensus` recebem as respostas desta
execução no próprio prompt (até cerca de 24 mil caracteres no total), em vez de depender só da memória
da missão. Cada resposta vai entre marcadores com um nonce aleatório e o prompt avisa que o conteúdo
é dado, não instrução. Quando alguma resposta é cortada, `routing.warnings` informa.

Exemplo de `swarm_run`:

```json
{
  "project_id": "loja-demo",
  "mission_id": "m-001",
  "goal": "Propor uma API de catálogo, tela de listagem e testes. Não alegar execução.",
  "roles": ["backend", "frontend", "qa"],
  "max_agents": 3,
  "routing_strategy": "provider_diversity",
  "avoid_reviewer_target": true
}
```

## Verificação e capabilities

`provider_inventory.status_flags` separa `configured`, `credential_present`,
`credential_required`, `catalog_discovered` e `inference_verified`. `verify_model` nunca roda
sozinho, não faz retry nem failover, respeita a política de custo e grava
`last_verified_at`, `last_success_at`, latência e o último tipo de erro.

A categoria de custo é declarada por provider, não por modelo. Sem `DZ23_ALLOW_PAID=true`, alvos
`paid`/`low-cost` são recusados e alvos `mixed` só rodam listados em `DZ23_FREE_MODELS` ou, no
OpenRouter, com id terminado em `:free` (docs/SECURITY_AND_SECRETS.md). Sem `DZ23_ROTATION`, um
`target` explícito só usa o modelo padrão do provider, a menos que `DZ23_ALLOW_PAID=true`. A exceção
são providers locais cujo endereço é privado: IPs de loopback e privados, `localhost`,
`host.docker.internal` e hosts listados em `DZ23_PRIVATE_HOSTS` (nomes sem ponto e `.local` não contam
sozinhos). Um `CUSTOM_BASE_URL` público não conta e torna o provider `mixed`; modelos `:cloud`/`-cloud`
servidos por adapter local também são `mixed`. Com
rotação, `delegate`, `consensus` e `swarm_run` só aceitam alvos da rotação. `verify_model` serve para
testar um modelo antes de incluí-lo: aceita alvos fora da rotação, mas nesse caso aplica a regra do
modelo padrão e recusa com `details.reason: model_not_allowed`.

`capabilities` descreve o adapter textual deste servidor (vision, tools, embeddings e
streaming são `false` porque não são expostos). `model_capabilities` / `catalog_capabilities`
reproduzem o que o catálogo do provider declara e ficam `unknown` quando não há informação.

`config/agents.example.json` é apenas referência humana; o runtime não o carrega.


## Adições da 4.1.0

A 4.1 adiciona um Tool Gateway declarativo: cada adapter possui escopos, classe de custo, indicação de cobrança, prazo, abort, orçamento, redaction, evento de auditoria e origem de habilitação. O registro não substitui a política única do roteador.

Novas ferramentas: `workspace_read`, `workspace_search`, `git_readonly`, `mission_start`, `mission_status_job`, `mission_pause`, `mission_resume`, `mission_cancel`, `mission_claim`, `mission_release` e `handoff_export`. O contexto de projeto em `delegate`, `consensus` e `swarm_run` é nonce-marked e tratado como dado não confiável.

`resources/list`, `resources/read`, `prompts/list` e `prompts/get` são recursos MCP somente leitura. Tasks oficiais ainda não são anunciadas, conforme o roadmap; jobs usam as ferramentas `mission_*` até a validação protocolar específica.

`output_schema` valida JSON retornado; `detail` e `max_response_chars` limitam a resposta; `idempotency_key` evita cobrança duplicada em repetição; `cache=true` só funciona com `DZ23_RESPONSE_CACHE_TTL_MS` maior que zero. Privacy `auto` mascara segredos e PII brasileira antes do contexto ser enviado.

Leases são persistidos em `state/leases` e retornam `mission_busy` para outro harness. O audit log append-only em `state/audit/events.jsonl` encadeia hashes SHA-256 e grava somente metadados redigidos.

O sandbox de patch **não faz parte da 4.1** e permanece reservado ao PR 8/versão 5.0, desligado e não exposto nesta etapa.
