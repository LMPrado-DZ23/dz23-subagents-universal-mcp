# As onze ferramentas

Todas as ferramentas publicam `inputSchema` fechado (`additionalProperties: false`) e o
servidor aplica esse mesmo schema antes de executar qualquer coisa, em stdio, HTTP `/mcp`
e REST `/api/*`. Limites de texto são configuráveis e nunca ilimitados
(`DZ23_MAX_PROMPT_CHARS`, padrão 32 000; `DZ23_MAX_GOAL_CHARS`, padrão 8 000).

| Ferramenta | Entrada principal | Efeito | Escopo HTTP | Custo |
| --- | --- | --- | --- | --- |
| `list_models` | `{}` | Alvos elegíveis, capabilities do adapter e do catálogo, verificação | `provider:discover` | sem rede |
| `provider_inventory` | `{}` | Registro, origem da credencial e flags de estado; nunca valores | `admin:inventory` | sem rede |
| `discover_models` | `provider`, `refresh` | Consulta `/models` (cache de 5 min) e persiste o resultado | `provider:discover` | rede, sem inferência |
| `health_check` | `{}` | Uma geração mínima por alvo elegível | `health:execute` | **pode cobrar** |
| `verify_model` | `target`, `confirm_billable: true` | Uma geração mínima em `provider:model` | `health:execute` | **pode cobrar** |
| `project_init` | `project_id`, `workspace`, `repository`, `branch` | Cria/atualiza metadados | `memory:write` | local |
| `mission_status` | `project_id`, `mission_id`, `events_limit` | Estado, eventos recentes e integridade do journal | `memory:read` | local |
| `memory_checkpoint` | IDs e campos estruturados | Checkpoint de handoff; cria a missão se ausente | `memory:write` | local |
| `delegate` | `prompt`, IDs, `role`, `target` | Uma resposta textual com retry/failover | `delegate:execute` + `memory:write` | **pode cobrar** |
| `consensus` | `prompt`, `models` (2–5), roteamento, `synthesis` | Revisores em alvos distintos e síntese | `delegate:execute` + `memory:write` | **pode cobrar** |
| `swarm_run` | `goal`, `roles`, `max_agents`, roteamento | Especialistas em paralelo e um revisor integrador | `delegate:execute` + `memory:write` | **pode cobrar** |

Em stdio não há escopos: a instância é um único domínio de confiança. `project_id`
organiza memória e nunca autentica ou autoriza.

## Argumentos e erros

- IDs: 1–120 letras, dígitos, `.`, `_` ou `-`, começando por letra ou dígito.
- `target`: `auto` ou `provider:model` (o modelo pode conter `:`). `verify_model` recusa `auto`.
- `role`: `worker`, `architect`, `backend`, `frontend`, `security`, `qa`, `devops`, `reviewer`.
  `swarm_run.roles` não aceita `worker`.
- `memory_checkpoint`: `next_action`, `status` (`active`, `partial`, `blocked`, `paused`, `done`,
  `completed`, `failed`, `cancelled`), `summary`, `goal`, listas (`acceptance_criteria`,
  `decisions`, `invariants`, tarefas, arquivos, `known_failures`, `artifacts`), `tests`
  (`passed`/`failed`/`pending`) e `merge` (`append`, padrão, ou `replace`). Status omitido
  mantém o atual.

Argumento inválido gera JSON-RPC `-32602` com `data.field` e `data.reason`, sem ecoar o valor.
Clientes que negociaram 2025-11-25 recebem o mesmo conteúdo como erro de execução
(`isError: true`, `code: invalid_arguments`), conforme SEP-1303 dessa revisão; ajuste com
`DZ23_TOOL_ARGUMENT_ERRORS=auto|jsonrpc|tool_result`.

Falhas esperadas de execução retornam `isError: true` e
`structuredContent.error = {code, message, request_id, details?}`:

| `code` | Quando | HTTP REST |
| --- | --- | --- |
| `invalid_request` | Provider recusou a requisição; não há failover | 400 |
| `input_too_large` | Tokens estimados acima de `DZ23_MAX_INPUT_TOKENS` | 413 |
| `target_not_allowed` | Alvo desconhecido, desabilitado, pago sem permissão ou fora da rotação | 403 |
| `mission_not_found` | Missão inexistente para a operação | 404 |
| `diversity_unavailable` | `strict_diversity` sem alvos suficientes | 409 |
| `budget_exceeded` | Limite de orçamento ou política de custo | 402 |
| `all_providers_failed` | Todos os candidatos falharam (tentativas classificadas em `details`) | 502 |
| `no_providers` | Nenhum alvo elegível ou todos em cooldown | 503 |
| `lock_timeout`, `memory_write_failed` | Memória ocupada | 503 |
| `memory_integrity` | JSON corrompido ou schema não suportado | 500 |

Resultados de sucesso têm `content[0].text` com o JSON e `structuredContent` sempre objeto
(listas como `{items}`).

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
aviso de que concordância entre modelos não é verdade objetiva.

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

`capabilities` descreve o adapter textual deste servidor (vision, tools, embeddings e
streaming são `false` porque não são expostos). `model_capabilities` / `catalog_capabilities`
reproduzem o que o catálogo do provider declara e ficam `unknown` quando não há informação.

`config/agents.example.json` é apenas referência humana; o runtime não o carrega.
