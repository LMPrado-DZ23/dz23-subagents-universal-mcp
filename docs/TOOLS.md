# Ferramentas

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

## Ferramentas adicionadas na 4.1.0

A 4.1.0 mantém as onze ferramentas e o contrato da 4.0.0 e acrescenta onze. As de workspace só
aparecem em `tools/list` (e só podem ser chamadas) quando `DZ23_WORKSPACE_ROOTS` está configurada.

| Ferramenta | Entrada principal | Efeito | Escopo HTTP | Custo |
| --- | --- | --- | --- | --- |
| `workspace_read` | `workspace`, `path` | Lista uma pasta ou lê um arquivo UTF-8 limitado dentro das raízes permitidas | `workspace:read` | local |
| `workspace_search` | `workspace`, `query`, `regex`, `max_results` | Busca texto ou regex em todos os arquivos permitidos (até `DZ23_WORKSPACE_MAX_FILES`) | `workspace:read` | local |
| `git_readonly` | `workspace`, `operation` (`status`, `diff`, `log`, `show`) | Git somente leitura, blindado contra configuração do repositório | `git:read` | local |
| `mission_start` | `goal`, IDs, `roles`, `acceptance_criteria`, `routing_strategy`, `max_iterations`, `lease_token` | Inicia um loop de missão em segundo plano e devolve `job_id` | `mission:control` + `memory:write` + `delegate:execute` | **pode cobrar** |
| `mission_status_job` | `job_id` (+ `project_id`, `mission_id` após reinício) | Estado do job; `orphaned` quando o processo que o executava parou | `mission:control` + `memory:read` | local |
| `mission_pause` | `job_id` | Pausa ao fim da iteração atual | `mission:control` + `memory:write` | local |
| `mission_resume` | `job_id` | Novo `job_id` com o mesmo objetivo, papéis, critérios e iterações restantes | `mission:control` + `memory:write` + `delegate:execute` | **pode cobrar** |
| `mission_cancel` | `job_id` | Cancela job em execução ou pausado; job terminado mantém o status final | `mission:control` + `memory:write` | local |
| `mission_claim` | IDs, `identity`, `lease_ms`, `lease_token` | Trava a missão para um harness, com expiração; renovação exige o token | `mission:lease` + `memory:write` | local |
| `mission_release` | IDs, `token` | Libera a trava | `mission:lease` + `memory:write` | local |
| `handoff_export` | IDs | `{markdown}` com objetivo, estado, critérios, decisões, testes e próximos passos | `memory:read` | local |

### Workspace e Git

- Só pastas abaixo de `DZ23_WORKSPACE_ROOTS` (caminho real, depois de resolver links e junctions;
  sem diferenciar maiúsculas no Windows). Caminhos UNC e absolutos em `path` são recusados.
- Nomes protegidos nunca são lidos, listados ou buscados: `.env*`, `*.env`, `.npmrc`, `.yarnrc`,
  `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `.pgpass`, `.git`, `.ssh`, `.gnupg`, `.aws`,
  `.azure`, `.kube`, `.docker`, chaves `id_*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `*.jks`,
  `*.keystore`, `*.kdbx`, `*.tfstate` e nomes com secret, password, credential, private_key, api_key,
  access_token, auth_token, service_account ou keyfile sem extensão ou com extensão de dados/configuração
  (por exemplo `aws_credentials`, `gcp-service-account.json`); arquivos de código como `secretStore.js` continuam legíveis.
- Segredos com formato conhecido (chaves `sk-`, `gsk_`, `AIza`, `AKIA`, tokens do GitHub e Slack, JWT,
  chaves privadas PEM, atribuições `*_API_KEY=`/`*_TOKEN=`) são mascarados no conteúdo lido, na busca
  e na saída do Git.
- `workspace_search` com `regex: true` roda a expressão num worker isolado, com limite de 1 s por
  arquivo: uma expressão catastrófica falha com `regex_timeout` sem travar o servidor. `node_modules`
  é ignorado.
- `git_readonly` roda o Git com ambiente mínimo (nenhuma chave do processo), sem pager, sem
  fsmonitor, sem hooks, sem diff externo nem textconv, e sem locks opcionais. Se a configuração local
  do repositório define algo que executa programas (`core.fsmonitor`, `core.pager`, `filter.*`,
  `diff.*.textconv`, `diff.external`, `credential.helper`, includes...), a chamada falha com
  `git_config_unsafe` e lista as chaves. Repositório que começa acima da raiz permitida:
  `git_repository_outside_root`.

