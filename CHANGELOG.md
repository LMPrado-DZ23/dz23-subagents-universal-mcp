# Changelog

## 4.0.0 — 2026-09-15 — cost policy, reliable failover, cancellation, concurrent stdio and smaller results

Versão maior, pela mesma regra da 3.0.0: vários padrões mudaram de forma incompatível. Siga o roteiro
de atualização em `docs/OPERATIONS.md` (serve para 2.2.x e 3.0.0). Nada foi publicado como 3.1.0.

### Mudanças incompatíveis (revise antes de atualizar)

- Provedores `mixed` (openrouter/auto, mistral, together, fireworks, novita, upstage, ollama cloud,
  hyperbolic, alibaba, gemini) ficam bloqueados sem `DZ23_ALLOW_PAID=true` (motivo `mixed_not_allowed`),
  exceto modelos com sufixo `:free` ou listados exatamente em `DZ23_FREE_MODELS`.
- Adaptadores locais (`custom`, `lmstudio`, `vllm`) apontados para host público passam a ser `mixed`.
- `GITHUB_TOKEN`, `HF_TOKEN` e `CLOUDFLARE_AUTH_TOKEN` só habilitam o provedor quando `DZ23_ROTATION`
  o cita ou com `DZ23_ALLOW_GENERIC_CREDENTIALS=true`. Nome específico novo: `GITHUB_MODELS_TOKEN`.
- `OPENAI_BASE_URL`, `OPENAI_MODEL`, `ANTHROPIC_BASE_URL` e `ANTHROPIC_MODEL` são ignorados (outras
  ferramentas os definem); use `DZ23_OPENAI_*` e `DZ23_ANTHROPIC_*`. O prefixo `DZ23_` vale para todos
  os provedores e tem precedência sobre o nome antigo.
- Base URL `http://` só é aceita para host de loopback ou rede privada.
- `--http` não inicia sem `DZ23_MCP_TOKEN`, `DZ23_MCP_TOKEN_FILE` ou tokens com escopo, mesmo em
  loopback, salvo `DZ23_ALLOW_UNAUTHENTICATED_LOCAL_HTTP=true` (código 78).
- `GET /api/discover?refresh=true` responde 405; atualize catálogos com `POST /api/discover`.
- `swarm_run` devolve por padrão `response_mode: "summary"`: trecho de até 600 caracteres por worker e
  a integração completa. `response_mode: "full"` mantém o formato anterior.
- `mission_status` devolve prévias (até 400 caracteres) das saídas dos agentes; `include_outputs: true`
  devolve o conteúdo completo.
- O texto em `content[0].text` é JSON compacto, sem indentação.
- HTTP 413 e erros 400/422 de contexto grande agora são `context_length_exceeded` (antes
  `invalid_request`): fazem failover para o próximo alvo, sem retry e sem cooldown.
- Identificadores não podem terminar com ponto nem ser nomes de dispositivo do Windows
  (`CON`, `NUL`, `COM1`…); o erro é `invalid_request`.
- stdio atende requisições em paralelo; respostas chegam na ordem em que terminam (casadas por `id`).

### Custo e credenciais

- Relatório por alvo com tier e motivo de exclusão (`targetReport`), usado por `doctor`.
- `discover_models` só contata provedores habilitados.

### Confiabilidade

- Resposta de provedor nunca é descartada por falha de memória depois da chamada: vem com
  `memory_warnings` (`usage:…`, `agent_result:…`, `event:…`, `handoff:…`).
- Cancelamento: `notifications/cancelled` no stdio (sem resposta para a requisição cancelada) e
  desconexão do cliente no HTTP; fila do limitador e espera de retry respeitam o sinal; chamada
  cancelada é registrada como falha no orçamento e não gera cooldown.
- Prazo total por chamada de `delegate`, `consensus` e `swarm_run`: `DZ23_DELEGATE_DEADLINE_MS`
  (padrão 600000). Erros `cancelled` (REST 499) e `deadline_exceeded` (REST 504).
- `DZ23_SHARED_COOLDOWNS` (padrão `true`) grava cooldowns em `providers/status.json`, compartilhados
  entre Claude Code, Codex e Hermes no mesmo diretório de estado.
- `DZ23_STDIO_MAX_INFLIGHT` (padrão 8) limita requisições simultâneas no stdio.

