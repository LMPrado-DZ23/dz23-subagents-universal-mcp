# Arquitetura e limites de responsabilidade

## Componentes

| Camada | Módulos | Responsabilidade |
| --- | --- | --- |
| Entrada | `index.js`, `cli.js`, `server.js`, `env.js`, `config.js` | `.env` da instalação, configuração validada, CLI e transportes |
| Transporte | `stdio.js`, `http.js`, `rpc.js` | JSON-RPC em linhas (stdio) ou POST JSON (HTTP), `request_id` |
| Protocolo | `mcp.js`, `tools.js`, `schema.js`, `errors.js` | Negociação, schemas, validação, escopos, resultados e erros |
| Segurança HTTP | `auth.js`, `ratelimit.js` | Token/arquivo, identidades e escopos, rate limit por processo |
| Orquestração | `core.js`, `routing.js`, `consensus.js`, `prompts.js`, `targets.js` | Delegação, retry/failover, estratégias, síntese |
| Providers | `providers.js`, `provider-errors.js`, `concurrency.js` | Adapters OpenAI-compatible e Anthropic Messages, taxonomia de erros, limites de chamadas |
| Custos | `budget.js`, `usage.js` | Admissão antes da chamada, liquidação depois, uso por missão/projeto/dia |
| Memória | `memory.js`, `memory-schema.js`, `journal.js`, `locks.js`, `fsutil.js`, `context.js`, `memory-repair.js` | Persistência versionada, locks, journal, contexto e reparo |
| Observabilidade | `logger.js`, `redact.js`, `metrics.js` | Logs JSONL redigidos e métricas de processo |

Não há dependências npm. Credenciais ficam no processo e nunca entram em inventário,
resultados, logs, memória ou erros.

## Fluxo de uma chamada

1. O transporte gera ou aceita `request_id`, decodifica JSON-RPC e aplica autenticação,
   Host/Origin/cross-site e rate limit (HTTP; falhas de autenticação limitadas por endereço).
2. `mcp.js` valida os argumentos com o schema publicado e confere escopos.
3. `core.js` resolve alvos elegíveis (`DZ23_ROTATION`, custo, cooldown) e planeja o roteamento.
4. Para cada tentativa: o orçamento admite ou nega; o limiter controla concorrência por
   `provider:model`; o adapter chama o provider com timeout e limite de resposta.
5. Falhas viram `ProviderError`. Só `rate_limited`, `provider_timeout` e `provider_unavailable`
   repetem no mesmo alvo, com backoff e `Retry-After` limitado. `invalid_request` encerra sem
   failover; `context_length_exceeded` faz failover sem cooldown; os demais tipos fazem failover e
   aplicam cooldown por tipo. Cancelamento do cliente e `DZ23_DELEGATE_DEADLINE_MS` abortam a chamada.
6. O uso é liquidado (tokens reportados ou estimados, custo por preço configurado ou reportado),
   a resposta é gravada na memória e um checkpoint registra `last_tool_handoff`, sem alterar
   `status`, `next_action` ou `goal`, que pertencem ao harness. Se a gravação falhar depois da
   resposta, `delegate` devolve a resposta com `memory_warnings`.

`swarm_run` distribui workers conforme a estratégia (padrão `first`, compatível com 2.2.5),
aguarda todos e chama um revisor integrador, que recebe as respostas desta execução no prompt (com
limite de tamanho). `consensus` usa alvos distintos. Nada disso
executa shell, patches, worktrees ou testes: os workers produzem texto e o harness decide.

## Persistência

```text
<DZ23_STATE_DIR>/
  projects/<project_id>/project.json
  projects/<project_id>/missions/<mission_id>/{state.json, journal.jsonl, usage.jsonl, checkpoints/NNNNNN.json}
  usage/daily/<YYYY-MM-DD>.json
  providers/status.json
```

- **Schema versionado**: projeto 2, missão 2, evento 2, checkpoint 2, uso 1, agente 1, lock 2.
  Migrações rodam na leitura, não removem campos e são persistidas na próxima escrita.
  Registros de versão futura são recusados sem reescrita.
- **Integridade**: JSON corrompido ou com formato inválido gera `memory_integrity` com caminho
  relativo; nunca é tratado como ausente.
- **Escrita**: arquivo temporário + fsync (desligável com `DZ23_MEMORY_FSYNC=false`) + rename,
  com retry para `EPERM/EACCES/EBUSY` do Windows.
- **Locks**: diretório `.lock` com `owner.json` (pid, hostname, timestamps, versão) e heartbeat.
  Leituras e escritas do mesmo processo são serializadas por projeto. Um lock só é removido
  automaticamente quando está velho e o dono comprovadamente não roda mais neste host, ou quando
  não tem metadados e passou do dobro do limite. Locks de outro host nunca são removidos.
- **Journal**: `seq` monotônico preservado na rotação; linha final incompleta é fechada e
  registrada como `journal_recovered`; linhas inválidas são preservadas e contadas.
- **Contexto**: montado em camadas por prioridade (projeto, objetivo, critérios, decisões,
  invariantes, tarefas, arquivos/testes, falhas, checkpoint, eventos, respostas), com teto por
  seção na primeira passagem e redistribuição da sobra; as seções truncadas são informadas no texto.

## Continuidade honesta

Um failover recebe o estado persistido e o evento de falha anterior. Não transporta pensamentos
ocultos, chamadas que o harness não registrou, arquivos locais ou tokens de respostas interrompidas.
Outro harness precisa conectar à mesma memória e chamar as ferramentas. O contexto é marcado como
dado não confiável e pode ser truncado; não há recuperação semântica ou vetorial.

## Limites de segurança e escala

- Uma instância é um domínio de confiança. Modo `scoped` restringe ferramentas por token, mas não
  isola projetos entre clientes: não há multitenancy.
- Rate limit, reservas de orçamento e métricas são **por processo**. Vários processos
  ou réplicas não compartilham contadores; o orçamento pode ser excedido pelas chamadas em voo de
  outros processos que usam o mesmo diretório. Cooldowns de provider são compartilhados pelo
  diretório de estado quando `DZ23_SHARED_COOLDOWNS=true` (padrão).
- A memória não é transacional entre arquivos: um crash entre `state.json`, journal e totais pode
  deixar atualização parcial (detectável por `memory repair`). Locks em sistemas de arquivos de rede
  não são garantidos. Não há criptografia em repouso, SQLite ou WAL.
- HTTP é JSON sem SSE, sessões retomáveis, OAuth ou notificações do servidor.
- stdio processa até `DZ23_STDIO_MAX_INFLIGHT` (8) mensagens ao mesmo tempo; acima disso elas esperam.
- Mapas em memória por alvo e séries de métricas são limitados, para que nomes de modelo
  arbitrários não façam a memória crescer sem limite.
- Não há cota de disco nem limite de missões por projeto: um token com `memory:write` pode criar muitas
  missões. Use cota no volume de estado e escopos restritos.
- Um provider local (`custom`, `lmstudio`, `vllm`) apontado para um endereço que não é loopback nem
  rede privada passa a `mixed` e fica bloqueado sem `DZ23_ALLOW_PAID` ou `DZ23_FREE_MODELS`. Um gateway
  em rede privada que repassa para nuvens pagas continua `local`: não use essa configuração para
  contornar a política de custo.

Não prometer: conformidade MCP completa, compatibilidade com todos os hosts, uso gratuito,
conclusão autônoma de projetos, operação 24/7 sem supervisão ou qualidade medida por benchmarks.