### Contexto de projeto em `delegate`, `consensus` e `swarm_run`

`context: {files, search, git_diff}` com `workspace` anexa evidência ao prompt dentro de
`<dz23-untrusted-context nonce="...">` … `</dz23-untrusted-context nonce="...">`; o mesmo nonce nos
dois marcadores impede que o conteúdo feche o bloco e continue como instrução. Arquivos com frases
típicas de prompt injection recebem `warning="possible_prompt_injection"`. O texto é limitado a
`DZ23_MAX_CONTEXT_CHARS`.

`privacy`:

- `auto` (padrão): mascara segredos e dados pessoais válidos (CPF e CNPJ com dígito verificador,
  cartão com Luhn, e-mail, telefone brasileiro formatado). Números comuns em código (portas,
  timestamps, ids) não são alterados.
- `local_only`: igual a `auto` e, além disso, roteia **somente** para alvos locais em endpoint privado;
  sem alvo local o erro é `no_local_target`, antes de qualquer chamada.
- `allow_cloud`: mantém dados pessoais; segredos continuam mascarados.

### Formato da resposta, idempotência e cache

- `detail: brief` limita o texto a 2 000 caracteres; `normal` e `full` mantêm o comportamento da
  4.0.0 (sem corte). `max_response_chars` define um limite explícito. Quando há corte, a resposta traz
  `truncated: true`.
- `output_schema` aceita o subconjunto `type`, `required`, `properties`, `items` e `enum`
  (profundidade até 32). Um bloco ```json único é aceito. `delegate` tenta de novo uma vez pedindo só
  JSON e falha com `response_invalid`; `consensus` e `swarm_run` não falham: cada resposta (e a
  integração) recebe `structured_output` ou `schema_error`, e a síntese é preservada.
- `idempotency_key` vale 24 h no processo, por identidade e ferramenta: a mesma chave com os mesmos
  argumentos devolve o primeiro resultado (uma chamada ainda em andamento é aguardada, não repetida);
  argumentos diferentes falham com `idempotency_conflict`.
- `cache: true` (só em `delegate`) reutiliza uma resposta idêntica da mesma identidade quando
  `DZ23_RESPONSE_CACHE_TTL_MS` > 0; a resposta informa `cache_status` (`hit`, `miss` ou `disabled`).
  Um acerto de cache não chama provider nem grava nova resposta na missão.

### Missões assíncronas

Cada iteração executa `swarm_run` com o objetivo original e, a partir da segunda, o texto da integração
anterior como diagnóstico (entre marcadores com nonce). Duas integrações quase iguais seguidas trocam a
estratégia de roteamento; a terceira encerra com `failed_safe` / `stagnation`. O progresso fica em
`loop_state` da missão; `status`, `next_action` e `goal` continuam sendo do harness.

Estados: `queued`, `running`, `paused`, `completed`, `awaiting_acceptance`, `failed_safe`, `failed`,
`cancelled`, `deadline_exceeded`, `resumed` e, após reinício, `orphaned`. O job termina `completed` só
quando o harness registrou testes aprovados novos (e nenhum reprovado) com `memory_checkpoint` durante
o job; sem isso, `awaiting_acceptance`. No máximo `DZ23_MAX_MISSION_JOBS` jobs rodam ao mesmo tempo
(`mission_jobs_busy`), e cada job respeita `DZ23_MISSION_DEADLINE_MS`. Jobs existem só no processo
que os iniciou.

### Travas entre harnesses

Enquanto uma trava de `mission_claim` estiver válida, `memory_checkpoint`, `delegate`, `consensus`,
`swarm_run` e `mission_start` nessa missão exigem `lease_token`; sem ele, `mission_busy`, antes de
qualquer chamada a provider. A reivindicação é atômica (trava de diretório), a renovação exige o
token e a expiração libera a missão sozinha. Travas coordenam harnesses que cooperam; não são
autenticação.

### Resources e prompts MCP

- `resources/list`: missões existentes como `dz23://mission/<project_id>/<mission_id>`, 100 por página
  (`nextCursor`). `resources/templates/list`: o modelo `dz23://mission/{project_id}/{mission_id}`.
  `resources/read`: estado compacto da missão. Recurso inexistente: JSON-RPC `-32002`. Com tokens de
  escopo, exigem `memory:read`.
- `prompts/list` e `prompts/get`: `audit_project` (`goal`, `workspace` opcional), `fix_bug` (`bug`) e
  `review_pull_request` (`change`). Argumento ausente, desconhecido ou não textual: `-32602`.