### Consenso e swarm

- `possible_divergences` no consenso heurístico ("Postgres" vs "Redis"); com divergências a
  concordância nunca é `high`; `agreement.method` é `lexical_overlap`.
- O revisor integrador do swarm e a síntese por modelo recebem as respostas desta rodada no prompt
  (limitadas) e não repetem as saídas da memória.
- Falhas de gravação no fim do swarm viram `memory_warnings` em vez de perder as saídas.

### Ferramentas, CLI e instalação

- Descrições orientam a reutilizar `project_id`/`mission_id`; `roles`, `max_agents` e `models`
  documentados no schema.
- `doctor`: checagens `targets`, `cost_policy`, `generic_credentials` e HTTP sem autenticação;
  `providers` com coluna TIER; `config validate` com os novos campos.
- Instalador: Codex com `startup_timeout_sec = 30` e `tool_timeout_sec = 900`; comando pronto
  `claude mcp add -s user` para Claude Code.
- `DZ23_STATE_DIR` expande `~\` no Windows.

### Código e testes

- Orquestração de consenso e swarm movida para `src/orchestration.js`; `src/endpoints.js` novo.
- Testes novos: `hardening-policy`, `hardening-runtime`, `cli-diagnostics`. Asserções de ordem no
  stdio passaram a casar respostas por `id`; o teste de sobreposição do swarm roda sem fsync (ficava
  instável com a máquina carregada).

## 3.0.0 — 2026-09-13 — MCP conformance, HTTP security, observability, budgets and memory v2

Versão maior porque há mudanças incompatíveis com 2.2.x. A numeração 2.3.0 foi usada apenas
numa candidata interna, nunca publicada.

### Mudanças incompatíveis (revise antes de atualizar)

- `consensus` retorna um objeto (`requested`, `planned`, `received`, `failed`,
  `responses`, `routing`, `synthesis`) em vez de uma lista.
- Argumentos de ferramentas são validados pelo schema publicado: campos desconhecidos,
  tipos errados, enums inválidos, prompts vazios ou acima do limite são recusados.
  `memory_checkpoint.status` agora é um enum.
- `structuredContent` é sempre um objeto; resultados em lista vêm como `{items: [...]}`.
  O texto em `content` mantém o JSON original.
- Tipos de erro de provider mudaram para a taxonomia de 13 categorias
  (`quota_or_rate_limit`, `auth_or_entitlement` e `model_or_endpoint_missing` não existem mais).
- `initialize` aceita 2025-11-25 e 2025-06-18; versões datadas não suportadas recebem
  contraproposta; valores malformados recebem `-32602`.
- `memory_checkpoint` não força mais `status: active` quando omitido e cria a missão
  quando ela ainda não existe.
- Endpoints REST (`/api/*`) usam a mesma validação/escopos/rate limit das ferramentas MCP;
  o formato de erro mudou.
- Cooldown depende do tipo de erro (antes: 15 minutos para qualquer falha).
- `discover_models` devolve `{id, owned_by, catalog_capabilities}` por modelo
  (campos crus do catálogo foram removidos).
- Definir `DZ23_MCP_TOKEN` e `DZ23_MCP_TOKEN_FILE` ao mesmo tempo impede a inicialização.
- `health_check` exige `confirm_billable: true`; na REST é `POST /api/health` (`GET` responde 405).
- Erros REST e de transporte HTTP usam `{error: {code, message, request_id, details}}`; campos como
  `error.field` passaram para `error.details`.
- `memory_checkpoint` responde com um resumo em vez do estado completo; listas são limitadas a 500
  itens e o estado a 4 MiB (`DZ23_MAX_CHECKPOINT_LIST_ITEMS`, `DZ23_MAX_STATE_BYTES`).
- `delegate`, `consensus` e `swarm_run` não sobrescrevem mais `status`, `next_action` ou `goal`;
  gravam `last_tool_handoff`. O swarm não preenche mais listas de tarefas da missão.
- Provedores locais só ficam ativos com configuração explícita (URL, modelo, chave ou menção em
  `DZ23_ROTATION`); a exceção à regra de modelo padrão vale só para endereços loopback ou privados.
- Sem `DZ23_ROTATION`, alvos explícitos com modelo diferente do padrão do provider exigem
  `DZ23_ALLOW_PAID=true`; `verify_model` segue a mesma regra.
- Com limites de custo e sem `DZ23_COST_POLICY`, o padrão é `deny_unknown_cost`.
- Erros de configuração (booleano inválido, política de roteamento desconhecida) impedem o servidor
  de iniciar, com código 78.
- Argumentos que não sejam `--stdio`/`--http` são comandos da CLI; comando desconhecido sai com 2.
- `swarm_run` sem `max_agents` usa no máximo `DZ23_MAX_CONCURRENCY` workers.
- `token hash` recusa tokens com menos de 32 caracteres. Com `--http`, `DZ23_MCP_TOKEN` com
  menos de 32 caracteres impede a inicialização (código 78); em stdio gera apenas aviso.

### MCP e JSON-RPC
- Validador de JSON Schema sem dependências; keywords não suportadas são recusadas no registro.
- Códigos `-32700`, `-32600`, `-32601`, `-32602`, `-32603`; `-32001` rate limit, `-32002` forbidden,
  `-32003` servidor ocupado. Falhas esperadas de ferramenta viram `isError: true` com
  `code`, `message`, `request_id` e detalhes sanitizados.
- `id: 0` e ids string preservados; `id: null` e batch recusados; notificações sem resposta.
- Header `MCP-Protocol-Version` validado quando presente.

### HTTP e identidade
- `DZ23_MCP_TOKEN_FILE`; modo `scoped` com digests SHA-256 e escopos por token.
- Rate limiting por processo (identidade, ferramenta, concorrência e custo), 429 + `Retry-After`
  antes de qualquer chamada a provider; falhas de autenticação por endereço limitadas.
- Limites de corpo, tempo de leitura, requisições em andamento, conexões e shutdown gracioso.

### Observabilidade
- Logs JSON Lines em stderr com redação; `request_id` em logs, journal, resultados e erros.
- Métricas de processo e `GET /metrics` (escopo `admin:inventory`).

### Providers, retry e roteamento
- `ProviderError` com `kind`, `retryable`, `retryAfterMs` e mensagens sem corpo cru.
- Retry limitado apenas para `rate_limited`, `provider_timeout` e `provider_unavailable`;
  `invalid_request` não faz failover.
- Estratégias `first`, `round_robin`, `provider_diversity`, `model_diversity`,
  `cost_optimized`, `latency_optimized`, diversidade observada, `strict_diversity`
  e `avoid_reviewer_target`.
- `verify_model` (exige `confirm_billable: true`), status de catálogo/verificação persistido,
  `catalog_capabilities` com `unknown` quando o catálogo não declara.

### Orçamento
- Limites de tokens de entrada, chamadas/tokens por missão e custo por chamada, missão,
  projeto e dia; política `allow_unknown_cost`/`deny_unknown_cost`; preços apenas de tabela explícita.
- Registro de uso com origem de tokens e custo; reservas em processo contra estouro concorrente.

### Memória
- Schema versionado com migrações na leitura; JSON corrompido gera `memory_integrity`.
- Locks com dono (pid, hostname, heartbeat) e remoção automática só de dono comprovadamente morto.
- Journal com `seq` monotônico e recuperação de linha incompleta; escrita com fsync.
- Contexto em camadas com relatório de seções truncadas.
- Correção de condição de corrida no Windows: rename de `state.json` falhava com EPERM durante
  leituras concorrentes; leituras/escritas do processo são serializadas por projeto e há retry.

### CLI, CI e empacotamento
- `doctor`, `config validate`, `providers`, `health --yes`, `missions list|show`,
  `memory repair [--apply --yes]`, `token hash`, com `--json` e códigos de saída.
- CI com lint, testes de contrato, cobertura (relatório) e auditoria dos arquivos públicos.
- Docker com código somente leitura para o usuário não-root, volume de estado, healthcheck
  com token por arquivo e compose com `read_only`, limites e secret opcional.

### Correções da auditoria independente (arquitetura, segurança e produto)
- Checkpoints concorrentes perdiam itens: o merge agora acontece dentro do lock da missão.
- Falhas de autenticação de um endereço bloqueavam também tokens válidos: só tentativas inválidas
  são limitadas.
- Chamadas de ferramenta sobrescreviam o handoff do harness (`status`, `next_action`, `goal`).
- Comando desconhecido iniciava o servidor stdio em silêncio.
- `GET /api/health` permitia a uma página cross-site disparar chamadas faturáveis num servidor
  loopback sem token; o Host era lido da URL absoluta em vez do header.
- Modelos arbitrários em providers de categoria mista contornavam a política de pagos.
- Remoção de lock sem dono podia apagar um lock recriado; locks anteriores ao boot ficavam presos;
  `owner.json` é gravado de forma atômica; erros de lock não expõem `pid`/`hostname`.
- stdio acumulava frames grandes em memória antes de rejeitá-los.
- `memory repair` propunha restaurar checkpoint antigo sobre registro de schema mais novo.
- Liquidação de uso marcava como gravada uma escrita que falhou.
- Revisores do `consensus` viam as respostas uns dos outros no contexto.
- Fila cheia virava `internal_error`; agora é `queue_full` (503).
- Rate limiter descartava buckets esgotados sob pressão de chaves; mapas por alvo e séries de
  métricas agora são limitados.
- `doctor` passava sem alvos elegíveis ou com registros corrompidos; booleanos, timeouts e política
  de roteamento inválidos eram aceitos em silêncio.
- IDs que diferem só por maiúsculas/minúsculas colidiam em Windows/macOS.
- Guard de publicação passa a recusar `credentials*.json`, `secrets*.json` e `token*.txt`.
- Segunda rodada: fila cheia não coloca mais um alvo saudável em cooldown; a checagem de
  maiúsculas/minúsculas vale em todas as leituras e escritas da memória; lock com o PID deste
  processo e outro horário de início (PID 1 de container reiniciado) é recuperado, e o compose fixa o
  hostname; o handoff após uma chamada já paga não falha por limite de tamanho; `memory_checkpoint`
  informa `truncated_lists`; `startMission` não sobrescreve missão criada em paralelo; um processo
  só remove o próprio lock; erros HTTP inesperados trazem `request_id`.
- Quarta rodada: falha transitória ao ler `owner.json` na liberação não deixa mais o lock preso até o
  processo reiniciar (escrita de heartbeat pendente é aguardada e a leitura é repetida); a checagem de
  maiúsculas/minúsculas só vale em sistemas de arquivos que não as diferenciam, então IDs distintos já
  existentes em Linux continuam acessíveis; na CLI, ID com maiúsculas/minúsculas trocadas é erro de uso
  (código 2) em vez de parecer memória corrompida; `memory repair --apply` informa "No repairs applied."
  quando nada mudou; token HTTP curto impede apenas `--http`; conexões que não completam os headers da
  primeira requisição são fechadas e respostas não autenticadas encerram a conexão; o endereço privado
  é analisado como IP de verdade (nomes como `10.0.0.1.evil.com` não contam); a checagem de maiúsculas
  só lista o diretório para IDs ainda não vistos; o guard de publicação cobre `apikey*`, `.pgpass`,
  `.htpasswd`, `kubeconfig` e keystores Java; `doctor` falha no check `http` quando `--http` recusaria o
  token; `memory repair --json` separa `apply_requested` de `applied`.
- Terceira rodada: missão que já atingiu `DZ23_MAX_STATE_BYTES` é recusada antes de qualquer chamada
  paga; conexões HTTP silenciosas são fechadas após o timeout de headers; erro de provider, rotação com
  provider desconhecido e HTTP inseguro fazem o servidor sair com 78 em vez de iniciar ou mostrar stack
  trace; `config validate` acusa HTTP inseguro; `missions show --json` devolve erro em JSON; o erro de
  colisão de maiúsculas não revela o identificador existente; o guard de publicação cobre mais nomes
  de credencial (`tokens.json`, `*-key.json`, `service-account*.json`, `id_rsa`, `.npmrc` e outros).

## 2.2.5 — 2026-09-12 — hardening de orquestração e limites

- Contexto persistido e saídas de modelos são enviados como dados não confiáveis;
  papéis agora usam enum estrito e QA/DevOps não podem alegar execução de ações.
- `swarm_run` usa o primeiro alvo como principal e os seguintes apenas como failover,
  evitando distribuir trabalho ao modelo de fallback quando o principal está saudável.
- Limites configuráveis para fila, resposta HTTP, frame stdio, outputs persistidos,
  journal e checkpoints; concorrência e quantidade de agentes possuem tetos.
- Modo HTTP desativado por padrão e condicionado a opt-in explícito.
- Locks de memória toleram erros transitórios do Windows sem remover exclusão mútua.
- Regressões cobrem papéis arbitrários, contexto não confiável, limite de resposta
  vazia, evento excessivo e preferência do alvo principal. Smoke real no Windows/
  Node 24 validou os sete papéis e o reviewer integrador usando o modelo cloud
  `deepseek-v4-flash:cloud` por meio do daemon Ollama local.

## 2.2.4 — 2026-09-12 — paralelismo verificável e distribuição de workers

- Corrigido round-robin em `swarm_run`: papéis usam alvos elegíveis distintos
  antes de reutilizar um alvo, mantendo a ordem da rotação e os limites existentes.
- Testes não dependem mais de respostas falsas durarem 30/40 ms. Barreiras de
  Promises mantêm chamadas abertas até observar simultaneidade e filas. Watchdogs
  detectam travamentos; o tempo decorrido não é critério de aprovação.
- Regressão com journal deliberadamente lento; checagem de distribuição com
  reutilização/cooldown; limites globais/por alvo e liberação em erro preservados.
- `PUBLICAR_WINDOWS.cmd` executa o publicador na própria pasta, sem digitar caminho.
  Requer Node/Git/gh instalados e login local; qualquer teste falho ainda bloqueia push.
- Sem migração de memória, alteração de APIs/chaves ou redução de guardas.
- Consulte `docs/VALIDATION.md`: validação local Linux, sem alegar Windows/Node 24
  ou GitHub Actions aprovados antes de serem executados nesses ambientes.

## 2.2.3 — 2026-09-12 — preparação open-source (engineering preview)

### Publicação e documentação
- Licença MIT original preservada; README PT/EN, contribuição, conduta, segurança,
  suporte, inventário de componentes e roadmap adicionados.
- Publicação primeira vez via GitHub CLI com conta verificada, allowlist/hash,
  scanner de padrões, proteção contra sobrescrita e verificação do commit remoto.
- Nenhum `.env` privado no código público; instaladores criam a cópia local.
- CI configurada para Linux/Windows e Node 22/24; ainda não executada no GitHub.
- Limites reais documentados: workers textuais, sem shell/worktrees automáticas,
  sem OAuth/RBAC/multitenancy/Vault, sem promessa de custo zero ou host universal.

### Correções de runtime
- Seleção explícita agora respeita elegibilidade; `paid` e `low-cost` bloqueados
  com ALLOW_PAID=false (antes era possível contornar via target explícito).
  Alvos explícitos também respeitam a lista DZ23_ROTATION quando definida.
- Limites simultâneos globais e por provider:model agora aplicados por processo.
- IDs de projeto/missão inválidos são rejeitados, não silenciosamente normalizados.
- Arquivos/dirs de memória novos com permissões restritas quando suportadas.
- HTTP exige token em bind não local, valida Host/Origin, trata JSON inválido,
  retorna 202 em notificações e 405 no GET/DELETE MCP sem SSE.
- Erros de API não devolvem corpo bruto; secret files ilegíveis falham explicitamente.
- URLs de provider rejeitam credenciais embutidas/query/fragmento.
- Flags de capabilities agora descrevem a superfície textual realmente exposta.
- IDs de modelo não comprovados para novas integrações passam a configuração explícita.

### Compatibilidade / atualização
- Baseline passa para Node 22+. IDs anteriormente normalizados devem ser referidos
  pelo nome seguro já gravado em disco; faça backup antes de qualquer ajuste manual.
- Non-loopback HTTP precisa de token 32+ e hosts/origins explicitamente autorizados.
- Mixed/free-tier continuam dependentes do plano do fornecedor: o guard não é um
  teto financeiro. Exemplo padrão usa somente o endpoint local.
- Nenhuma migração, limpeza de estado ou alteração de outros projetos foi executada.

## 2.2.2 — base recebida

Carregamento do .env relativo à instalação e geração de snippets com caminhos reais.
A suíte de 14 testes da base foi reexecutada antes das mudanças desta preparação.