- Tasks do MCP ainda não são anunciadas; jobs longos usam `mission_start`/`mission_status_job`.

### Log de auditoria

Cada chamada de ferramenta grava metadados (ferramenta, status, código de erro, identidade, duração,
`request_id`; nunca prompts, respostas ou chaves) em `<estado>/audit/events.jsonl`, com hash SHA-256
encadeado. As gravações são serializadas no processo e travadas entre processos; o arquivo gira aos
10 MB. O encadeamento detecta edição de linhas, mas quem controla o diretório de estado pode reescrever
a cadeia inteira.

### Erros novos

| Código | Quando | REST |
| --- | --- | --- |
| `workspace_denied` / `workspace_not_found` / `workspace_limit` | Fora das raízes, protegido, inexistente ou acima do limite | 403 / 404 / 400 |
| `regex_timeout` | Regex demorou mais de 1 s num arquivo | 400 |
| `git_config_unsafe` / `git_repository_outside_root` / `git_not_repository` | Configuração do repositório executa programas / repositório fora da raiz / sem repositório | 400 |
| `no_local_target` | `privacy: local_only` sem alvo local elegível | 503 |
| `response_invalid` | Resposta de `delegate` fora de `output_schema` após nova tentativa | 502 |
| `idempotency_conflict` | Mesma `idempotency_key` com argumentos diferentes | 409 |
| `mission_busy` | Missão travada por outro harness | 409 |
| `mission_jobs_busy` / `job_not_found` / `job_not_paused` | Limite de jobs / job desconhecido / retomada de job não pausado | 400 |

As ferramentas novas existem só em MCP (stdio e `/mcp`); a API REST continua com as rotas da 4.0.0.

## Ferramentas adicionadas na 4.2.0

| Ferramenta | Entrada principal | Efeito | Escopo HTTP | Custo |
| --- | --- | --- | --- | --- |
| `mission_list` | `project_id`, `limit`, `cursor` | Missões com status, objetivo, próximo passo, progresso de loop/grafo e URI do resource | `memory:read` | local |
| `playbook_get` | `name`, `arguments` | Sem `name`: lista os playbooks. Com `name`: instruções prontas (os mesmos prompts MCP) | `memory:read` | local |
| `routing_explain` | `task_type`, `role`, `target` | Ordem de modelos que o servidor usaria agora e o motivo de cada exclusão | `provider:discover` | sem rede |
| `cost_estimate` | `tool`, `prompt`/`prompt_chars`, `models`, `roles`, `max_agents`, `synthesis` | Limite superior de chamadas, tokens e custo antes de rodar | `provider:discover` | sem rede |
| `patch_validate` | `workspace`, `patch`, `command`, `timeout_ms` | Aplica um diff numa cópia e roda um comando de teste permitido (desligado por padrão) | `sandbox:execute` | local |

`mission_list` e `playbook_get` existem porque nem todo harness expõe resources e prompts MCP ao modelo: o
Codex CLI 0.154 respondeu `RESOURCE_TOOLS_UNAVAILABLE` num teste real. Com eles, qualquer cliente que chama
ferramentas tem os mesmos dados e instruções.

### Quem escolhe o modelo

O harness decide **o que** fazer; o servidor decide **com qual modelo**. Com `target: auto` (padrão), o
roteador:

1. aplica a política de custo (`paid`/`low-cost`/`mixed` bloqueados sem `DZ23_ALLOW_PAID`, exceto
   `DZ23_FREE_MODELS`) e remove alvos em cooldown;
2. ordena por faixa de custo (`local` → `free-tier` → `mixed` → `low-cost` → `paid`);
3. **dentro de cada faixa**, com `DZ23_ROUTING_POLICY=free-first` e `DZ23_ADAPTIVE_ROUTING=true` (padrão),
   coloca primeiro o modelo com melhor histórico para o tipo de tarefa: taxa de sucesso suavizada dividida
   por um fator de latência, depois de pelo menos 3 observações; alvos cuja cota informada pelo provedor
   (`x-ratelimit-remaining-*`, `anthropic-ratelimit-*`) chegou a zero vão para o fim até o reset.

`task_type` (`general`, `code`, `review`, `design`, `security`, `testing`, `ops`, `summary`) vem do papel
(`backend`/`frontend` = `code`, `reviewer` = `review`, `qa` = `testing`, `security` = `security`,
`devops` = `ops`, `architect` = `design`) ou do parâmetro `task_type` de `delegate`. O aprendizado nunca
move um modelo para outra faixa de custo e nunca libera modelo pago; com `DZ23_ROUTING_POLICY=rotation-order`
a ordem da rotação é mantida. As observações ficam em `<estado>/providers/routing-stats.json` (compartilhadas
de forma aproximada entre processos: vence o registro com mais chamadas). `routing_explain` mostra tudo isso
sem chamar provedores.

### Missões em grafo

`mission_start` com `plan: {nodes: [...]}` (até 30 nós) executa um grafo:

- cada nó tem `id`, `prompt`, `title`, `role`, `task_type`, `depends_on` e `max_attempts` (1–3, padrão 2);
- ids únicos, dependências existentes e ausência de ciclos são validados antes de começar (`invalid_plan`);
- nós cujas dependências terminaram rodam em paralelo (`DZ23_MISSION_PARALLEL_NODES`, padrão 3) com
  `delegate`, recebendo o objetivo e os resultados das dependências entre marcadores com nonce;
- falha repete até `max_attempts`; nós que dependem de um nó falho ficam `skipped` e o job termina `failed`
  com `failed_nodes`;
- `dag_state` da missão é gravado a cada transição (status, tentativas, provider/modelo, erro e até 4 000
  caracteres de resultado por nó);
- `mission_start` com o mesmo plano e `resume_plan: true` reaproveita os nós `done` — também depois de um
  reinício — e só executa o que faltou;
- pausa, cancelamento, prazo e a regra de conclusão (testes aprovados registrados pelo harness durante o job)
  são os mesmos do loop.

`mission_status_job` e `mission_list` mostram o progresso (`dag: {nodes, done, running, pending, failed, skipped}`).

### Validação de patch em sandbox

`patch_validate` só aparece com `DZ23_SANDBOX_ENABLED=true`, `DZ23_WORKSPACE_ROOTS` e
`DZ23_SANDBOX_COMMANDS` (comandos separados por `;;`, por exemplo `npm test;;npm run lint`):

1. recusa comando que não seja exatamente um dos permitidos (`command_not_allowed`) e diff que toque
   `.git`, arquivos protegidos, caminhos absolutos ou `..` (`patch_denied`);
2. aplica as mesmas checagens de `git_readonly` (repositório dentro da raiz, configuração sem programas);
3. clona o repositório (`git clone --shared`) numa pasta temporária no commit `HEAD`, verifica e aplica o
   diff (`patch_rejected` se não aplicar);
4. roda o comando com ambiente mínimo (sem as chaves de provedor do servidor), `HOME`/`TEMP` na pasta
   temporária e limite `DZ23_SANDBOX_TIMEOUT_MS` (a árvore de processos é encerrada no timeout);
5. devolve `exit_code`, `passed`, `timed_out`, duração e o final de stdout/stderr (segredos mascarados) e
   apaga a pasta temporária.

O repositório original nunca é alterado e nada é commitado ou enviado. Uma validação por vez
(`sandbox_busy`). **No modo `process` a rede não é isolada** e o comando roda com o usuário do servidor:
permita só comandos de teste do próprio projeto. `DZ23_SANDBOX_MODE=docker` roda em
`docker run --network none` com limites de CPU, memória e processos (`DZ23_SANDBOX_IMAGE`, padrão
`node:22-bookworm-slim`); dependências precisam estar no repositório ou na imagem.

### Painel

`node src/index.js dashboard [--port 8788]` abre um painel **somente leitura** em `127.0.0.1`: missões e
progresso de loop/grafo, travas ativas (sem tokens), uso do dia, cooldowns, roteamento aprendido e as últimas
chamadas do log de auditoria. A URL impressa contém um token aleatório no fragmento (`#token=`), válido
enquanto o comando rodar; sem ele a API responde 401. Só aceita `GET`, só `Host` de loopback, com CSP estrita
e dados exibidos como texto.

### Erros novos na 4.2.0

| Código | Quando | REST |
| --- | --- | --- |
| `invalid_plan` | Plano com id repetido, dependência inexistente, ciclo ou campo inválido | 400 |
| `sandbox_disabled` / `command_not_allowed` / `patch_denied` | Sandbox desligado / comando fora da lista / diff em caminho protegido | 403 |
| `patch_rejected` | O diff não aplica em `HEAD` | 422 |
| `sandbox_busy` | Outra validação em andamento | 429 |
| `git_no_commits` / `sandbox_setup_failed` | Repositório sem commit / falha ao copiar | 400 / 500 |
